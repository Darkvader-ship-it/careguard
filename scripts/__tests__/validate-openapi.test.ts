/**
 * OpenAPI validation tests (Issue #752).
 *
 * The point of the validator is that a broken docs/openapi.yml fails the build,
 * so these tests feed it broken inputs and assert it complains — including the
 * exact serializer bug that made the committed spec unparseable (a bare "[]" in
 * column 0 under `security:`).
 */

import { describe, it, expect } from "vitest";
import { generateSpec, specToYaml } from "../gen-openapi.ts";
import {
  validate,
  validateSpecStructure,
  validateYamlShape,
} from "../validate-openapi.ts";

describe("validate() against the checked-in spec", () => {
  it("passes for the current docs/openapi.yml", () => {
    const { errors } = validate();
    expect(errors).toEqual([]);
  });
});

describe("validateSpecStructure", () => {
  const base = () => JSON.parse(JSON.stringify(generateSpec()));

  it("accepts the generated spec", () => {
    expect(validateSpecStructure(base())).toEqual([]);
  });

  it("rejects a non-3.1 version", () => {
    const spec = base();
    spec.openapi = "3.0.0";
    expect(validateSpecStructure(spec).join(" ")).toContain("3.1");
  });

  it("rejects a missing info block", () => {
    const spec = base();
    delete spec.info.title;
    expect(validateSpecStructure(spec).join(" ")).toContain("info.title");
  });

  it("rejects an empty paths object", () => {
    const spec = base();
    spec.paths = {};
    expect(validateSpecStructure(spec).join(" ")).toContain("paths must not be empty");
  });

  it("rejects an operation with no responses", () => {
    const spec = base();
    spec.paths["/health"].get.responses = {};
    expect(validateSpecStructure(spec).join(" ")).toContain("at least one response");
  });

  it("rejects a response without a description", () => {
    const spec = base();
    spec.paths["/health"].get.responses["200"] = {};
    expect(validateSpecStructure(spec).join(" ")).toContain("description is required");
  });

  it("rejects an invalid status code", () => {
    const spec = base();
    spec.paths["/health"].get.responses["abc"] = { description: "nope" };
    expect(validateSpecStructure(spec).join(" ")).toContain("not a valid status code");
  });

  it("rejects security requirements naming an undeclared scheme", () => {
    const spec = base();
    spec.paths["/health"].get.security = [{ ApiKeyAuth: [] }];
    expect(validateSpecStructure(spec).join(" ")).toContain("unknown scheme 'ApiKeyAuth'");
  });

  it("rejects a dangling $ref", () => {
    const spec = base();
    spec.paths["/ready"].get.responses["200"].content["application/json"].schema = {
      $ref: "#/components/schemas/DoesNotExist",
    };
    expect(validateSpecStructure(spec).join(" ")).toContain("does not resolve");
  });

  it("rejects a missing security scheme definition", () => {
    const spec = base();
    spec.components.securitySchemes = {};
    expect(validateSpecStructure(spec).join(" ")).toContain("at least one scheme");
  });
});

describe("validateYamlShape", () => {
  it("accepts the generated YAML", () => {
    expect(validateYamlShape(specToYaml(generateSpec()))).toEqual([]);
  });

  it("catches container punctuation in column 0 — the bug that broke the spec", () => {
    const broken = ["openapi: '3.1.0'", "security:", "  - X402Auth:", "[]"].join("\n");
    expect(validateYamlShape(broken).join(" ")).toContain("column 0");
  });

  it("catches tab indentation", () => {
    const broken = ["openapi: '3.1.0'", "info:", "\ttitle: 'x'"].join("\n");
    expect(validateYamlShape(broken).join(" ")).toContain("tab character");
  });

  it("catches trailing whitespace", () => {
    const broken = ["openapi: '3.1.0'", "info:   "].join("\n");
    expect(validateYamlShape(broken).join(" ")).toContain("trailing whitespace");
  });

  it("requires the document to start with the openapi key", () => {
    const broken = ["info:", "  title: 'x'"].join("\n");
    expect(validateYamlShape(broken).join(" ")).toContain("line 1");
  });
});

describe("specToYaml empty containers", () => {
  it("keeps empty arrays inline after their key", () => {
    expect(specToYaml({ security: [] })).toBe("security: []");
  });

  it("keeps empty objects inline after their key", () => {
    expect(specToYaml({ details: {} })).toBe("details: {}");
  });

  it("still nests non-empty containers", () => {
    expect(specToYaml({ tags: ["Agent"] })).toBe("tags:\n  - 'Agent'");
  });

  it("emits a valid security requirement for the X402Auth scheme", () => {
    // The real-world shape that used to serialize as `- X402Auth:\n[]`.
    expect(specToYaml({ security: [{ X402Auth: [] }] })).toBe(
      "security:\n  - X402Auth: []",
    );
  });
});
