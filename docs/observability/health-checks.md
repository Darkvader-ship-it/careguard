# Health-Check and Readiness Response Schema

CareGuard's unified server (`server.ts`) exposes two probe endpoints with different
purposes. This doc defines their response shapes, what "degraded" means, and which
infra consumes each one.

## Liveness — `GET /health`

Answers "is the process up and able to handle HTTP at all?" No I/O, no dependency
checks — always fast.

```json
{ "status": "ok" }
```

- **Status codes:** always `200` as long as the process can respond at all. If the
  event loop is fully blocked or the process is dead, the request itself times out —
  there is no "unhealthy" body, because a live process always reports `ok`.
- **Use for:** container/process restarts (crash-loop detection). Do not use this to
  gate traffic — a live-but-degraded instance still returns `200` here.

## Readiness — `GET /ready`

Answers "can this instance actually serve requests right now?" Checks dependencies
and can legitimately return a non-200 while the process itself is healthy.

```json
{
  "status": "ok" | "degraded",
  "checks": {
    "env": true | "missing: LLM_API_KEY, ...",
    "horizon": true | false,
    "ozFacilitator": true | "not yet verified"
  }
}
```

- **Status codes:**
  - `200` — all checks passed (`status: "ok"`).
  - `503` — draining (server is mid-shutdown, `isDraining` flag set) or any check
    failed (`status: "degraded"`).
- **Degraded representation:** `status` flips to `"degraded"` and the `checks` object
  shows exactly which dependency failed. A check value is either `true` (passed) or a
  falsy/string value describing why it failed — e.g. `"missing: LLM_API_KEY"` for env,
  `false` for a failed Horizon ping.

### Dependency checks

| Check | What it verifies | Failure mode |
|---|---|---|
| `env` | Required secrets (`LLM_API_KEY`, `AGENT_SECRET_KEY`, `MPP_SECRET_KEY`, `CAREGIVER_TOKEN`) are present in `process.env` | Missing env in a fresh deploy — surfaces immediately instead of failing on first real request |
| `horizon` | A 1.5s-timeout `fetch` to `https://horizon-testnet.stellar.org` succeeds (2xx or any non-5xx) | Stellar testnet Horizon is unreachable or overloaded |
| `ozFacilitator` | The x402 middleware has successfully verified a payment against the OZ facilitator at least once, *or* `OZ_FACILITATOR_API_KEY` isn't configured (in which case this check is trivially `true`) | Facilitator unreachable — this check can stay `"not yet verified"` indefinitely on an instance that has never processed a paid request, which does not by itself mean the facilitator is down |

**Important caveat:** the Horizon check is hardcoded to
`https://horizon-testnet.stellar.org` regardless of the configured `NETWORK`. On any
deployment actually meant to run against mainnet, this check verifies the wrong
network's availability — a testnet outage would mark a mainnet-serving instance
"degraded" for the wrong reason, and a testnet-only outage on the *real* dependency
wouldn't be caught if the app were pointed elsewhere. This is a known gap, not
something this doc's existence fixes.

## Probe → consumer mapping

Per the [README health-check table](../../README.md):

| Consumer | Probe used | Notes |
|---|---|---|
| Docker Compose (`server` service healthcheck) | `GET /` (`docker-compose.yml`, checks `statusCode === 200`) | Checks the root info endpoint responds — not `/health` or `/ready` specifically |
| Render health check | `GET /health` (`render.yaml`: `healthCheckPath: /health`) | Liveness only — Render restarts the instance on repeated failures, but this does **not** check Horizon/env/facilitator, so a "healthy" Render instance can still be dependency-degraded |
| Manual/operator checks | `GET /ready` | The right endpoint to check *before* routing traffic to a newly deployed instance — neither `GET /` nor `GET /health` checks dependencies |

If you're wiring up a new consumer (a load balancer, an orchestrator) that needs to
gate traffic on real readiness rather than "process is up," point it at `/ready`, not
`/` or `/health`.

## Related

- [Correlation IDs](./correlation-ids.md) — `requestId`/`agentRunId` are not present on
  health/readiness responses; they're unauthenticated, high-frequency probe endpoints
  and intentionally excluded from the request-context/logging pipeline that the rest
  of the API uses.
- [Render deployment](../deployment/render.md) — build/runtime pipeline these probes run against.
