import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fromSpec, validateSpec, type ProviderSpec } from "../src/accounts/declarative";
import { errorText } from "../src/accounts/exec";
import { AccountRegistry } from "../src/accounts/registry";

// No test here runs gcloud or gh: providers are fakes built from sh commands in a temp dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-accounts-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const base = (extra: Partial<ProviderSpec> = {}): ProviderSpec => ({
  id: "fake",
  name: "Fake",
  fields: [{ id: "account", label: "Account", options: ["a"] }],
  ...extra,
});

describe("validateSpec", () => {
  const bad: [string, unknown, RegExp][] = [
    ["not an object", 42, /JSON object/],
    ["bad id", { ...base(), id: "Fake Cloud" }, /"id" must be lowercase/],
    ["no name", { ...base(), name: "" }, /"name" is required/],
    ["no fields", { ...base(), fields: [] }, /at least one field/],
    ["field without id", { ...base(), fields: [{ label: "X", options: [] }] }, /needs an "id"/],
    ["field without label", { ...base(), fields: [{ id: "x", options: [] }] }, /needs a "label"/],
    ["field without choices", { ...base(), fields: [{ id: "x", label: "X" }] }, /needs "list"/],
    ["env with unknown field", base({ env: { A: "{nope}" } }), /\{nope\}, which isn't a field/],
    ["env of wrong type", base({ env: { A: 1 as unknown as string } }), /must be a string or/],
    ["action without command", base({ actions: { x: { label: "X", description: "" } as never } }), /needs "label" and "command"/],
  ];
  for (const [name, spec, err] of bad) test(name, () => expect(() => validateSpec(spec)).toThrow(err));

  test("accepts a freeform field with no list", () => {
    expect(validateSpec(base({ fields: [{ id: "x", label: "X", freeform: true }] })).id).toBe("fake");
  });
});

describe("fromSpec", () => {
  const state = path.join(tmp, "fake-current");
  const spec = validateSpec({
    id: "fake",
    name: "Fake",
    fields: [
      {
        id: "account",
        label: "Account",
        list: "printf 'alice\\tAlice\\nbob\\tBob\\tadmin\\n\\ncarol\\n'",
        current: `cat ${state} 2>/dev/null || echo alice`,
        set: `printf %s {account} > ${state}`,
      },
      { id: "region", label: "Region", options: ["eu", { value: "us", label: "United States" }] },
    ],
    env: {
      FAKE_ACCOUNT: "{account}",
      FAKE_WHERE: "{account}@{region}",
      FAKE_TOKEN: { command: "echo token-for-{account}" },
    },
    actions: { hello: { label: "Hello", description: "Says hello", command: "echo hello {name}" } },
  });
  const p = fromSpec(spec);
  const [account, region] = p.fields;

  test("parses list output: value, tab, label, tab, detail; skips blank lines", async () => {
    expect(await account.options({})).toEqual([
      { value: "alice", label: "Alice", detail: undefined },
      { value: "bob", label: "Bob", detail: "admin" },
      { value: "carol", label: undefined, detail: undefined },
    ]);
  });

  test("fixed options", async () => {
    expect(await region.options({})).toEqual([{ value: "eu" }, { value: "us", label: "United States" }]);
    expect(region.set).toBeUndefined();
  });

  test("current, then set shell-quotes values with quotes and spaces", async () => {
    expect(await account.current()).toBe("alice");
    await account.set!(`bob it's "me"; echo pwned`);
    expect(fs.readFileSync(state, "utf8")).toBe(`bob it's "me"; echo pwned`);
    expect(await account.current()).toBe(`bob it's "me"; echo pwned`);
  });

  test("env: templates inserted raw, command values run, missing placeholders skipped", async () => {
    expect(await p.env!({ account: "bob", region: "eu" })).toEqual({ FAKE_ACCOUNT: "bob", FAKE_WHERE: "bob@eu", FAKE_TOKEN: "token-for-bob" });
    expect(await p.env!({ account: "bob" })).toEqual({ FAKE_ACCOUNT: "bob", FAKE_TOKEN: "token-for-bob" });
    expect(await p.env!({})).toEqual({});
  });

  test("actions fill args and return output", async () => {
    expect(await p.actions!.hello.run({ name: "world" })).toBe("hello world");
  });

  test("requires: unavailable when the command isn't on PATH", async () => {
    expect(await fromSpec(base({ requires: "sh" })).available()).toBe(true);
    expect(await fromSpec(base({ requires: "definitely-not-a-command-xyz" })).available()).toBe(false);
  });

  test("failing commands throw the CLI's error line", async () => {
    const broken = fromSpec(validateSpec(base({ fields: [{ id: "a", label: "A", list: "echo 'warning: meh' >&2; echo 'error: no creds' >&2; exit 3" }] })));
    await expect(broken.fields[0].options({})).rejects.toThrow(/^no creds$/);
  });
});

describe("AccountRegistry", () => {
  const dir = path.join(tmp, "providers");
  let reg: AccountRegistry;

  beforeAll(async () => {
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "fake.json"),
      JSON.stringify({ id: "fake", name: "Fake", fields: [{ id: "account", label: "Account", options: ["a", "b"] }], env: { FAKE: "{account}" } }),
    );
    // Same id as the built-in gcloud: replaces it, so nothing here runs the real gcloud.
    fs.writeFileSync(
      path.join(dir, "gcloud.ts"),
      `export default {
        id: "gcloud", name: "My Cloud", available: async () => true,
        fields: [{ id: "account", label: "Account", options: async () => [], current: async () => undefined }],
        env: async (s) => { if (s.account === "broken") throw new Error("no credentials"); return { MY_CLOUD: s.account ?? "" }; },
      };`,
    );
    fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ id: "Bad" }));
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
    reg = new AccountRegistry(dir);
    await reg.load();
  });

  test("loads JSON and TS providers; bad files become errors", () => {
    const ids = reg.all().map((p) => p.id);
    expect(ids).toContain("fake");
    expect(ids).toContain("github");
    expect(reg.errors).toHaveLength(1);
    expect(reg.errors[0].file).toEndWith("bad.json");
    expect(reg.errors[0].message).toMatch(/"id" must be lowercase/);
  });

  test("a user provider replaces the built-in with the same id", () => {
    expect(reg.all().filter((p) => p.id === "gcloud")).toHaveLength(1);
    const g = reg.get("gcloud");
    expect(g.name).toBe("My Cloud");
    expect(g.source).toEndWith("gcloud.ts");
    expect(reg.get("fake").source).toEndWith("fake.json");
  });

  test("get() names the known providers", () => {
    expect(() => reg.get("nope")).toThrow(/no account provider "nope"\. Known: .*fake/);
  });

  test("normalize() checks providers and fields and drops empty values", () => {
    expect(reg.normalize(null)).toEqual({});
    expect(reg.normalize({ fake: { account: " b " }, gcloud: { account: "" }, github: null })).toEqual({ fake: { account: "b" } });
    expect(() => reg.normalize({ nope: { account: "x" } })).toThrow(/no account provider "nope"/);
    expect(() => reg.normalize({ fake: { region: "x" } })).toThrow(/Fake has no field "region"/);
    expect(() => reg.normalize("gcloud")).toThrow(/accounts must be an object/);
  });

  test("env() merges providers and prefixes errors with the provider's name", async () => {
    expect(await reg.env({ fake: { account: "a" }, gcloud: { account: "me" } })).toEqual({ FAKE: "a", MY_CLOUD: "me" });
    await expect(reg.env({ gcloud: { account: "broken" } })).rejects.toThrow("My Cloud: no credentials");
  });

  test("set() refuses fields with no machine-wide switch", async () => {
    await expect(reg.set("fake", "account", "a")).rejects.toThrow(/can't be switched machine-wide/);
  });
});

describe("errorText", () => {
  test("starts at gcloud's ERROR line, dropping warnings and the prefix", () => {
    const out = [
      "WARNING: Your active project does not match the quota project.",
      "",
      "ERROR: (gcloud.config.set) There was a problem refreshing your current auth tokens: Reauthentication failed.",
      "Please run:",
      "",
      "  $ gcloud auth login",
    ].join("\n");
    expect(errorText(out)).toBe("There was a problem refreshing your current auth tokens: Reauthentication failed. Please run: $ gcloud auth login");
  });

  test("lowercase error: lines (gh, docker) lose the prefix too", () => {
    expect(errorText("some noise\nerror: context \"x\" not found")).toBe('context "x" not found');
  });

  test("without an error line, the last three lines", () => {
    expect(errorText("a\nb\nc\nd\n")).toBe("b c d");
  });
});

describe("adding platforms", () => {
  const dir = path.join(tmp, "add-providers");
  const reg = new AccountRegistry(dir);
  const spec: ProviderSpec = {
    id: "fly",
    name: "Fly",
    requires: "sh",
    fields: [{ id: "org", label: "Org", list: "printf 'personal\\nwork\\n'", current: "echo personal", set: "true {org}" }],
    env: { FLY_ORG: "{org}", FLY_TOKEN: { command: "echo token-for-{org}" } },
  };

  test("saveSpec writes a private JSON file and loads it", async () => {
    const r = await reg.saveSpec(spec);
    expect(r.file).toBe(path.join(dir, "fly.json"));
    expect(fs.statSync(r.file).mode & 0o777).toBe(0o600);
    expect(reg.get("fly").name).toBe("Fly");
    const state = await reg.state(reg.get("fly"));
    expect(state.editable).toBe(true);
    expect(state.removable).toBe(true);
  });

  test("an existing id needs replace; a built-in id needs override", async () => {
    await expect(reg.saveSpec(spec)).rejects.toThrow(/already exists/);
    await reg.saveSpec({ ...spec, name: "Fly 2" }, { replace: true });
    expect(reg.get("fly").name).toBe("Fly 2");
    await expect(reg.saveSpec({ ...spec, id: "gcloud" })).rejects.toThrow(/built-in/);
    await reg.saveSpec({ ...spec, id: "gcloud", name: "My gcloud" }, { override: true });
    expect(reg.get("gcloud").name).toBe("My gcloud");
  });

  test("specOf and removeSpec only touch JSON files in the folder", async () => {
    expect((await reg.specOf("fly")).spec.name).toBe("Fly 2");
    await expect(reg.specOf("github")).rejects.toThrow(/built in/);
    await expect(reg.removeSpec("github")).rejects.toThrow(/can't be removed/);
    expect((await reg.removeSpec("gcloud")).restoredBuiltIn).toBe(true);
    expect(reg.get("gcloud").name).toBe("Google Cloud");
    await reg.removeSpec("fly");
    expect(() => reg.get("fly")).toThrow(/no account provider/);
  });

  test("testSpec runs list/current, masks env, and never saves", async () => {
    const r = await reg.testSpec(spec);
    expect(r.valid).toBe(true);
    expect(r.fields[0].current).toBe("personal");
    expect(r.fields[0].options?.map((o) => o.value)).toEqual(["personal", "work"]);
    expect(r.env?.find((e) => e.name === "FLY_TOKEN")?.preview).toMatch(/^toke… \(\d+ chars\)$/);
    expect((await reg.testSpec(spec, { org: "work" })).env?.find((e) => e.name === "FLY_ORG")?.preview).toBe("wo…");
    expect(fs.existsSync(path.join(dir, "fly.json"))).toBe(false);
    expect((await reg.testSpec({ ...spec, requires: "no-such-cli-xyz" })).requires?.found).toBe(false);
    const bad = await reg.testSpec({ id: "x", name: "X", fields: [] });
    expect(bad.valid).toBe(false);
    expect(bad.error).toMatch(/at least one field/);
  });

  test("the catalog lists every entry with installed/added flags", async () => {
    const entries = await reg.catalog();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e.installed).toBe("boolean");
      expect(typeof e.added).toBe("boolean");
      expect(() => validateSpec(e.spec)).not.toThrow();
    }
    expect(() => reg.catalogSpec("nope")).toThrow(/no catalog entry/);
  });
});
