import { describe, it, expect } from "vitest";
import { getPharmacyPrices } from "../../../shared/pharmacy-pricing.ts";
import { buildCompareResponse, PharmacyCompareResponseSchema } from "../logic.ts";

describe("Zip-aware pharmacy pricing (Issue #11)", () => {
  it("same zip returns identical prices", () => {
    const res1 = getPharmacyPrices("lisinopril", "90210");
    const res2 = getPharmacyPrices("lisinopril", "90210");

    expect(res1.usedZipCode).toBe("90210");
    expect(res1.isFallbackZip).toBe(false);
    expect(res1.prices).toEqual(res2.prices);
  });

  it("different zips return location-specific price variations", () => {
    const zip90210 = getPharmacyPrices("lisinopril", "90210");
    const zip10001 = getPharmacyPrices("lisinopril", "10001");

    expect(zip90210.usedZipCode).toBe("90210");
    expect(zip10001.usedZipCode).toBe("10001");
    expect(zip90210.isFallbackZip).toBe(false);
    expect(zip10001.isFallbackZip).toBe(false);

    // 90210 Costco price is 3.50, 10001 Costco price is 4.20
    expect(zip90210.prices[0].price).not.toBe(zip10001.prices[0].price);
  });

  it("unsupported zip falls back to default zip code with fallback flag", () => {
    const result = getPharmacyPrices("lisinopril", "99999");

    expect(result.usedZipCode).toBe("90210");
    expect(result.isFallbackZip).toBe(true);
    expect(result.prices.length).toBeGreaterThan(0);
  });

  it("locked response shape satisfies Zod schema contract", () => {
    const query = getPharmacyPrices("lisinopril", "10001");
    const response = buildCompareResponse({
      drug: "lisinopril",
      dosage: "10mg",
      zip: "10001",
      usedZipCode: query.usedZipCode,
      isFallbackZip: query.isFallbackZip,
      payTo: "GXXXXXX",
      network: "stellar:testnet",
      prices: query.prices,
    });

    const parsed = PharmacyCompareResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.zipCode).toBe("10001");
      expect(parsed.data.usedZipCode).toBe("10001");
      expect(parsed.data.isFallbackZip).toBe(false);
    }
  });
});
