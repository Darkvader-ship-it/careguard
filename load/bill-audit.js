/**
 * k6 load test — POST /bill/audit under ramping load (Issue #800)
 *
 * Bill audit work is CPU-bound on line-item count (services/bill-audit-api/server.ts's
 * auditBill() loops over every line item doing rate lookups and duplicate detection),
 * so this specifically ramps VUs against realistic multi-line-item bills rather than
 * reusing load/agent-run.js's single-request pattern.
 *
 * Usage:
 *   pnpm load:bill-audit
 *   # or directly:
 *   k6 run load/bill-audit.js
 *   BASE_URL=https://your-app.onrender.com k6 run load/bill-audit.js
 *
 * Requires: k6 installed (https://k6.io/docs/getting-started/installation/)
 *
 * IMPORTANT — x402 payment gate: POST /bill/audit is x402-payment-protected
 * (applyX402Middleware in server.ts). This script does not perform a real Stellar
 * payment, so it will get 402/500 responses against a server with a live
 * OZ_FACILITATOR_API_KEY configured, the same way an unauthenticated curl request
 * would. To load test the actual audit computation path, run the target server
 * against a facilitator/network configuration that accepts test payments (a sandbox
 * facilitator or a testnet-funded flow), matching the "mocked LLM" prerequisite
 * documented for load/agent-run.js in docs/load-testing.md — there is currently no
 * in-repo mock facilitator, so this is an environment setup step, not something this
 * script can do on its own.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// --- Metrics ---
const errors5xx = new Counter("errors_5xx");
const successRate = new Rate("success_rate");
const auditDuration = new Trend("bill_audit_duration_ms", true);
const auditFindingsTotal = new Counter("audit_findings_total");

// --- Config ---
export const options = {
  scenarios: {
    ramping_audits: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "30s", target: 10 },
        { duration: "1m", target: 30 },
        { duration: "30s", target: 0 },
      ],
      exec: "auditRealisticBill",
    },
    large_lineitems: {
      executor: "constant-vus",
      vus: 3,
      duration: "1m",
      exec: "auditLargeBill",
      startTime: "30s", // overlap with the ramp-up, not the cooldown
    },
  },
  thresholds: {
    errors_5xx: ["count==0"],
    bill_audit_duration_ms: ["p(95)<2000"],
    success_rate: ["rate>0.99"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3002";

// A representative 10-line-item bill (mirrors GET /bill/sample), including one
// intentional duplicate CPT code so audits always find at least one real issue.
const REALISTIC_BILL = {
  lineItems: [
    { description: "Hospital care, high complexity", cptCode: "99233", quantity: 3, chargedAmount: 630 },
    { description: "Comprehensive metabolic panel", cptCode: "80053", quantity: 1, chargedAmount: 95 },
    { description: "Complete blood count (CBC)", cptCode: "85025", quantity: 1, chargedAmount: 45 },
    { description: "Complete blood count (CBC)", cptCode: "85025", quantity: 1, chargedAmount: 45 },
    { description: "Venipuncture (blood draw)", cptCode: "36415", quantity: 1, chargedAmount: 10 },
    { description: "Chest X-ray, 2 views", cptCode: "71046", quantity: 1, chargedAmount: 180 },
    { description: "Electrocardiogram (ECG)", cptCode: "93000", quantity: 1, chargedAmount: 35 },
    { description: "Office visit, complex", cptCode: "99215", quantity: 1, chargedAmount: 1250 },
    { description: "Hospital discharge day", cptCode: "99238", quantity: 1, chargedAmount: 160 },
    { description: "Injection, subcutaneous", cptCode: "96372", quantity: 2, chargedAmount: 50 },
  ],
};

// A large bill near the server's BILL_AUDIT_MAX_ITEMS default (500) — used by the
// large_lineitems scenario to verify the endpoint either audits it within budget or
// returns the bounded 400 rejection, never a 5xx or an unbounded hang.
const CPT_POOL = ["99233", "80053", "85025", "36415", "71046", "93000", "99215", "99238", "96372", "71045"];
function buildLargeBill(count) {
  const lineItems = [];
  for (let i = 0; i < count; i++) {
    lineItems.push({
      description: `Line item ${i}`,
      cptCode: CPT_POOL[i % CPT_POOL.length],
      quantity: 1,
      chargedAmount: 50 + (i % 200),
    });
  }
  return { lineItems };
}
const LARGE_BILL = buildLargeBill(480); // under the 500 default cap
const OVERSIZED_BILL = buildLargeBill(600); // over the 500 default cap — expect a bounded 400

const params = {
  headers: { "Content-Type": "application/json" },
  timeout: "10s",
};

function recordResult(res, ok) {
  if (res.status >= 500) {
    errors5xx.add(1);
    console.error(`5xx response: ${res.status} — ${res.body.slice(0, 200)}`);
  }
  successRate.add(ok ? 1 : 0);
}

export function auditRealisticBill() {
  const start = Date.now();
  const res = http.post(`${BASE_URL}/bill/audit`, JSON.stringify(REALISTIC_BILL), params);
  auditDuration.add(Date.now() - start);

  const ok = check(res, {
    "status is not 5xx": (r) => r.status < 500,
    "status is 200 or 402 (payment gate)": (r) => r.status === 200 || r.status === 402,
    "200 response has errorCount": (r) => {
      if (r.status !== 200) return true; // payment-gated env — see script header
      try {
        return typeof JSON.parse(r.body).errorCount === "number";
      } catch {
        return false;
      }
    },
  });

  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      auditFindingsTotal.add(body.errorCount ?? 0);
    } catch {
      // ignore parse failure — already flagged by the check above
    }
  }

  recordResult(res, ok);
  sleep(0.2);
}

export function auditLargeBill() {
  const useOversized = Math.random() < 0.5;
  const payload = useOversized ? OVERSIZED_BILL : LARGE_BILL;

  const start = Date.now();
  const res = http.post(`${BASE_URL}/bill/audit`, JSON.stringify(payload), params);
  auditDuration.add(Date.now() - start);

  const ok = check(res, {
    "status is not 5xx": (r) => r.status < 500,
    "oversized bill gets bounded 400, large-but-valid gets 200/402": (r) => {
      if (useOversized) return r.status === 400;
      return r.status === 200 || r.status === 402;
    },
  });

  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      auditFindingsTotal.add(body.errorCount ?? 0);
    } catch {
      // ignore parse failure — already flagged by the check above
    }
  }

  recordResult(res, ok);
  sleep(0.2);
}

export function handleSummary(data) {
  return {
    stdout: `
=== CareGuard Bill Audit Load Test Summary ===
Iterations:          ${data.metrics.iterations?.values?.count ?? "?"}
Success rate:        ${((data.metrics.success_rate?.values?.rate ?? 0) * 100).toFixed(1)}%
5xx errors:           ${data.metrics.errors_5xx?.values?.count ?? 0}
p95 audit duration:   ${data.metrics.bill_audit_duration_ms?.values?.["p(95)"]?.toFixed(0) ?? "?"}ms
Total audit findings: ${data.metrics.audit_findings_total?.values?.count ?? 0}

Note: 402 responses indicate the x402 payment gate is active and blocking audit
computation from actually running — see the script header comment for how to point
this at a server configured to accept test payments.
`,
  };
}
