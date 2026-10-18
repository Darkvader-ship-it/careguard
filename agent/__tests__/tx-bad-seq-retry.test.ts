/**
 * tx_bad_seq account-reload retry tests (Issue #796).
 *
 * A Stellar sequence-number collision is the normal outcome of two payments
 * racing from the same wallet. The only recovery is to reload the account,
 * rebuild the envelope with the fresh sequence, and resubmit — so these tests
 * pin that the reload happens, that it happens *only* for sequence errors, and
 * that the loop stays inside the 35s budget instead of spinning.
 *
 * An injected RetryClock replaces the 1s backoff sleeps, so the suite runs fast.
 */

const { mockLoadAccount, mockSubmitTransaction, MOCK_HINT } = vi.hoisted(() => {
  process.env.AGENT_SECRET_KEY = "SBWWZYCAFDDJXNRRMKSFNRB6OTVZHTCMPUCVZ4FBZLSPHFKHYLPRTJCD";
  process.env.BILL_PROVIDER_PUBLIC_KEY = "GBQTESTBILLPROVIDER";
  const MOCK_HINT = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
  return {
    mockLoadAccount: vi.fn(),
    mockSubmitTransaction: vi.fn(),
    MOCK_HINT,
  };
});

vi.mock("dotenv/config", () => ({}));
vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue("{}"),
  writeFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
}));
vi.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    fromSecret: vi.fn().mockReturnValue({
      publicKey: () => "GPUB123",
      sign: vi.fn(),
      signatureHint: vi.fn().mockReturnValue(MOCK_HINT),
    }),
  },
  Networks: { TESTNET: "Test SDF Network ; September 2015" },
  TransactionBuilder: Object.assign(
    vi.fn().mockReturnValue({
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({
        sign: vi.fn(),
        signatures: [{ hint: vi.fn().mockReturnValue(MOCK_HINT) }],
      }),
    }),
    { buildFeeBumpTransaction: vi.fn().mockReturnValue({ sign: vi.fn() }) },
  ),
  Operation: { payment: vi.fn() },
  Asset: vi.fn(),
  Horizon: {
    Server: vi.fn().mockReturnValue({
      loadAccount: mockLoadAccount,
      submitTransaction: mockSubmitTransaction,
    }),
  },
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
vi.mock("@stellar/mpp/charge/client", () => ({ stellar: vi.fn().mockReturnValue({}) }));
vi.mock("mppx/client", () => ({ Mppx: { create: vi.fn().mockReturnValue({ fetch: vi.fn() }) } }));

import { describe, it, expect, beforeEach } from "vitest";
import {
  submitTransactionWithRetry,
  RetryBudgetExceededError,
  type RetryClock,
} from "../tools.ts";

const BUDGET_MS = 35_000;
const mockServer = { loadAccount: mockLoadAccount, submitTransaction: mockSubmitTransaction } as any;

/** A Horizon-shaped failure: HTTP 400 with the result code in extras. */
function horizonError(code: string) {
  const err: any = new Error(`Request failed with status code 400`);
  err.response = {
    status: 400,
    data: { extras: { result_codes: { transaction: code } } },
  };
  return err;
}

/** A fake clock whose sleep() advances simulated time instead of really waiting. */
function makeFakeClock(startAt = 0) {
  let now = startAt;
  const clock: RetryClock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  return { clock, current: () => now };
}

/**
 * A rebuild closure shaped like the real one in submitTransactionWithFeeBump:
 * it reloads the account and returns an envelope carrying that sequence.
 */
function makeRebuild() {
  return async () => {
    const account = await mockServer.loadAccount("GPUB123");
    return { sequence: account.sequence, kind: "rebuilt" };
  };
}

beforeEach(() => {
  mockLoadAccount.mockReset();
  mockSubmitTransaction.mockReset();
  let sequence = 100;
  // Each reload observes the ledger having moved on.
  mockLoadAccount.mockImplementation(async () => ({
    id: "GPUB123",
    sequence: String(++sequence),
  }));
});

describe("submitTransactionWithRetry — tx_bad_seq (Issue #796)", () => {
  it("reloads the account and resubmits with the refreshed sequence", async () => {
    const { clock } = makeFakeClock();
    mockSubmitTransaction
      .mockRejectedValueOnce(horizonError("tx_bad_seq"))
      .mockResolvedValueOnce({ hash: "hash-after-reload" });

    const result = await submitTransactionWithRetry(
      mockServer,
      { sequence: "100", kind: "original" },
      2,
      35_000,
      makeRebuild(),
      undefined,
      clock,
    );

    expect(result.hash).toBe("hash-after-reload");
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);

    // The resubmit must carry the rebuilt envelope, not the stale one.
    const resubmitted = mockSubmitTransaction.mock.calls[1][0];
    expect(resubmitted.kind).toBe("rebuilt");
    expect(resubmitted.sequence).toBe("101");
  });

  it("keeps reloading across repeated collisions until one lands", async () => {
    const { clock } = makeFakeClock();
    mockSubmitTransaction
      .mockRejectedValueOnce(horizonError("tx_bad_seq"))
      .mockRejectedValueOnce(horizonError("tx_bad_seq"))
      .mockResolvedValueOnce({ hash: "hash-third-try" });

    const result = await submitTransactionWithRetry(
      mockServer,
      { sequence: "100" },
      2,
      35_000,
      makeRebuild(),
      undefined,
      clock,
    );

    expect(result.hash).toBe("hash-third-try");
    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    expect(mockSubmitTransaction.mock.calls[2][0].sequence).toBe("102");
  });

  it("surfaces the failure after the sequence retries are exhausted, without looping unbounded", async () => {
    const { clock } = makeFakeClock();
    mockSubmitTransaction.mockRejectedValue(horizonError("tx_bad_seq"));

    await expect(
      submitTransactionWithRetry(
        mockServer,
        { sequence: "100" },
        2,
        35_000,
        makeRebuild(),
        undefined,
        clock,
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });

    // 1 initial + at most 3 sequence retries.
    expect(mockSubmitTransaction.mock.calls.length).toBeLessThanOrEqual(4);
    expect(mockLoadAccount.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("two concurrent payments from the same wallet both settle", async () => {
    // Horizon accepts one sequence number once; the loser of the race gets
    // tx_bad_seq and must recover rather than failing permanently.
    const consumed = new Set<string>();
    mockSubmitTransaction.mockImplementation(async (tx: any) => {
      if (consumed.has(tx.sequence)) throw horizonError("tx_bad_seq");
      consumed.add(tx.sequence);
      return { hash: `hash-seq-${tx.sequence}` };
    });

    const clockA = makeFakeClock().clock;
    const clockB = makeFakeClock().clock;

    const [first, second] = await Promise.all([
      submitTransactionWithRetry(
        mockServer, { sequence: "100" }, 2, 35_000, makeRebuild(), undefined, clockA,
      ),
      submitTransactionWithRetry(
        mockServer, { sequence: "100" }, 2, 35_000, makeRebuild(), undefined, clockB,
      ),
    ]);

    expect(first.hash).toBeDefined();
    expect(second.hash).toBeDefined();
    expect(first.hash).not.toBe(second.hash);
  });

  it("stops at the retry budget instead of resubmitting past it", async () => {
    const { clock, current } = makeFakeClock();
    // Every submit burns 15s, so the third one cannot fit in the 35s budget.
    mockSubmitTransaction.mockImplementation(async () => {
      await clock.sleep(15_000);
      throw horizonError("tx_bad_seq");
    });

    const deadlineAt = clock.now() + BUDGET_MS;

    await expect(
      submitTransactionWithRetry(
        mockServer, { sequence: "100" }, 2, 35_000, makeRebuild(), deadlineAt, clock,
      ),
    ).rejects.toThrow(RetryBudgetExceededError);

    expect(current()).toBeLessThanOrEqual(BUDGET_MS + 15_000);
  });

  it("does not reload the account when no rebuild function is available", async () => {
    const { clock } = makeFakeClock();
    mockSubmitTransaction.mockRejectedValue(horizonError("tx_bad_seq"));

    await expect(
      submitTransactionWithRetry(
        mockServer, { sequence: "100" }, 2, 35_000, undefined, undefined, clock,
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });

    expect(mockLoadAccount).not.toHaveBeenCalled();
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("submitTransactionWithRetry — timebound codes are handled distinctly", () => {
  it("tx_too_late rebuilds with fresh timebounds and resubmits", async () => {
    const { clock } = makeFakeClock();
    mockSubmitTransaction
      .mockRejectedValueOnce(horizonError("tx_too_late"))
      .mockResolvedValueOnce({ hash: "hash-fresh-timebounds" });

    const result = await submitTransactionWithRetry(
      mockServer, { sequence: "100" }, 2, 35_000, makeRebuild(), undefined, clock,
    );

    expect(result.hash).toBe("hash-fresh-timebounds");
    expect(mockSubmitTransaction.mock.calls[1][0].kind).toBe("rebuilt");
  });

  it("tx_too_early propagates immediately — no reload, no retry", async () => {
    const { clock } = makeFakeClock();
    mockSubmitTransaction.mockRejectedValue(horizonError("tx_too_early"));

    await expect(
      submitTransactionWithRetry(
        mockServer, { sequence: "100" }, 2, 35_000, makeRebuild(), undefined, clock,
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });

    expect(mockLoadAccount).not.toHaveBeenCalled();
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("submitTransactionWithRetry — non-sequence failures never reload", () => {
  it("tx_bad_auth propagates immediately without a reload", async () => {
    const { clock } = makeFakeClock();
    mockSubmitTransaction.mockRejectedValue(horizonError("tx_bad_auth"));

    await expect(
      submitTransactionWithRetry(
        mockServer, { sequence: "100" }, 2, 35_000, makeRebuild(), undefined, clock,
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });

    expect(mockLoadAccount).not.toHaveBeenCalled();
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  it("a network timeout backs off and retries the same envelope, without reloading", async () => {
    const { clock } = makeFakeClock();
    mockSubmitTransaction
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({ hash: "hash-after-backoff" });

    const result = await submitTransactionWithRetry(
      mockServer, { sequence: "100", kind: "original" }, 2, 35_000, makeRebuild(), undefined, clock,
    );

    expect(result.hash).toBe("hash-after-backoff");
    expect(mockLoadAccount).not.toHaveBeenCalled();
    expect(mockSubmitTransaction.mock.calls[1][0].kind).toBe("original");
  });

  it("recognises tx_bad_seq reported only in the error message", async () => {
    // Some SDK paths surface the code in the message with no Horizon envelope.
    const { clock } = makeFakeClock();
    mockSubmitTransaction
      .mockRejectedValueOnce(new Error("tx_bad_seq"))
      .mockResolvedValueOnce({ hash: "hash-message-path" });

    const result = await submitTransactionWithRetry(
      mockServer, { sequence: "100" }, 2, 35_000, makeRebuild(), undefined, clock,
    );

    expect(result.hash).toBe("hash-message-path");
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });
});
