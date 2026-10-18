/**
 * API docs hosting tests (Issue #752).
 *
 * Pins the two routes consumers depend on — the rendered reference at /docs and
 * the raw spec at /openapi.yml — plus the CSP relaxation the renderer needs,
 * which the app-wide policy in security-middleware.ts would otherwise block.
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { applySecurityMiddleware } from "../security-middleware.ts";
import { createApiDocsRouter, DOCS_ROUTE, SPEC_ROUTE, SCALAR_CDN_URL } from "../api-docs.ts";

const SPEC_FIXTURE = `openapi: '3.1.0'
info:
  title: 'CareGuard API'
  version: '1.0.0'
paths:
  /health:
    get:
      summary: 'Liveness probe'
      security: []
      responses:
        200:
          description: 'Process is up'
`;

function buildApp(specPath?: string) {
  const app = express();
  // Mirror production ordering: the strict app-wide CSP is applied first.
  applySecurityMiddleware(app);
  app.use(createApiDocsRouter(specPath ? { specPath } : {}));
  return app;
}

function withTempSpec(contents: string | null) {
  const dir = mkdtempSync(path.join(tmpdir(), "careguard-openapi-"));
  const specPath = path.join(dir, "openapi.yml");
  if (contents !== null) writeFileSync(specPath, contents, "utf-8");
  return { specPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("GET /openapi.yml", () => {
  it("serves the spec as YAML", async () => {
    const { specPath, cleanup } = withTempSpec(SPEC_FIXTURE);
    try {
      const res = await request(buildApp(specPath)).get(SPEC_ROUTE);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("yaml");
      expect(res.text).toBe(SPEC_FIXTURE);
    } finally {
      cleanup();
    }
  });

  it("serves the checked-in spec by default", async () => {
    const res = await request(buildApp()).get(SPEC_ROUTE);

    expect(res.status).toBe(200);
    expect(res.text).toContain("openapi: '3.1.0'");
    expect(res.text).toContain("X402Auth");
  });

  it("is not cached, so a regenerated spec is served immediately", async () => {
    const { specPath, cleanup } = withTempSpec(SPEC_FIXTURE);
    try {
      const app = buildApp(specPath);
      const before = await request(app).get(SPEC_ROUTE);
      expect(before.headers["cache-control"]).toBe("no-cache");

      writeFileSync(specPath, SPEC_FIXTURE.replace("1.0.0", "2.0.0"), "utf-8");
      const after = await request(app).get(SPEC_ROUTE);

      expect(after.text).toContain("2.0.0");
    } finally {
      cleanup();
    }
  });

  it("returns a diagnosable error when the spec file is missing", async () => {
    const { specPath, cleanup } = withTempSpec(null);
    try {
      const res = await request(buildApp(specPath)).get(SPEC_ROUTE);

      expect(res.status).toBe(500);
      expect(res.body.code).toBe("SPEC_MISSING");
      expect(res.body.details.hint).toContain("gen-openapi");
    } finally {
      cleanup();
    }
  });
});

describe("GET /docs", () => {
  it("renders an HTML page pointed at the spec route", async () => {
    const res = await request(buildApp()).get(DOCS_ROUTE);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain(`data-url="${SPEC_ROUTE}"`);
    expect(res.text).toContain(SCALAR_CDN_URL);
  });

  it("pins the renderer to an exact version rather than a floating tag", () => {
    expect(SCALAR_CDN_URL).toMatch(/@\d+\.\d+\.\d+\//);
  });

  it("relaxes CSP for the renderer CDN without widening connect-src", async () => {
    const res = await request(buildApp()).get(DOCS_ROUTE);
    const csp = res.headers["content-security-policy"];

    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net");
    // The page only ever fetches the spec from its own origin.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("leaves the strict app-wide CSP in place for other routes", async () => {
    const app = buildApp();
    app.get("/other", (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get("/other");

    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).not.toContain("cdn.jsdelivr.net");
  });

  it("does not require authentication or payment", async () => {
    const docs = await request(buildApp()).get(DOCS_ROUTE);
    const spec = await request(buildApp()).get(SPEC_ROUTE);

    expect(docs.status).toBe(200);
    expect(spec.status).toBe(200);
    expect(docs.headers["www-authenticate"]).toBeUndefined();
  });
});
