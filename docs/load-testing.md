# Load Testing

This document covers the load tests in `load/`:
- `load/agent-run.js` — concurrent `/agent/run` requests (Issue #55)
- `load/bill-audit.js` — ramping-VU load on `POST /bill/audit` (Issue #800)

## `load/agent-run.js`

This test covers concurrent `/agent/run` requests (Issue #55).

## Goal

Verify that 20 parallel `/agent/run` requests do not corrupt the shared in-memory spending state (`spendingTracker`, `lastMppTxHash`, etc.). Unit tests miss races; this test surfaces them.

## Prerequisites

1. [k6](https://k6.io/docs/getting-started/installation/) installed on your machine.
2. A running CareGuard server with a **mocked LLM** so requests complete quickly without real API calls.

### Starting a mock-LLM server

Point `LLM_BASE_URL` at a local OpenAI-compatible stub that returns an empty tool-call response immediately:

```bash
# Example using a simple echo server or a local Ollama instance
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=llama3 pnpm start
```

Or set `LLM_BASE_URL` to any OpenAI-compatible endpoint that responds quickly.

## Running the load test

```bash
# From the careguard/ root
pnpm load
```

This runs `k6 run load/agent-run.js` with 20 virtual users, each posting one `/agent/run` request concurrently.

To target a different server:

```bash
BASE_URL=https://your-app.onrender.com k6 run load/agent-run.js
```

## What it checks

| Check | Threshold |
|---|---|
| No 500 responses | `errors_500 == 0` |
| All requests succeed (200) | `success_rate == 1.0` |
| p95 response time | `< 30 s` |

After all runs complete, the script fetches `/agent/spending` and compares:

- **Expected** service fees = `20 runs × $0.002`
- **Actual** service fees from the tracker

A mismatch indicates a lost write or double-count from a race condition.

## Interpreting results

```
=== CareGuard Load Test Summary ===
Expected service fees (20 runs × $0.002): $0.04
Actual service fees in tracker: $0.04
✅ Spending totals match — no lost writes or double-counts

Iterations:   20
Success rate: 100.0%
500 errors:   0
p95 duration: 1234ms
```

If you see a mismatch, the module-level `spendingTracker` object has a race. The fix is to move state into a per-request context or use atomic file writes with a lock.

## `load/bill-audit.js`

Ramps virtual users against `POST /bill/audit` (`services/bill-audit-api/server.ts`),
since audit work is CPU-bound on line-item count — `auditBill()` loops over every
line item doing rate lookups and duplicate detection.

### Prerequisites

1. k6 installed.
2. **`POST /bill/audit` is x402-payment-protected.** This script does not perform a
   real Stellar payment, so against a server with a live `OZ_FACILITATOR_API_KEY` it
   will get 402/500 responses instead of exercising the audit computation — the same
   as an unauthenticated `curl` request would. There is currently no in-repo mock
   facilitator (unlike `agent-run.js`'s mocked-LLM prerequisite, which is a config
   flag away), so to load test the actual audit path you need a facilitator/network
   setup that accepts test payments. The script still enforces its thresholds either
   way (no 5xx, latency budget) — a 402 is treated as an expected "payment gate is on"
   response, not a failure.

### Running

```bash
pnpm load:bill-audit
# or:
k6 run load/bill-audit.js
BASE_URL=https://your-app.onrender.com k6 run load/bill-audit.js
```

### What it checks

| Scenario | What it does | Thresholds |
|---|---|---|
| `ramping_audits` | Ramps 1→10→30→0 VUs over 2 minutes, each posting a realistic 10-line-item bill (mirrors `GET /bill/sample`, including one intentional duplicate CPT code) | `errors_5xx == 0`, `bill_audit_duration_ms` p95 `< 2000ms`, `success_rate > 0.99` |
| `large_lineitems` | 3 constant VUs for 1 minute alternating between a 480-item bill (under the `BILL_AUDIT_MAX_ITEMS=500` default) and a 600-item bill (over it) | Large-but-valid bills get 200/402 (never 5xx or a timeout); oversized bills get a bounded 400 |

A custom `audit_findings_total` counter sums `errorCount` from every `200` response,
to confirm audit work was actually performed under load rather than short-circuiting.

## CI (both scripts)

Neither load test is included in the default CI pipeline — both are slow and require
a running server. Run them manually before releases or when changing
`agent/tools.ts` state management or `services/bill-audit-api/server.ts`'s audit logic.
