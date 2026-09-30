import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { CATALOG } from "../src/accounts/catalog";
import { fromSpec, validateSpec, type ProviderSpec } from "../src/accounts/declarative";

const dir = path.join(import.meta.dir, "../src/accounts/catalog");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("provider catalog", () => {
  test("index.ts includes every JSON file, sorted by name", () => {
    expect(CATALOG.map((p) => p.id).sort()).toEqual(files.map((f) => f.slice(0, -5)).sort());
    const names = CATALOG.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  test("ids are unique", () => {
    expect(new Set(CATALOG.map((p) => p.id)).size).toBe(CATALOG.length);
  });

  for (const file of files) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as ProviderSpec;
    describe(file, () => {
      test("passes validateSpec and builds a provider", () => {
        const p = fromSpec(validateSpec(spec));
        expect(p.id).toBe(spec.id);
        expect(p.fields.length).toBeGreaterThan(0);
      });

      test("id matches the file name", () => {
        expect(`${spec.id}.json`).toBe(file);
      });

      test("has catalog metadata", () => {
        for (const key of ["description", "category", "homepage", "install", "requires"] as const) {
          expect(typeof spec[key]).toBe("string");
          expect((spec[key] as string).length).toBeGreaterThan(0);
        }
        expect(typeof spec.tested).toBe("boolean");
        expect(spec.homepage).toMatch(/^https:\/\//);
      });

      test("says whether profiles can pick it per server", () => {
        // Without env there's no per-profile pick; the description should say why.
        if (!spec.env) expect(spec.description).toMatch(/per server|per profile/);
      });
    });
  }
});
