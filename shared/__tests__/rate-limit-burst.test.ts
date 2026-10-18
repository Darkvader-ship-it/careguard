/**
 * Rate-limit burst-behaviour integration tests (Issue #799).
 *
 * The middleware is mounted on a real Express app and driven with bursts, so
 * these pin end-to-end behaviour rather than internals: rejected requests get a
 * 429 with Retry-After (and never hang), the concurrency gauge returns to zero
 * without going negative when both `finish` and `close` fire, malformed env
 * limits fall back to safe defaults, and metric labels keep routes and policies
 * distinguishable.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { EventEmitter } from "events";
import {
  concurrentRequestsMiddleware,
  createRateLimiter,
  parseLimitEnv,
  rateLimitHitsTotal,
  routeConcurrentRequests,
  RATE_LIMIT_DEFAULTS,
} from "../rate-limit.ts";

/** Current value of a labelled metric, or 0 when it has never been touched. */
async function metricValue(
  metric: { get(): Promise<any> | any },
  labelKey: string,
  labelValue: string,
): Promise<number> {
  const data = await metric.get();
  const match = data.values.find((v: any) => v.labels[labelKey] === labelValue);
  return match?.value ?? 0;
}

function buildApp(limiterRoute: string, max: number, windowMs = 60_000) {
  const app = express();
  app.get(
    `/${limiterRoute}`,
    createRateLimiter(limiterRoute, max, windowMs),
    concurrentRequestsMiddleware(limiterRoute),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  return app;
}

beforeEach(() => {
  routeConcurrentRequests.reset();
});

describe("burst over the limit", () => {
  it("serves up to the limit, then answers 429 without hanging", async () => {
    const app = buildApp("burst_basic", 3);

    const responses = [];
    for (let i = 0; i < 5; i++) {
      responses.push(await request(app).get("/burst_basic"));
    }

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 429, 429]);
    // Every request resolved — a handler that forgot to respond would surface
    // here as a supertest timeout instead.
    expect(responses.every((r) => r.text !== undefined)).toBe(true);
  });

  it("includes Retry-After on the 429", async () => {
    const app = buildApp("burst_retry_after", 1, 60_000);

    await request(app).get("/burst_retry_after");
    const rejected = await request(app).get("/burst_retry_after");

    expect(rejected.status).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("60");
  });

  it("advertises the limit through standard RateLimit headers", async () => {
    const app = buildApp("burst_headers", 2);

    const first = await request(app).get("/burst_headers");

    expect(first.headers["ratelimit-limit"]).toBe("2");
    expect(first.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  it("keeps serving concurrent in-flight requests that are under the limit", async () => {
    const app = buildApp("burst_parallel", 10);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(app).get("/burst_parallel")),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
  });
});

describe("concurrent-requests gauge", () => {
  it("returns to zero after a burst", async () => {
    const app = buildApp("gauge_burst", 50);

    await Promise.all(Array.from({ length: 10 }, () => request(app).get("/gauge_burst")));

    expect(await metricValue(routeConcurrentRequests, "route", "gauge_burst")).toBe(0);
  });

  it("never goes negative when both finish and close fire", async () => {
    const route = "gauge_double_release";
    const res = new EventEmitter() as any;
    const next = () => {};

    concurrentRequestsMiddleware(route)({} as any, res, next);
    expect(await metricValue(routeConcurrentRequests, "route", route)).toBe(1);

    // Express emits both for a normally completed response.
    res.emit("finish");
    res.emit("close");

    expect(await metricValue(routeConcurrentRequests, "route", route)).toBe(0);
  });

  it("stays at zero even if the same response emits release events repeatedly", async () => {
    const route = "gauge_repeat_release";
    const res = new EventEmitter() as any;

    concurrentRequestsMiddleware(route)({} as any, res, () => {});
    res.emit("close");
    res.emit("close");
    res.emit("finish");

    expect(await metricValue(routeConcurrentRequests, "route", route)).toBe(0);
  });

  it("tracks overlapping requests independently", async () => {
    const route = "gauge_overlap";
    const first = new EventEmitter() as any;
    const second = new EventEmitter() as any;
    const middleware = concurrentRequestsMiddleware(route);

    middleware({} as any, first, () => {});
    middleware({} as any, second, () => {});
    expect(await metricValue(routeConcurrentRequests, "route", route)).toBe(2);

    first.emit("finish");
    first.emit("close");
    expect(await metricValue(routeConcurrentRequests, "route", route)).toBe(1);

    second.emit("close");
    expect(await metricValue(routeConcurrentRequests, "route", route)).toBe(0);
  });

  it("labels each route separately", async () => {
    const app = buildApp("gauge_route_a", 20);
    const other = new EventEmitter() as any;

    await request(app).get("/gauge_route_a");
    concurrentRequestsMiddleware("gauge_route_b")({} as any, other, () => {});

    expect(await metricValue(routeConcurrentRequests, "route", "gauge_route_a")).toBe(0);
    expect(await metricValue(routeConcurrentRequests, "route", "gauge_route_b")).toBe(1);

    other.emit("finish");
  });
});

describe("env-configured limits", () => {
  it("uses a valid positive integer", () => {
    expect(parseLimitEnv("42", RATE_LIMIT_DEFAULTS.billAudit)).toBe(42);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["non-numeric", "abc"],
    ["partially numeric", "20abc"],
    ["zero", "0"],
    ["negative", "-5"],
    ["fractional", "2.5"],
    ["NaN literal", "NaN"],
    ["Infinity", "Infinity"],
  ])("falls back to the default for a %s value", (_label, raw) => {
    expect(parseLimitEnv(raw as string | undefined, RATE_LIMIT_DEFAULTS.agentRun)).toBe(
      RATE_LIMIT_DEFAULTS.agentRun,
    );
  });

  it("keeps limiting when the env value is garbage, rather than disabling it", async () => {
    const limit = parseLimitEnv("not-a-number", 2);
    const app = buildApp("burst_bad_env", limit);

    const responses = [];
    for (let i = 0; i < 4; i++) {
      responses.push(await request(app).get("/burst_bad_env"));
    }

    expect(responses.map((r) => r.status)).toEqual([200, 200, 429, 429]);
  });
});

describe("metric labelling", () => {
  it("counts rejections per policy", async () => {
    const before = await metricValue(rateLimitHitsTotal, "policy", "policy_labelled");
    const app = buildApp("policy_labelled", 1);

    await request(app).get("/policy_labelled");
    await request(app).get("/policy_labelled");
    await request(app).get("/policy_labelled");

    const after = await metricValue(rateLimitHitsTotal, "policy", "policy_labelled");
    expect(after - before).toBe(2);
  });

  it("does not attribute one policy's rejections to another", async () => {
    const strict = buildApp("policy_strict", 1);
    const loose = buildApp("policy_loose", 50);

    const strictBefore = await metricValue(rateLimitHitsTotal, "policy", "policy_strict");
    const looseBefore = await metricValue(rateLimitHitsTotal, "policy", "policy_loose");

    await request(strict).get("/policy_strict");
    await request(strict).get("/policy_strict"); // rejected
    await request(loose).get("/policy_loose");
    await request(loose).get("/policy_loose"); // allowed

    expect(
      (await metricValue(rateLimitHitsTotal, "policy", "policy_strict")) - strictBefore,
    ).toBe(1);
    expect(
      (await metricValue(rateLimitHitsTotal, "policy", "policy_loose")) - looseBefore,
    ).toBe(0);
  });

  it("keeps per-route buckets independent, so one route cannot starve another", async () => {
    const busy = buildApp("bucket_busy", 1);
    const quiet = buildApp("bucket_quiet", 1);

    await request(busy).get("/bucket_busy");
    const busyRejected = await request(busy).get("/bucket_busy");
    const quietFirst = await request(quiet).get("/bucket_quiet");

    expect(busyRejected.status).toBe(429);
    expect(quietFirst.status).toBe(200);
  });
});
