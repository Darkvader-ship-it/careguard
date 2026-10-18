# Sentry Setup and Escalation

How Sentry is wired into CareGuard's Express servers via
[`shared/sentry.ts`](../../shared/sentry.ts), how to enable it, what gets
redacted before an event is sent, and what happens after an error fires.

## Enabling Sentry

Sentry is **disabled by default** — `initSentry({ service })` returns a no-op
handle (`enabled: false`, request/error handlers are pass-through middleware,
`captureException` does nothing) unless `SENTRY_DSN` is set.

| Env var | Purpose |
|---|---|
| `SENTRY_DSN` | Required to enable Sentry at all. Unset (or empty) → no-op. |
| `SENTRY_ENABLE_DEV` | In `NODE_ENV=development`, Sentry stays disabled even with a DSN set unless this is `"1"`. Prevents local dev noise from reaching your Sentry project by accident. |
| `SENTRY_ENVIRONMENT` | Overrides the reported environment tag; falls back to `NODE_ENV`, then `"development"`. |
| `SENTRY_RELEASE` | Optional release tag for the init call. |
| `SENTRY_TRACES_SAMPLE_RATE` | Parsed as a float, defaults to `0` (tracing off) if unset. |

Each server calls `initSentry({ service: "<name>" })` once at startup and
mounts the returned handlers:

```ts
const sentry = await initSentry({ service: "careguard-server" });
app.use(sentry.requestHandler());
// ...routes...
app.use(sentry.errorHandler());
```

### `@sentry/node` is an optional dependency

`initSentry` dynamically `import()`s `@sentry/node` rather than importing it
statically. If `SENTRY_DSN` is set but the package isn't installed, the
`import()` throws, `shared/sentry.ts` catches it, logs

```
Sentry: SENTRY_DSN set but @sentry/node not installed — skipping
```

via the shared logger, and returns the same no-op handle as if Sentry were
disabled. **The server does not crash or fail to boot** — Sentry is treated as
a genuinely optional dependency at runtime, not just at install time. If you
expect errors to be reaching Sentry and they aren't, check for this warning
in the logs first.

### Handler compatibility

`@sentry/node`'s Express integration shape has changed across major versions.
`initSentry` checks for `Sentry.Handlers.requestHandler`/`errorHandler` and
falls back to a no-op request handler and a manual `captureException` + `next(err)`
error handler if those aren't present. The error handler (when using
`Sentry.Handlers.errorHandler`) is configured to only report 5xx-status
errors (`shouldHandleError`) — 4xx client errors don't get sent to Sentry.

## Redaction (`beforeSend`)

Every event passes through a `beforeSend` hook before Sentry would transmit
it. The hook calls [`redact()`](../../shared/redact.ts) on `event.request`,
`event.extra`, `event.contexts`, `event.user`, each breadcrumb's `data`/`message`,
and `event.message`. `redact()`:

- Replaces known secret field names (`AGENT_SECRET_KEY`, `MPP_SECRET_KEY`,
  `LLM_API_KEY`, `OZ_FACILITATOR_API_KEY`, per-pharmacy secret keys,
  `authorization`/`cookie` headers in any casing, etc.) with `[REDACTED]`
  regardless of nesting.
- Is conservative by design — see the header comment in `redact.ts`: "when in
  doubt, redact."

**If redaction itself throws**, `beforeSend` catches it and returns `null`,
which drops the event entirely rather than risk sending an unredacted payload.
This means a bug in the redaction logic fails closed (event lost) rather than
open (secret leaked) — an intentional trade-off contributors should preserve
if they touch `beforeSend` or `redact.ts`.

Contributors adding a new field that might carry a secret or PII should add
it to `SECRET_FIELD_NAMES` (or the equivalent pattern check) in `redact.ts`,
not rely on Sentry's own generic scrubbing.

## Escalation path

CareGuard does not currently have a paging tool (PagerDuty/Opsgenie)
integrated — Sentry alerting today is email/Sentry-UI-based, and on-call
response is informal. Until that changes, use this as the working escalation
policy:

| Severity | What fires it | Response |
|---|---|---|
| **Error (5xx)** | Sentry's error handler only reports errors where `status >= 500` (see "Handler compatibility" above) — every Sentry event from the Express integration is, by construction, a server-side failure, not a client mistake. | Check the linked [runbook](../runbooks/README.md) for the failing subsystem first (e.g. [oz-facilitator-outage.md](../runbooks/oz-facilitator-outage.md), [wallet-low.md](../runbooks/wallet-low.md)). If none matches, triage as a new incident. |
| **Budget-relevant burn** | A sustained rise in Sentry error volume for a subsystem covered by an SLO in [slo.md](./slo.md) (agent runs, Stellar tx submission, x402 settlements) is a leading indicator of error-budget burn — cross-reference with the [recording rules](./slo.md#slo--alert-mapping) rather than treating Sentry volume alone as the trigger. | Follow the error-budget policy in `slo.md`: budget <25% remaining → extra review on changes to the affected subsystem; budget exhausted → release freeze on that subsystem. |
| **Ambiguous / cross-cutting** | Anything not covered by an existing runbook or SLO. | Escalate to the project lead, per the pattern already used in [oz-facilitator-outage.md](../runbooks/oz-facilitator-outage.md) for undecided fail-open/fail-closed calls. |

This doc is the place to update once a real paging integration exists —
until then, treat "check Sentry, check the runbook index, escalate to the
lead if neither applies" as the on-call expectation.

## Related

- [Runbooks index](../runbooks/README.md) — symptom-specific mitigation steps
- [SLOs and error budgets](./slo.md) — how sustained errors translate into a release-freeze decision
- [Correlation IDs](./correlation-ids.md) — `requestId`/`agentRunId` aren't currently attached to Sentry events (only to log lines); cross-referencing a Sentry error with logs today means matching on timestamp, not a shared id
