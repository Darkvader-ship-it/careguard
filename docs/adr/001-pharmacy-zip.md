# ADR 001: Zip Code-Aware Pharmacy Pricing Model

## Context

The `/pharmacy/compare` endpoint previously accepted a `zip` query parameter (e.g. `?zip=90210`) and echoed `zipCode: zip` back in the response header, but returned identical pricing regardless of the provided zip code. Callers were misled into assuming location-aware price variation.

## Decision

We chose **Option A**: Make the pharmacy pricing database zip-code aware by structuring drug prices as a nested map (`Record<string, Record<string, PharmacyPrice[]>>`) containing location-specific pricing entries (such as `90210`, `10001`, `33101`) along with a documented fallback to the default zip code (`90210`) for unmapped zip codes.

Key aspects:
1. **Per-Zip Pricing Database**: `PRICING_DATABASE` maps `[drug][zipCode]` to location-specific prices and distance metrics.
2. **Fallback Behavior**: If a requested zip code is not found in the database, the query falls back to the default zip code (`90210`), returning `isFallbackZip: true` and `usedZipCode: "90210"`.
3. **Response Contract Lock**: The response shape is locked with `PharmacyCompareResponseSchema` using Zod to enforce schema validity across all server modes.

## Consequences

- Callers receive location-specific price variations for supported zip codes.
- Unsupported zip codes receive predictable fallback pricing explicitly indicated in response metadata.
- API response structure is locked via Zod schema validation.
