/**
 * Integration test: payForMedication end-to-end through createMppClient
 * (Issue #794).
 *
 * Wires the real agent/mpp-client.ts createMppClient() factory (not a stub)
 * through agent/tools.ts's payForMedication, with only the innermost SDK
 * boundary mocked (mppx/client's Mppx.create and @stellar/mpp/charge/client's
 * stellar()) — the same boundary agent/__tests__/pay-for-medication.test.ts
 * already mocks at. This captures the real onProgress callback that
 * createMppClient wires up, so firing a 'paid' event exercises createMppClient's
 * actual lastTxHash getter, not a re-implementation of it.
 *
 * Two of the issue's acceptance criteria describe behavior that doesn't match
 * the current, deliberately-evolved implementation, so these tests verify
 * the real (and correct) behavior instead of a false premise — see the two
 * "documents actual behavior" tests below for why, with references to the
 * comments in agent/tools.ts explaining each design choice.
 */

const { mockMppFetch, onProgressHolder, MOCK_HINT } = vi.hoisted(() => {
  process.env.AGENT_SECRET_KEY = "SBWWZYCAFDDJXNRRMKSFNRB6OTVZHTCMPUCVZ4FBZLSPHFKHYLPRTJCD";
  process.env.BILL_PROVIDER_PUBLIC_KEY = "GBILLPROVIDER";
  const onProgressHolder: { fn?: (event: any) => void } = {};
  return { mockMppFetch: vi.fn(), onProgressHolder, MOCK_HINT: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) };
});

vi.mock("dotenv/config", () => ({}));
vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue("{}"),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));
vi.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    fromSecret: vi.fn().mockReturnValue({ publicKey: () => "GPUB123", sign: vi.fn(), signatureHint: () => MOCK_HINT }),
    random: vi.fn().mockImplementation(() => ({ publicKey: () => `GPUB-${Math.random()}`, sign: vi.fn(), signatureHint: () => MOCK_HINT })),
  },
  Networks: { TESTNET: "Test SDF Network ; September 2015" },
  TransactionBuilder: vi.fn().mockReturnValue({
    addOperation: vi.fn().mockReturnThis(),
    setTimeout: vi.fn().mockReturnThis(),
    build: vi.fn().mockReturnValue({ sign: vi.fn(), signatures: [{ hint: () => MOCK_HINT }] }),
  }),
  Operation: { payment: vi.fn() },
  Asset: vi.fn(),
  Horizon: { Server: vi.fn().mockReturnValue({ loadAccount: vi.fn(), submitTransaction: vi.fn() }) },
}));
vi.mock("@x402/stellar", () => ({
  createEd25519Signer: vi.fn().mockReturnValue({}),
  ExactStellarScheme: vi.fn(),
}));
vi.mock("@x402/fetch", () => ({
  wrapFetchWithPayment: vi.fn().mockReturnValue(vi.fn()),
  x402Client: vi.fn().mockReturnValue({ register: vi.fn().mockReturnThis() }),
  decodePaymentResponseHeader: vi.fn(),
}));
// This is the real SDK boundary — capture the onProgress callback that
// createMppClient (agent/mpp-client.ts) wires up for real, so tests can fire
// it and exercise createMppClient's actual lastTxHash logic.
vi.mock("@stellar/mpp/charge/client", () => ({
  stellar: vi.fn().mockImplementation((opts: any) => {
    if (opts?.onProgress) onProgressHolder.fn = opts.onProgress;
    return {};
  }),
}));
vi.mock("mppx/client", () => ({
  Mppx: { create: vi.fn().mockReturnValue({ fetch: mockMppFetch }) },
}));

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createMppClient } from "../mpp-client.ts";
import {
  payForMedication,
  setMppClient,
  getMppClient,
  getSpendingTracker,
  resetSpendingTracker,
  setSpendingPolicy,
} from "../tools.ts";

const DEFAULT_POLICY = {
  dailyLimit: 100,
  monthlyLimit: 800,
  medicationMonthlyBudget: 300,
  billMonthlyBudget: 500,
  approvalThreshold: 75,
};

function makeReceiptHeader(hash: string) {
  return Buffer.from(JSON.stringify({ reference: hash })).toString("base64");
}

beforeEach(() => {
  // tests/setup.ts globally sets MOCK_NETWORK=1, which makes
  // executeMedicationPayment take a short-circuit mock-receipt path that
  // never calls mppClient.fetch at all — unset it so the real fetch/receipt
  // extraction code path under test actually runs.
  delete process.env.MOCK_NETWORK;
  mockMppFetch.mockReset();
  onProgressHolder.fn = undefined;
  resetSpendingTracker("rosa");
  setSpendingPolicy("rosa", { ...DEFAULT_POLICY });
});

afterEach(() => {
  process.env.MOCK_NETWORK = "1";
});

describe("createMppClient wiring through payForMedication (Issue #794)", () => {
  it("each test drives its own real createMppClient instance with isolated lastTxHash state", () => {
    const clientA = createMppClient({ keypair: Keypair.random() });
    setMppClient(clientA);
    expect(getMppClient().lastTxHash).toBeUndefined();

    onProgressHolder.fn?.({ type: "paid", hash: "a".repeat(64) });
    expect(getMppClient().lastTxHash).toBe("a".repeat(64));

    // A second, independently-created client must not see the first's state.
    const clientB = createMppClient({ keypair: Keypair.random() });
    setMppClient(clientB);
    expect(getMppClient().lastTxHash).toBeUndefined();
  });

  it("payForMedication's stellarTxHash comes from the Payment-Receipt header, never from mppOrderId", async () => {
    const client = createMppClient({ keypair: Keypair.random() });
    setMppClient(client);

    const hash = "b".repeat(64);
    mockMppFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true, order: { id: "order-xyz-999" } }), {
        status: 200,
        headers: { "Payment-Receipt": makeReceiptHeader(hash) },
      }),
    );

    const result = await payForMedication("pharmacy-1", "Test Pharmacy", "Amoxicillin", 10);

    expect(result.success).toBe(true);
    expect((result as any).transaction.stellarTxHash).toBe(hash);
    expect((result as any).transaction.mppOrderId).toBe("order-xyz-999");
    // The order id must never leak into the tx-hash field.
    expect((result as any).transaction.stellarTxHash).not.toBe("order-xyz-999");
  });

  it("documents actual behavior: with no extractable hash, stellarTxHash stays undefined and the order id is used only for adherence tracking, not as a fake tx hash", async () => {
    const client = createMppClient({ keypair: Keypair.random() });
    setMppClient(client);

    // No Payment-Receipt header, no receipt in the body — only an order id.
    mockMppFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true, order: { id: "order-no-receipt" } }), { status: 200 }),
    );

    const result = await payForMedication("pharmacy-1", "Test Pharmacy", "Amoxicillin", 10);

    expect(result.success).toBe(true);
    expect((result as any).transaction.stellarTxHash).toBeUndefined();
    expect((result as any).transaction.mppOrderId).toBe("order-no-receipt");
  });

  it("documents actual behavior: budget is reserved optimistically before the charge and rolled back exactly on failure (agent/tools.ts payForMedication: 'Reserve the budget before releasing the mutex')", async () => {
    mockMppFetch.mockRejectedValue(new Error("facilitator unreachable"));

    const before = getSpendingTracker().medications;
    const result = await payForMedication("pharmacy-1", "Test Pharmacy", "Amoxicillin", 10);

    expect(result.success).toBe(false);
    // Rolled back to exactly the pre-payment balance — no leftover debit, no double-charge.
    expect(getSpendingTracker().medications).toBe(before);
  });

  it("a successful payment leaves the budget debited by exactly the paid amount", async () => {
    const client = createMppClient({ keypair: Keypair.random() });
    setMppClient(client);
    mockMppFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true, order: { id: "order-1" } }), {
        status: 200,
        headers: { "Payment-Receipt": makeReceiptHeader("c".repeat(64)) },
      }),
    );

    const before = getSpendingTracker().medications;
    const result = await payForMedication("pharmacy-1", "Test Pharmacy", "Amoxicillin", 10);

    expect(result.success).toBe(true);
    expect(getSpendingTracker().medications).toBeCloseTo(before + 10, 4);
  });
});
