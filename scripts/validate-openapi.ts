/**
 * Validate docs/openapi.yml so a broken spec fails the build.
 *
 * Three checks, in order of what they catch:
 *   1. Structure  — the generated spec object has the fields OpenAPI 3.1 and
 *                   our consumers require (info, servers, paths, responses,
 *                   resolvable security schemes and $refs).
 *   2. Serialization — the emitted YAML has no malformed lines. A bare "[]" or
 *                   "{}" in column 0 previously made the whole document
 *                   unparseable; that class of bug is caught here.
 *   3. Drift      — the checked-in docs/openapi.yml matches what the generator
 *                   produces today, so the spec cannot go stale silently.
 *
 * Run: npm run validate:openapi
 * CI:  .github/workflows/openapi.yml (also runs a full 3.1 lint via Redocly)
 */

import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { generateSpec, specToYaml } from "./gen-openapi.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.resolve(__dirname, "../docs/openapi.yml");

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/** Structural checks against the spec object the generator builds. */
export function validateSpecStructure(spec: Record<string, any>): string[] {
  const errors: string[] = [];

  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.1")) {
    errors.push(`openapi must be a 3.1.x version string (got ${JSON.stringify(spec.openapi)})`);
  }
  if (!spec.info?.title) errors.push("info.title is required");
  if (!spec.info?.version) errors.push("info.version is required");
  if (!Array.isArray(spec.servers) || spec.servers.length === 0) {
    errors.push("at least one server entry is required");
  }

  const schemes = spec.components?.securitySchemes ?? {};
  if (Object.keys(schemes).length === 0) {
    errors.push("components.securitySchemes must define at least one scheme");
  }

  const knownSchemes = new Set(Object.keys(schemes));
  const schemaNames = new Set(Object.keys(spec.components?.schemas ?? {}));

  const checkSecurity = (requirements: unknown, where: string) => {
    if (requirements === undefined) return;
    if (!Array.isArray(requirements)) {
      errors.push(`${where}: security must be an array`);
      return;
    }
    for (const requirement of requirements) {
      for (const name of Object.keys(requirement ?? {})) {
        if (!knownSchemes.has(name)) {
          errors.push(`${where}: security references unknown scheme '${name}'`);
        }
      }
    }
  };

  checkSecurity(spec.security, "root");

  const paths = spec.paths ?? {};
  if (Object.keys(paths).length === 0) errors.push("paths must not be empty");

  for (const [route, methods] of Object.entries<Record<string, any>>(paths)) {
    if (!route.startsWith("/")) errors.push(`path '${route}' must start with '/'`);

    for (const [method, operation] of Object.entries(methods ?? {})) {
      const where = `${method.toUpperCase()} ${route}`;
      if (!operation?.summary) errors.push(`${where}: summary is required`);

      const responses = operation?.responses ?? {};
      if (Object.keys(responses).length === 0) {
        errors.push(`${where}: at least one response is required`);
      }
      for (const [status, response] of Object.entries<Record<string, any>>(responses)) {
        if (!/^[1-5]\d{2}$/.test(String(status))) {
          errors.push(`${where}: '${status}' is not a valid status code`);
        }
        if (!response?.description) {
          errors.push(`${where} ${status}: description is required`);
        }
      }

      checkSecurity(operation?.security, where);
    }
  }

  // Every local $ref must resolve to a declared component schema.
  const refs: string[] = [];
  const collectRefs = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(collectRefs);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "$ref" && typeof value === "string") refs.push(value);
        else collectRefs(value);
      }
    }
  };
  collectRefs(spec);

  for (const ref of refs) {
    const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
    if (!match) {
      errors.push(`unsupported $ref '${ref}' (only #/components/schemas/* is used)`);
      continue;
    }
    if (!schemaNames.has(match[1])) errors.push(`$ref '${ref}' does not resolve`);
  }

  return errors;
}

/**
 * Line-level checks on the emitted YAML. These catch serializer bugs that a
 * structural check cannot see, because the object is fine and only its
 * rendering is broken.
 */
export function validateYamlShape(yaml: string): string[] {
  const errors: string[] = [];
  const lines = yaml.split("\n");

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (line.includes("\t")) {
      errors.push(`line ${lineNo}: tab character (YAML forbids tabs for indentation)`);
    }
    if (/^[[{\]}]/.test(line)) {
      errors.push(`line ${lineNo}: container punctuation in column 0 — '${line.trim()}'`);
    }
    if (/\s+$/.test(line)) {
      errors.push(`line ${lineNo}: trailing whitespace`);
    }
  });

  if (!lines[0]?.startsWith("openapi:")) {
    errors.push("line 1: document must start with the openapi version key");
  }

  return errors;
}

export function validate(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const spec = generateSpec();
  errors.push(...validateSpecStructure(spec as unknown as Record<string, any>));

  const generated = specToYaml(spec);
  errors.push(...validateYamlShape(generated));

  if (!existsSync(SPEC_PATH)) {
    errors.push("docs/openapi.yml is missing — run `npm run gen-openapi`");
    return { errors, warnings };
  }

  const onDisk = readFileSync(SPEC_PATH, "utf-8");
  errors.push(...validateYamlShape(onDisk));

  if (onDisk.trim() !== generated.trim()) {
    errors.push(
      "docs/openapi.yml is out of date with scripts/gen-openapi.ts — run `npm run gen-openapi` and commit the result",
    );
  }

  return { errors, warnings };
}

function main() {
  const { errors, warnings } = validate();

  for (const warning of warnings) console.warn(`warning: ${warning}`);

  if (errors.length > 0) {
    console.error(`✗ OpenAPI validation failed (${errors.length} error(s)):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log("✓ docs/openapi.yml is valid and in sync with scripts/gen-openapi.ts");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
