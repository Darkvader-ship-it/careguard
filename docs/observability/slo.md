# SLOs and Error Budgets

Quantitative targets for CareGuard's core user journeys, derived from the metrics in
[`shared/metrics.ts`](../../shared/metrics.ts) and cataloged in
[metrics-catalog.md](./metrics-catalog.md). These targets are the basis for alerting
thresholds and release-freeze decisions.

## SLIs and SLO targets

| SLI | Definition | Prometheus query | SLO target | Window |
|---|---|---|---|---|
| Agent run success rate | Fraction of agent runs that complete without error | `sum(rate(agent_runs_total{status="success"}[30d])) / sum(rate(agent_runs_total[30d]))` | ≥ 99% | 30d rolling |
| Stellar tx success rate | Fraction of submitted Stellar transactions that succeed | `sum(rate(stellar_tx_submitted_total{result="success"}[30d])) / sum(rate(stellar_tx_submitted_total[30d]))` | ≥ 99.5% | 30d rolling |
| Payment settlement success rate | Fraction of x402 settlements that complete without a tx-extraction failure | `sum(rate(x402_settlements_total[30d])) / (sum(rate(x402_settlements_total[30d])) + sum(rate(x402_tx_extraction_failed_total[30d])))` | ≥ 99.5% | 30d rolling |
| LLM error rate | Fraction of agent runs hitting an LLM API error | `sum(rate(agent_llm_error_total[30d])) / sum(rate(agent_runs_total[30d]))` | ≤ 1% | 30d rolling |
| Agent availability (queue not saturated) | Fraction of time the agent queue has capacity to accept work | derived from `agent_queue_depth` / `agent_waiting_jobs` staying below configured concurrency | ≥ 99.9% | 30d rolling |

## Error budgets

An SLO target implies an error budget — the allowed amount of "bad" events in the
window before the SLO is breached.

| SLI | SLO | Error budget (30d) |
|---|---|---|
| Agent run success rate | 99% | 1% of runs may fail — e.g. ~14.4 min/day equivalent budget if runs were evenly time-weighted |
| Stellar tx success rate | 99.5% | 0.5% of submitted transactions may fail |
| Payment settlement success rate | 99.5% | 0.5% of settlements may fail to extract a tx reference |
| LLM error rate | ≤ 1% error rate | Budget is consumed as errors accrue past 1% of total runs |

## Error-budget policy

- **Budget remaining > 25%**: normal operation. No process changes.
- **Budget remaining 10–25%**: the on-call engineer is notified (see the alert mapping
  below); new risky changes to the affected subsystem (agent runtime, payment/Stellar
  path) should get an extra review pass before merge.
- **Budget exhausted (0%) within the 30d window**: a release freeze applies to the
  affected subsystem — no non-critical changes land until either the window rolls
  forward enough to restore budget, or the root cause is fixed and burn rate returns
  to baseline. Critical/security fixes are exempt from the freeze.
- Budget burn is evaluated per-SLI, not globally — e.g. a Stellar tx success-rate
  budget burn only freezes changes to the Stellar submission path, not unrelated docs
  or dashboard work.

## SLO → alert mapping

| SLO | Alert | Query basis |
|---|---|---|
| Agent run success rate | `AgentRunFailureRateHigh` | `agent_runs_total{status!="success"}` rate vs. total |
| Stellar tx success rate | `StellarTxFailureRateHigh` | `stellar_tx_submitted_total{result!="success"}` rate vs. total |
| Payment settlement success rate | `X402SettlementFailureRateHigh` | `x402_tx_extraction_failed_total` rate vs. `x402_settlements_total` |
| LLM error rate | `AgentLlmErrorRateHigh` | `agent_llm_error_total` rate vs. `agent_runs_total` |
| Agent availability | `AgentQueueSaturated` | `agent_waiting_jobs` sustained above threshold |

Alert rule definitions live alongside the Prometheus config in `docker/prometheus/`;
this doc is the source of truth for the *targets* those rules should enforce.

Pre-aggregated series for these SLIs (success/error ratios at 5m/1h/6h/3d windows,
so dashboards and alerts don't recompute the raw counters on every query) are defined
in [`docker/prometheus/recording-rules.yml`](../../docker/prometheus/recording-rules.yml),
following the `careguard:<sli>:<kind>_rate<window>` naming convention.

## Retention

Error-budget history needs to persist at least as long as the longest SLO window above
(30 days). See [prometheus-retention.md](./prometheus-retention.md) for the current
retention configuration and how it aligns with this requirement.
