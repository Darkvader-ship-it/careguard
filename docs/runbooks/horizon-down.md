# Runbook: Stellar Horizon Outage or Congestion

**Symptom**
One or more of the following:
- `stellar_tx_submitted_total{result="error"}` counter is rising in Prometheus / Grafana
- Agent logs show repeated `[Stellar] TX confirmed` absences, `tx_too_late`, `tx_bad_seq`, or HTTP 503/504 from `horizon-testnet.stellar.org`
- `waitForStellarSettlement` returns `false` after exhausting all retries (5 × 1 s polls), leaving a payment in an ambiguous state
- Render health checks begin failing because `verifyWallet()` at startup calls `horizonServer.loadAccount()` and throws — causing the process to exit with code 1
- The `/ready` endpoint returns 503, removing the agent instance from the load balancer

---

**Impact**
- New bill-payment, medication-payment, or wallet-balance requests that require a Horizon call will fail
- In-flight transactions may be submitted but never confirmed, leaving spend-policy bookkeeping out of sync
- If Horizon is down at startup, the entire agent process exits and Render cannot restart it successfully, causing a full service outage
- Fee-bump retries (`submitTransactionWithFeeBump`) escalate cost without guarantee of settlement

---

**Diagnosis**

1. **Confirm Horizon reachability**

   ```bash
   curl -s https://horizon-testnet.stellar.org/ | jq .horizon_version
   # Expected: a version string.  Timeout or error = Horizon unreachable.
   ```

2. **Check Stellar status page and Discord**

   - https://status.stellar.org — look for "Stellar Testnet" incidents
   - `#testnet` in the Stellar Developer Discord for real-time reports of congestion or resets

3. **Read error counters** (Prometheus / `GET /metrics`)

   ```
   stellar_tx_submitted_total{result="error"}   # absolute count of failed submits
   stellar_tx_submitted_total{result="success"}  # compare ratio
   ```

4. **Read agent logs** for the specific failure class:

   | Log pattern | Meaning |
   |---|---|
   | `tx_too_late` | Transaction expired before inclusion — timebounds too short or Horizon slow |
   | `tx_bad_seq` | Sequence number conflict — concurrent submission or stale account cache |
   | `tx_insufficient_fee` | Network congestion; fee-bump budget exhausted |
   | `failed to load agent wallet` at startup | `loadAccount` timed out or returned 5xx |
   | `waitForStellarSettlement` returned false | Submitted but not confirmed within 5 s |

5. **Check current base fee / fee stats**

   ```bash
   curl -s https://horizon-testnet.stellar.org/fee_stats | jq '{p50:.fee_charged.p50, p90:.fee_charged.p90, p99:.fee_charged.p99}'
   ```

   If `p90` exceeds `MAX_FEE_STROOPS` (env var, default 10 000 stroops), fee bumps will be capped and transactions will be rejected.

---

**The "transaction may have settled despite timeout" ambiguity**

`waitForStellarSettlement` polls Horizon for the transaction hash up to 5 times over ~5 s. A `false` return means Horizon did not return the transaction within that window — **it does not mean the transaction failed**.

Scenarios where the transaction _did_ settle despite `false` being returned:
- Horizon was temporarily unavailable during the poll window but the transaction had already been included in a ledger
- Network partition between the agent and Horizon while the validators were healthy

**How to verify manually**

1. Find the `txHash` in the agent log line preceding the `waitForStellarSettlement` call (search for `[Stellar] TX confirmed` or `stellarTxHash`).
2. Look up the hash on stellar.expert:
   ```
   https://stellar.expert/explorer/testnet/tx/<txHash>
   ```
3. If the transaction appears on stellar.expert, it **settled on-chain** regardless of what the agent reported to the caregiver.

**Operational consequence**
- If the agent reported failure to the caregiver but the transaction settled, the spend-policy ledger is under-counted. Correct it by manually crediting the transaction in the admin UI or updating the Redis spend accumulator.
- Do **not** re-submit the same payment — this will result in a duplicate charge. Always verify on stellar.expert first.

---

**Mitigation**

### Testnet congestion / fee spikes

1. **Increase `MAX_FEE_STROOPS`** in the Render environment:
   ```
   MAX_FEE_STROOPS=50000   # bump from default 10000
   ```
   Redeploy. The fee-bump logic in `submitTransactionWithFeeBump` reads this at runtime.

2. **Increase `STELLAR_TIMEBOUNDS_SECONDS`** to give transactions more time to be included:
   ```
   STELLAR_TIMEBOUNDS_SECONDS=120   # up from default 60
   ```

3. **Monitor `stellar_tx_submitted_total{result="error"}` rate** — once the error rate drops below 1 %, revert to defaults.

### Horizon fully down at startup

The `verifyWallet()` boot check in `agent/server.ts` calls `horizonServer.loadAccount()` with no explicit timeout; a hung Horizon connection can stall startup indefinitely or cause an unhandled rejection.

**Short-term:** Restart the Render service after Horizon recovers. The startup check will pass and the service will come up healthy.

**If a degraded-mode start is acceptable:** The 10-second boot-time timeout (added in #233) wraps `verifyWallet()` and starts the server in degraded mode on timeout, so the `/ready` endpoint returns 503 (not 1) and Render keeps the instance alive. Confirm this timeout is still in place:
```bash
grep -n "degraded\|verifyWallet\|timeout" agent/server.ts
```

### Horizon unreachable mid-flight

There is no circuit breaker today. Once Horizon returns errors:
1. New payments will fail immediately with a logged error.
2. In-flight `waitForStellarSettlement` polls will time out and return `false`.
3. The agent continues to accept new sessions; only tool calls that touch Horizon fail.

The agent does **not** auto-pause on Horizon errors — it will keep accepting requests. If you want to pause all payments during an outage, use the admin pause flag:
```bash
# Set via Redis (or the admin endpoint if implemented)
redis-cli SET pause_flag "1"
```

---

**Remediation**

1. Wait for `https://status.stellar.org` to show all systems operational.
2. Verify fee stats return to normal (`p90 < 1000 stroops`).
3. Verify `stellar_tx_submitted_total{result="success"}` resumes incrementing.
4. Check for any payments that returned `false` from `waitForStellarSettlement` during the window — verify each on stellar.expert and correct the spend ledger if needed.
5. Revert any temporary env var changes (`MAX_FEE_STROOPS`, `STELLAR_TIMEBOUNDS_SECONDS`) once the network is stable.
6. If the Render health check was failing, confirm `/ready` returns `200 OK` after the redeploy.

---

**Post-mortem template**

```
- Date / duration:
- Root cause: (testnet congestion | Horizon planned maintenance | unexpected outage)
- Detection lag: (time from first error to on-call alert)
- Mitigation taken: (fee bump increase | timebounds increase | pause flag | waited)
- Transactions in ambiguous state (hash list):
- Each ambiguous tx verified on stellar.expert (settled / not settled):
- Spend ledger corrections made:
- Remediation:
- Action items:
```

---

## Related

- [`docs/stellar/tx-lifecycle.md`](../stellar/tx-lifecycle.md) — transaction lifecycle, timebound, and retry logic
- [`docs/runbooks/wallet-low.md`](wallet-low.md) — agent wallet funding
- [`docs/runbooks/webhook-secret-rotation.md`](webhook-secret-rotation.md) — webhook HMAC secret rotation
- [`docs/observability/metrics-catalog.md`](../observability/metrics-catalog.md) — full metrics catalog including `stellar_tx_submitted_total`
- `agent/tools.ts` — `submitTransactionWithRetry`, `submitTransactionWithFeeBump`, `waitForStellarSettlement`
- `agent/server.ts` — `verifyWallet()` startup probe
- `STELLAR_TIMEBOUNDS_SECONDS`, `MAX_FEE_STROOPS` env vars
