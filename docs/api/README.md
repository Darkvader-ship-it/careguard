# API Documentation Hosting

How the CareGuard OpenAPI spec is generated, served, viewed, and validated.

## Where the docs live

| What | URL | Source |
| --- | --- | --- |
| Interactive reference | `GET /docs` | [shared/api-docs.ts](../../shared/api-docs.ts) |
| Raw OpenAPI 3.1 spec | `GET /openapi.yml` | [docs/openapi.yml](../openapi.yml) |

Both routes are mounted on the unified server ([server.ts](../../server.ts)), so they
follow whatever host that process is deployed to:

- Local: <http://localhost:3000/docs> (spec at <http://localhost:3000/openapi.yml>)
- Docker dev: <http://localhost:3004/docs>
- Production: <https://api.careguard.xyz/docs>

Neither route requires authentication or payment — the reference has to be
readable before anyone can pay for an endpoint.

## Hosting approach

The reference is rendered by [Scalar API Reference](https://github.com/scalar/scalar),
loaded from a pinned jsDelivr build and pointed at `/openapi.yml` on the same
origin. This was chosen over Swagger UI or Redoc for concrete reasons:

- **No new runtime dependency.** Nothing is added to `package.json`, so the
  install footprint and the dependency-review surface are unchanged.
- **Spec is served, not embedded.** The page fetches `/openapi.yml` at load
  time, so a regenerated spec is live on the next request — the rendered docs
  cannot drift from the file in the repo.
- **The spec already documented this.** `/docs` is described in the spec itself
  as "Scalar UI serving this OpenAPI spec".

The app-wide CSP in [shared/security-middleware.ts](../../shared/security-middleware.ts)
only allows `'self'` scripts, so the docs route sets its own CSP header, scoped
to that one page, allowing scripts and styles from `cdn.jsdelivr.net` and
keeping `connect-src` at `'self'`.

### Running it locally

```bash
npm run gen-openapi     # regenerate docs/openapi.yml from scripts/gen-openapi.ts
npm start               # unified server on PORT (default 3000)
open http://localhost:3000/docs
```

### Switching to a vendored (offline) renderer

The CDN dependency is the one trade-off: an air-gapped deployment renders a
blank page (the spec at `/openapi.yml` still serves fine). To vendor it:

1. `npm install @scalar/api-reference` (or `swagger-ui-dist`).
2. Serve the package's `dist/` via `express.static` from
   [shared/api-docs.ts](../../shared/api-docs.ts).
3. Point `SCALAR_CDN_URL` at the local asset path and drop `cdn.jsdelivr.net`
   from `DOCS_CSP`.

The route contract (`/docs`, `/openapi.yml`) stays the same either way.

## Keeping the spec valid and in sync

`docs/openapi.yml` is **generated**, not hand-edited. Edit
[scripts/gen-openapi.ts](../../scripts/gen-openapi.ts) and regenerate:

```bash
npm run gen-openapi
npm run validate:openapi
```

### CI validation

[.github/workflows/openapi.yml](../../.github/workflows/openapi.yml) runs on every
PR touching the spec, the generator, the validator, or the docs router, and on
pushes to `main`. A broken spec fails the build. Two steps:

1. **`npm run validate:openapi`** ([scripts/validate-openapi.ts](../../scripts/validate-openapi.ts))
   - *Structure*: 3.1.x version, `info`, at least one server, non-empty `paths`,
     every operation has a summary and at least one described response with a
     valid status code, every `security` requirement names a declared scheme,
     and every `$ref` resolves.
   - *Serialization*: no tabs, no trailing whitespace, and no container
     punctuation in column 0. This last one is not hypothetical — the generator
     used to emit `security:\n[]`, which made the whole document unparseable and
     was why nothing could render it.
   - *Drift*: the checked-in file must byte-match what the generator produces
     today. Forgetting to commit a regenerated spec fails CI.
2. **`npx @redocly/cli lint`** — full OpenAPI 3.1 conformance lint, run from the
   registry so no dependency is added. Errors fail the job; style warnings
   (missing `operationId`, missing `license`) do not.

To reproduce the CI run locally:

```bash
npm run validate:openapi
npx --yes @redocly/cli@1 lint docs/openapi.yml
```

## Authentication: the X402Auth scheme

Most endpoints are behind the [x402](https://www.x402.org/) payment protocol
rather than a conventional API key, which the spec models as the `X402Auth`
security scheme. What consumers need to know:

- **You do not send a bearer token.** `X402Auth` is declared as `http`/`bearer`
  because OpenAPI 3.1 has no native x402 type. The real credential is the
  **`X-PAYMENT`** request header carrying a signed Stellar payment payload.
- **The flow is challenge-first.** Call a protected route with no `X-PAYMENT`
  header and the server answers **`402 Payment Required`** with the accepted
  scheme, network (`stellar:testnet`), `payTo` address, and price. Sign that
  payment, resend the request with `X-PAYMENT`, and the call proceeds.
- **The receipt comes back in a header.** Successful paid responses carry
  `PAYMENT-RESPONSE`, from which the Stellar transaction hash is extracted for
  on-chain verification (see `extractX402TxHash` in
  [agent/tools.ts](../../agent/tools.ts)).
- **Payment is never skipped.** The facilitator connection is fail-closed: if it
  is unreachable, protected routes return `503` instead of serving unpaid
  traffic. See [shared/x402-middleware.ts](../../shared/x402-middleware.ts).
- **Prices are per route**, declared where each route is mounted in
  [server.ts](../../server.ts):

  | Route | Price |
  | --- | --- |
  | `GET /pharmacy/compare` | $0.002 USDC |
  | `GET /drug/interactions` | $0.001 USDC |
  | `POST /bill/audit` | $0.01 USDC |
  | `POST /pharmacy/order` | quoted per order |

- **Unprotected routes**: `/health`, `/ready`, `/metrics`, `/docs`, and
  `/openapi.yml` carry `security: []` in the spec and never require payment.

Client-side handling of the 402 challenge is automatic when using
`@x402/fetch`; see the x402 client setup in [agent/tools.ts](../../agent/tools.ts).

## Related

- [docs/openapi.yml](../openapi.yml) — the spec
- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — service topology
- [docs/observability/health-checks.md](../observability/health-checks.md) — `/health` and `/ready` semantics
