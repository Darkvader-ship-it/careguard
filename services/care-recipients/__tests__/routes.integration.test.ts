import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { CareRecipientsStore } from "../db.ts";
import { createCareRecipientsRouter } from "../routes.ts";

/**
 * Integration test (Issue #791): exercises the real /recipients GET/POST
 * routes mounted on server.ts (via createCareRecipientsRouter, extracted
 * from server.ts so it's testable without booting the full unified server —
 * that server also wires up Sentry, Stellar, the LLM client, and the agent
 * runtime, none of which /recipients depends on) against a real, isolated
 * CareRecipientsStore.
 */

const CAREGIVER_TOKEN = "test-caregiver-token";

function makeApp() {
  const store = new CareRecipientsStore(":memory:"); // isolated per test, never touches data/careguard.sqlite
  const app = express();
  app.use(express.json());
  app.use(createCareRecipientsRouter(store, CAREGIVER_TOKEN));
  return { app, store };
}

describe("/recipients routes (Issue #791)", () => {
  let app: express.Express;

  beforeEach(() => {
    ({ app } = makeApp());
  });

  it("rejects requests with no caregiver token", async () => {
    const res = await request(app).get("/recipients");
    expect(res.status).toBe(401);
  });

  it("rejects requests with an invalid caregiver token", async () => {
    const res = await request(app)
      .get("/recipients")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(403);
  });

  it("POST /recipients creates a recipient and GET /recipients lists it back", async () => {
    const createRes = await request(app)
      .post("/recipients")
      .set("Authorization", `Bearer ${CAREGIVER_TOKEN}`)
      .send({ name: "John Doe", age: 65, medications: ["Aspirin"], primary_doctor: "Dr. Smith", insurance: "Medicare" });

    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe("John Doe");
    expect(createRes.body.id).toMatch(/^john_doe_\d+_[0-9a-f]{8}$/);

    const listRes = await request(app)
      .get("/recipients")
      .set("Authorization", `Bearer ${CAREGIVER_TOKEN}`);

    expect(listRes.status).toBe(200);
    const created = listRes.body.find((r: any) => r.id === createRes.body.id);
    expect(created).toBeDefined();
    expect(created.name).toBe("John Doe");
    expect(created.medications).toEqual(["Aspirin"]);
    expect(created.primary_doctor).toBe("Dr. Smith");
  });

  it("rejects a malformed payload (missing name) with a structured 400", async () => {
    const res = await request(app)
      .post("/recipients")
      .set("Authorization", `Bearer ${CAREGIVER_TOKEN}`)
      .send({ age: 40 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("name is required");
  });

  it("rejects a blank name with a structured 400", async () => {
    const res = await request(app)
      .post("/recipients")
      .set("Authorization", `Bearer ${CAREGIVER_TOKEN}`)
      .send({ name: "   " });

    expect(res.status).toBe(400);
  });

  it("concurrent creates with the same name each get a distinct, persisted id", async () => {
    const requests = Array.from({ length: 5 }, () =>
      request(app)
        .post("/recipients")
        .set("Authorization", `Bearer ${CAREGIVER_TOKEN}`)
        .send({ name: "Concurrent Person" }),
    );

    const results = await Promise.all(requests);
    for (const res of results) {
      expect(res.status).toBe(201);
    }

    const ids = results.map((r) => r.body.id);
    expect(new Set(ids).size).toBe(ids.length); // no id collisions

    const listRes = await request(app)
      .get("/recipients")
      .set("Authorization", `Bearer ${CAREGIVER_TOKEN}`);
    const persisted = listRes.body.filter((r: any) => r.name === "Concurrent Person");
    expect(persisted).toHaveLength(5); // every create landed, none overwrote another
  });
});
