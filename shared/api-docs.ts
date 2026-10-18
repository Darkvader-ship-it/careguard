/**
 * Interactive API documentation for docs/openapi.yml.
 *
 * Mounts two routes on the unified server:
 *   GET /openapi.yml — the raw OpenAPI 3.1 spec (text/yaml)
 *   GET /docs        — Scalar API Reference rendering that spec
 *
 * The renderer is loaded from a pinned CDN build rather than a vendored copy,
 * so no runtime dependency is added. The app-wide CSP (shared/security-middleware.ts)
 * only allows 'self' scripts, so this router sets its own CSP header scoped to
 * the docs page. See docs/api/README.md for the hosting contract and for the
 * offline/vendored alternative.
 */

import { Router, type Request, type Response } from "express";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Pinned so the docs page cannot change under us when the CDN publishes a new major. */
export const SCALAR_CDN_URL =
  "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.128/dist/browser/standalone.min.js";

export const SPEC_ROUTE = "/openapi.yml";
export const DOCS_ROUTE = "/docs";

const DEFAULT_SPEC_PATH = path.resolve(__dirname, "../docs/openapi.yml");

/**
 * CSP for the docs page only. The renderer is a CDN script that injects its own
 * styles, and it fetches the spec from this same origin.
 */
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data: https://cdn.jsdelivr.net",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

function renderDocsPage(specUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CareGuard API Reference</title>
  </head>
  <body>
    <script id="api-reference" type="application/json" data-url="${specUrl}"></script>
    <script src="${SCALAR_CDN_URL}" crossorigin="anonymous"></script>
  </body>
</html>`;
}

export interface ApiDocsOptions {
  /** Absolute path to the spec. Defaults to docs/openapi.yml. */
  specPath?: string;
}

/**
 * Router serving the spec and its rendered reference.
 *
 * The spec is read from disk on each request so `npm run gen-openapi` is picked
 * up without a restart in development; the file is small and this is not a hot
 * path.
 */
export function createApiDocsRouter(options: ApiDocsOptions = {}): Router {
  const specPath = options.specPath ?? DEFAULT_SPEC_PATH;
  const router = Router();

  router.get(SPEC_ROUTE, (_req: Request, res: Response) => {
    if (!existsSync(specPath)) {
      res.status(500).json({
        error: "OpenAPI spec not found",
        code: "SPEC_MISSING",
        details: { hint: "Run `npm run gen-openapi` to regenerate docs/openapi.yml" },
      });
      return;
    }

    res
      .type("text/yaml; charset=utf-8")
      .set("Cache-Control", "no-cache")
      .send(readFileSync(specPath, "utf-8"));
  });

  router.get(DOCS_ROUTE, (_req: Request, res: Response) => {
    res
      .type("text/html; charset=utf-8")
      .set("Content-Security-Policy", DOCS_CSP)
      .set("Cache-Control", "no-cache")
      .send(renderDocsPage(SPEC_ROUTE));
  });

  return router;
}
