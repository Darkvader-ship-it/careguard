# Agent Cost Estimation Guide

This guide breaks down the cost structure for running CareGuard's autonomous agent and provides worksheets to estimate spending for your workload.

## Per-Operation Cost Table

All x402 queries are paid on-chain to the Stellar OZ Facilitator. MPP Charge and Stellar transfers are medication and bill payments (not API costs).

| Operation | Provider | Payment Method | Unit Cost | Notes |
|-----------|----------|-----------------|-----------|-------|
| Medication price query | x402 Pharmacy API | Stellar x402 auth entry | $0.002 | Per drug per pharmacy (5 pharmacies queried per medication) |
| Drug interaction check | x402 Drug Interaction API | Stellar x402 auth entry | $0.001 | Per medication pair or full interaction check |
| Medical bill audit | x402 Bill Audit API | Stellar x402 auth entry | $0.01 | Per bill document (includes CPT code analysis) |
| LLM token usage | OpenAI / Groq / OpenRouter | Per token | Variable | See LLM Provider Pricing below |
| Medication order | MPP Charge | Stellar USDC transfer | Per-order | Pharmacy-defined price (not agent cost) |
| Medical bill payment | Direct Stellar transfer | Stellar USDC transfer | Amount due | Direct payment to provider (not agent cost) |

### Cost Per Query Example

**Scenario:** Agent queries pharmacy API to check prices for 1 medication across 5 pharmacies.

```
1 query call → 5 pharmacy endpoints queried → 5 x402 charges
Cost: 5 × $0.002 = $0.01
```

**Scenario:** Agent checks drug interactions for a patient on 4 medications.

```
Full interaction matrix: 4 medications → 1 check call
Cost: 1 × $0.001 = $0.001
```

## Worked Example: Maria and Rosa (From README)

This example reconciles the figures shown in README.md Verified Results.

### Task Description

Maria needs to find the cheapest medications for her mother Rosa, who takes 4 medications from 3 different pharmacies. One hospital bill arrives with potential errors.

### Cost Breakdown

**Phase 1: Price Comparison (Agent Tool: x402 pharmacy client)**
- Query 5 pharmacies for each of 4 medications: 4 × $0.002 = $0.008
- Query 5 more time when identifying cheaper options: $0.01 (5 × $0.002)
- **Subtotal: $0.018**

**Phase 2: Drug Interaction Check (Agent Tool: x402 drug interaction client)**
- Check interactions before ordering (1 check for 4 medications): 1 × $0.001 = $0.001
- **Subtotal: $0.001**

**Phase 3: Medical Bill Audit (Agent Tool: x402 bill audit client)**
- Audit the hospital bill for errors (CPT code analysis, duplicate detection): 1 × $0.01 = $0.01
- **Subtotal: $0.01**

**Phase 4: Medication Ordering (Agent Tool: MPP Charge client)**
- Order 4 medications from cheapest pharmacy: MPP order charge (not x402 cost)
- Actual cost determined by pharmacy pricing (separate from agent API costs)
- **Not included in $0.03 API cost**

**Phase 5: Bill Payment (Agent Tool: Stellar USDC transfer)**
- Transfer corrected bill amount to hospital
- Direct USDC payment (not x402 cost, not included in $0.03 API cost)

### Total Agent API Cost

x402 queries only: $0.018 + $0.001 + $0.01 = **$0.029**

Actual measured cost in end-to-end test: **$0.030** (accounts for rounding and authorization overhead in x402 protocol)

### Results Achieved

- Medication savings found: $69.76/month
- Billing errors caught: $1,195
- Total USDC agent wallet spent: $7.53 (includes medication + bill payments + API fees)

## LLM Token Usage and Provider Pricing

The agent uses OpenAI-compatible LLM endpoints (Groq, OpenRouter, OpenAI). Token costs are tracked per run and per model.

### Token Cost by Provider

| Provider | Model | Input $/1K tokens | Output $/1K tokens | Notes |
|----------|-------|-------------------|-------------------|-------|
| **Groq** | Mixtral 8x7B | Free on beta | Free on beta | Current fast provider for hackathon |
| **OpenAI** | GPT-4o mini | $0.15 | $0.60 | Default if Groq not available |
| **OpenAI** | GPT-4 | $3 | $6 | For complex reasoning |
| **OpenRouter** | Various | Varies | Varies | Aggregates multiple providers |

### Token Usage Per Task

A complete task (price + interaction + audit + decision) costs approximately:

- Input tokens: 2,000-3,000 (context, tools, prior results)
- Output tokens: 500-1,000 (reasoning, decision, tool calls)
- Tool-use overhead: 1,000-2,000 (structured call-response cycles)

**Example with Groq (beta free):** $0 in LLM costs
**Example with OpenAI GPT-4o mini:** ~$0.002-$0.004 per full task

Total LLM cost is typically lower than x402 query costs, but scales with model complexity.

### How to Track LLM Costs

In CareGuard, LLM calls are logged with token counts in `SPENDING_LOG`:

```
{
  "timestamp": "2025-07-26T15:30:00Z",
  "task": "audit-bill",
  "tool": "bill-audit-api",
  "x402_cost": 0.01,
  "llm_provider": "groq",
  "llm_model": "mixtral-8x7b",
  "llm_input_tokens": 2500,
  "llm_output_tokens": 800,
  "llm_cost": 0,
  "total_cost": 0.01
}
```

## Monthly Cost Estimation Formula

Use this worksheet to estimate agent API costs for your monthly workload.

### Inputs (Your Workload)

Define your usage:

| Item | Estimated Count | Notes |
|------|-----------------|-------|
| Medications per patient | N_med | Number of unique drugs being managed |
| Patients | N_pat | Number of patients agent manages |
| Price comparisons per month | N_price_queries | Frequency: every refill, weekly, on-demand? |
| Interaction checks per month | N_interactions | Typically 1 per patient per month |
| Bill audits per month | N_audits | Typical: 1-4 per patient per year |
| LLM model | model | groq (free), gpt-4o-mini ($0.0015/task), gpt-4 (expensive) |

### Calculation

```
Monthly Agent API Cost = (N_price_queries × N_med × $0.002)
                       + (N_interactions × N_pat × $0.001)
                       + (N_audits × $0.01)
                       + (Total_Tasks × LLM_cost_per_task)

Example:
- 2 patients, 4 medications each, 2 price checks per month per medication
- 1 interaction check per patient per month
- 2 bill audits per month
- Using Groq (free)

N_price_queries = 2 patients × 4 medications × 2 checks = 16 queries
N_interactions = 2 patients × 1 check = 2 checks
N_audits = 2 audits
LLM_cost = $0

Cost = (16 × $0.002) + (2 × $0.001) + (2 × $0.01) + $0
     = $0.032 + $0.002 + $0.02 + $0
     = $0.054 per month
     = $0.65 per year (API costs only, excluding USDC medication/bill payments)
```

### Worksheet Template

```
My Monthly Workload Estimate
----------------------------
Patients: ____
Medications per patient (average): ____
Price queries planned (total monthly): ____
Interaction checks planned (total monthly): ____
Bill audits planned (total monthly): ____
LLM model choice: [ ] Groq (free) [ ] GPT-4o mini ($0.0015/task) [ ] GPT-4 ($expensive)

Calculation
-----------
Price queries × $0.002 = $____
Interaction checks × $0.001 = $____
Bill audits × $0.01 = $____
LLM costs (per task) = $____

TOTAL AGENT API COST = $____ per month
```

## Monitoring Costs In Production

CareGuard logs all spending to `data/spending-log.json`:

```bash
# View today's costs
jq '.[] | select(.timestamp | startswith("2025-07-26"))' data/spending-log.json

# View costs by tool
jq 'group_by(.tool) | map({tool: .[0].tool, total: (map(.x402_cost + .llm_cost) | add)})' data/spending-log.json

# View total monthly
jq 'map(.x402_cost + .llm_cost) | add' data/spending-log.json
```

## Reconciliation with README Verified Results

| Metric in README | Detailed Breakdown | Reconciliation |
|------------------|-------------------|---|
| Agent x402 API cost: $0.030 | 10 price queries ($0.02) + 1 interaction ($0.001) + 1 audit ($0.01) | $0.031, rounded to $0.03 |
| Agent wallet USDC spent: $7.53 | API fees ($0.03) + medication costs ($~$5) + bill payment ($~$2.50) | Includes actual pharmacy + hospital payments, not just API |
| Cost per medication saved ($69.76/month) | Each medication averaged $17.44/month savings. LLM cost was $0.0004, query cost was $0.004 | API cost per medication: $0.004 < savings: $17.44 (4,360x ROI) |

---

## Cost Control Best Practices

1. **Cache results.** If Rosa's medications don't change, reuse price queries from last month instead of re-querying.
2. **Batch operations.** Query 10 medications at once instead of 1 per day.
3. **Pick the right LLM.** Use Groq (free on beta) for routine tasks, GPT-4 only for edge cases.
4. **Set spending limits.** CareGuard's policy engine enforces daily/monthly caps in `SPENDING_POLICY`.
5. **Monitor drift.** Compare `data/spending-log.json` monthly to your estimate.

---

## See Also

- [Versioning Guidelines](release/versioning.md)
- [Deprecation Policy](release/deprecation-policy.md)
- [SPENDING_POLICY enforcement](../SPENDING-POLICY.md)
- [Verified Results](../README.md#verified-results)
