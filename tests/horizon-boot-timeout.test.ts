import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.AGENT_SECRET_KEY = "SC4NVF7S4WC4V5UTZ2A4AQZSKL6KJHEPQIYXBQU44OA35BWX264CL5NQ";
  process.env.CAREGIVER_TOKEN = "test-caregiver-token";
  process.env.LLM_API_KEY = "test-llm-api-key";
  process.env.PHARMACY_1_PUBLIC_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  process.env.BILL_PROVIDER_PUBLIC_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  process.env.MPP_SECRET_KEY = "SC4NVF7S4WC4V5UTZ2A4AQZSKL6KJHEPQIYXBQU44OA35BWX264CL5NQ";
  process.env.MOCK_NETWORK = "1";
});

import { bootAccountCheck, isDegraded, setDegradedMode } from "../server.ts";

describe("Horizon Boot-Time Timeout & Degraded Mode (Issue #233)", () => {
  beforeEach(() => {
    setDegradedMode(false);
  });

  it("completes boot within 10s when Horizon responds normally", async () => {
    const mockHorizon = {
      loadAccount: vi.fn().mockResolvedValue({
        balances: [{ asset_code: "USDC", balance: "100.50" }],
      }),
    } as any;

    const result = await bootAccountCheck(mockHorizon, "GXXXXXXXXXX", 1000);
    expect(result.success).toBe(true);
    expect(result.usdcBalance).toBe("100.50");
    expect(isDegraded()).toBe(false);
  });

  it("times out after 10s and starts in degraded mode when Horizon hangs", async () => {
    vi.useFakeTimers();

    const mockHorizon = {
      loadAccount: vi.fn().mockImplementation(() => new Promise(() => {})), // Never resolves
    } as any;

    const bootPromise = bootAccountCheck(mockHorizon, "GXXXXXXXXXX", 10000);

    // Fast forward 10 seconds
    vi.advanceTimersByTime(10001);

    const result = await bootPromise;
    expect(result.success).toBe(false);
    expect(result.usdcBalance).toBe("unable to check");
    expect(isDegraded()).toBe(true);

    vi.useRealTimers();
  });

  it("logs critical error and enters degraded mode on Horizon network error", async () => {
    const mockHorizon = {
      loadAccount: vi.fn().mockRejectedValue(new Error("ENOTFOUND horizon-testnet.stellar.org")),
    } as any;

    const result = await bootAccountCheck(mockHorizon, "GXXXXXXXXXX", 1000);
    expect(result.success).toBe(false);
    expect(result.usdcBalance).toBe("unable to check");
    expect(isDegraded()).toBe(true);
  });
});
