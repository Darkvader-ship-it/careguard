# Correlation and Trace-ID Guide

How `requestId` and `agentRunId` are generated, propagated, and used to trace a single
agent run end-to-end across logs.

## The two IDs

| ID | Generated where | Lifetime | Purpose |
|---|---|---|---|
| `requestId` | [`shared/request-context.ts`](../../shared/request-context.ts)'s `requestContextMiddleware()` — one per inbound HTTP request | One HTTP request/response cycle | Correlates every log line produced while handling a single request |
| `agentRunId` | [`agent/runner.ts`](../../agent/runner.ts) (`runId = \`run-${getRequestId() ?? Date.now()}\``), set via `setAgentRunId()` | One agent run (may span multiple tool calls, LLM round-trips, and outbound payment calls) | Correlates every log line produced by one agent invocation, even though it started from a `requestId`-scoped request |

`agentRunId` derives from `requestId` when available (falling back to `Date.now()` only
if no request context exists, e.g. a script invoking the agent directly outside HTTP).
So a given agent run's `agentRunId` looks like `run-<requestId>`, making it easy to
recover the originating request from the run id alone.

## Propagation: AsyncLocalStorage → pino

1. `requestContextMiddleware()` (mounted early in both `server.ts` and `agent/server.ts`)
   reads an inbound `X-Request-ID` header if present, otherwise generates a UUID via
   `randomUUID()`. It calls `als.run({ requestId: id }, () => next())`, so every
   synchronous and awaited-async call made for the rest of that request's lifetime
   runs inside this `AsyncLocalStorage` context.
2. It also echoes the id back as an `X-Request-ID` response header — the client always
   knows the id used, even if it didn't send one.
3. `runAgent()` in `agent/runner.ts` calls `setAgentRunId(runId)`, which writes into
   the *same* ALS context (`getAgentRunId`/`setAgentRunId` both read/write the current
   store) — it does not open a new context, so `requestId` stays available alongside
   `agentRunId` for the rest of the run.
4. `shared/logger.ts`'s pino instance uses a `mixin()` callback that calls
   `getRequestId()`/`getAgentRunId()` on **every** log call and merges whatever is
   currently in the ALS context into that line's fields. This is why you don't see
   either id threaded explicitly through most logger calls in the codebase — it's
   injected automatically as long as the call happens inside the ALS run scope.
5. `shared/request-logger.ts` logs one structured summary line per HTTP request on
   `res.on("finish")`, which (via the same mixin) also carries `requestId` /
   `agentRunId`.

## Where the chain currently breaks

- **Outbound HTTP calls made by agent tools are not correlated.** `agent/tools.ts`
  makes plain `fetch()` calls (e.g. line ~1260 for pharmacy pricing, and the MPP
  client's `.fetch()` around line ~1667 for medication payments) without attaching
  `X-Request-ID` or any run-id header. If you're debugging a specific agent run against
  a downstream service's own logs (the pharmacy-payment service, an x402 facilitator),
  there is currently no shared id to `grep` for on both sides — you have to correlate
  by timestamp instead.
- **Any code path that escapes the ALS run scope loses both ids silently.** Anything
  that runs outside the request's async chain — a truly detached background job, a
  callback registered before `als.run()` started but invoked after, a separate
  process — will not have `requestId`/`agentRunId` in the ALS store, and the mixin
  simply omits those fields rather than erroring. Logs from those paths are still
  valid, just uncorrelated.
- **`/health` and `/ready`** (see [health-checks.md](./health-checks.md)) are
  intentionally lightweight probe endpoints; nothing about their handling is unusual
  here, but don't expect to find `requestId` on their own request-logger line's fields
  to mean anything beyond "this specific probe call."

## Tracing one agent run end-to-end

1. Get the `agentRunId` from wherever you first observe the run — the agent's HTTP
   response (if the endpoint returns it), or the `X-Request-ID` response header from
   the originating request combined with the `run-<requestId>` format.
2. Search logs for that `agentRunId` value. Every line from `runAgent()`'s tool-call
   loop, LLM calls, and spending/policy checks carries it via the pino mixin.
3. To see the full HTTP request that triggered the run (headers, status, duration),
   search for the same value as `requestId` instead — the `run-` prefix strips off,
   so `agentRunId = "run-abc123"` corresponds to `requestId = "abc123"`.
4. For payment/Stellar calls made during the run, cross-reference by timestamp against
   the `agentRunId`-tagged lines immediately preceding them — see "where the chain
   currently breaks" above for why this is timestamp-based rather than id-based today.

## Headers to propagate

- **Inbound:** if a caller already has a `requestId` for a logical operation (e.g. a
  retry, or a request forwarded from another CareGuard service), send it as
  `X-Request-ID` — `requestContextMiddleware()` will use it instead of generating a
  new one, letting you correlate across service boundaries.
- **Outbound (gap):** CareGuard's own outbound calls (pharmacy pricing lookups, MPP
  payment requests) do not currently send `X-Request-ID` downstream. Closing this gap
  would mean threading `getRequestId()` into the `fetch()`/`mppClient.fetch()` calls in
  `agent/tools.ts` as an `X-Request-ID` header — tracked as a follow-up, not done here.

## Related

- [Logging schema](./logging-schema.md) — full log line shapes and examples, including
  `requestId`/`agentRunId` fields in context
- [Health checks](./health-checks.md) — the probe endpoints that intentionally sit
  outside most of this correlation model
