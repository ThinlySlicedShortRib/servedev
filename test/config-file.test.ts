import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigConflict, ConfigStore } from "../src/config";
import { configState as stateOf, mergedEntry, planSave as plan, serverToConfig } from "../src/config-file";
import type { Server } from "../src/manager";
import { loadConfig } from "../src/project";

// What the daemon does for "Save to servedev.json", through the watched config store.
const stores: ConfigStore[] = [];
function storeFor(root: string) {
  const store = new ConfigStore(path.join(root, ".local-config.json"));
  stores.push(store);
  return store;
}
const current = (s: Server) => {
  try {
    return loadConfig(s.root).servers?.[s.name];
  } catch {
    return undefined;
  }
};
const configState = (s: Server) => stateOf(s, current(s));
const planSave = (s: Server) => plan(s, current(s));
function saveToConfig(s: Server, opts: { force?: boolean } = {}) {
  const store = storeFor(s.root);
  const p = plan(s, store.repo(s.root).servers?.[s.name]);
  if (p.state === "defined") return { ...p, written: false };
  if (p.state === "differs" && !opts.force) throw new ConfigConflict("differs");
  store.editRepo(s.root, (c) => ((c.servers ??= {})[s.name] = mergedEntry(p)));
  return { ...p, written: true };
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function project(config?: unknown, raw?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sd-config-"));
  dirs.push(root);
  if (raw !== undefined) fs.writeFileSync(path.join(root, "servedev.json"), raw);
  else if (config) fs.writeFileSync(path.join(root, "servedev.json"), JSON.stringify(config, null, 2));
  return root;
}

function server(root: string, over: Partial<Server> = {}): Server {
  return {
    id: `p:${over.name ?? "web"}`,
    name: "web",
    project: "p",
    root,
    command: "pnpm dev",
    cwd: path.join(root, "apps/web"),
    env: {},
    ready: {},
    status: "running",
    ports: [],
    logFile: "",
    restarts: 0,
    ...over,
  } as Server;
}

describe("serverToConfig", () => {
  test("relative cwd, ready forms, and secrets left out unless asked", () => {
    const root = project();
    const s = server(root, { setup: "pnpm install", portSpec: "auto", hostname: "web.localhost", ready: { log: "ready in" }, env: { DEBUG: "1", API_TOKEN: "x" } });
    const { entry, omittedSecrets } = serverToConfig(s);
    expect(entry).toEqual({ command: "pnpm dev", setup: "pnpm install", cwd: "apps/web", port: "auto", hostname: "web.localhost", ready: { log: "ready in" }, env: { DEBUG: "1" } });
    expect(omittedSecrets).toEqual(["API_TOKEN"]);
    expect(serverToConfig(s, { includeSecrets: true }).entry.env).toEqual({ DEBUG: "1", API_TOKEN: "x" });
    expect(serverToConfig(server(root, { cwd: root, ready: { mode: "none" } })).entry).toEqual({ command: "pnpm dev", ready: "none" });
  });

  test("a stop command is written and compared like the command", () => {
    const root = project({ servers: { web: { command: "docker compose up", cwd: "apps/web" } } });
    const s = server(root, { command: "docker compose up", stop: "docker compose down" });
    expect(serverToConfig(s).entry).toEqual({ command: "docker compose up", stop: "docker compose down", cwd: "apps/web" });
    expect(planSave(s).changes).toEqual([{ key: "stop", before: undefined, after: "docker compose down" }]);
    expect(configState(s)).toBe("differs");
  });
});

describe("saveToConfig", () => {
  test("creates the file, then reports it as defined", () => {
    const root = project();
    const s = server(root);
    expect(configState(s)).toBe("missing");
    const r = saveToConfig(s);
    expect(r.written).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, "servedev.json"), "utf8"))).toEqual({
      $schema: expect.stringContaining("servedev.schema.json"),
      servers: { web: { command: "pnpm dev", cwd: "apps/web" } },
    });
    expect(configState(s)).toBe("defined");
    expect(saveToConfig(s).written).toBe(false);
  });

  test("keeps other servers, unmanaged keys, and the file's indentation; replacing needs force", () => {
    const raw = JSON.stringify({ $schema: "x", servers: { api: { command: "go run ." }, web: { command: "npm start", timeout: 90, dependsOn: ["api"] } } }, null, 4);
    const root = project(undefined, raw);
    const s = server(root);
    expect(configState(s)).toBe("differs");
    expect(planSave(s).changes.map((c) => c.key)).toEqual(["command", "cwd"]);
    expect(() => saveToConfig(s)).toThrow(ConfigConflict);
    saveToConfig(s, { force: true });
    const text = fs.readFileSync(path.join(root, "servedev.json"), "utf8");
    expect(text).toContain('\n    "servers"');
    expect(JSON.parse(text)).toEqual({
      $schema: "x",
      servers: { api: { command: "go run ." }, web: { command: "pnpm dev", cwd: "apps/web", timeout: 90, dependsOn: ["api"] } },
    });
  });

  test("a server started from servedev.json (its env applied underneath) counts as defined", () => {
    const root = project({ servers: { web: { command: "pnpm dev", cwd: "apps/web/", env: { A: "1" }, ready: { mode: "port" } } } });
    expect(configState(server(root))).toBe("defined");
    expect(configState(server(root, { env: { B: "2" } }))).toBe("differs");
  });

  test("refuses to overwrite a servedev.json that isn't valid JSON", () => {
    const root = project(undefined, "{ nope");
    expect(() => saveToConfig(server(root))).toThrow(/syntax error at line 1/);
  });
});

test("secret-looking variables left out on purpose don't count as drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sd-config-"));
  dirs.push(root);
  const s = { ...server(root), env: { DEBUG: "1", API_TOKEN: "x" } } as Server;
  saveToConfig(s);
  expect(configState(s)).toBe("defined");
});

test("saving never writes credentials from the command, and makes tool paths portable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sd-config-"));
  dirs.push(root);
  const which = (b: string) => (b === "pnpm" || b === "cloud-sql-proxy" ? `/opt/homebrew/bin/${b}` : null);
  const proxy = serverToConfig(
    { ...server(root), cwd: root, command: "/opt/homebrew/bin/cloud-sql-proxy --auto-iam-authn --token=ya29.a0AbCdEfGhIjKlMnOp --login-token=ya29.QrStUvWxYz0123 p:r:db --port=5437" } as Server,
    { which },
  );
  expect(proxy.entry.command).toBe("cloud-sql-proxy --auto-iam-authn p:r:db --port=5437");
  expect(proxy.removed).toEqual(["--token (a credential)", "--login-token (a credential)"]);
  const studio = serverToConfig({ ...server(root), command: "node /opt/homebrew/bin/pnpm --filter api db:studio" } as Server, { which });
  expect(studio.entry.command).toBe("pnpm --filter api db:studio");
  expect(JSON.stringify(proxy)).not.toContain("ya29.a0");
});

test("editRepo keeps unknown keys, comments and tab indentation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sd-config-"));
  dirs.push(root);
  fs.writeFileSync(path.join(root, "servedev.json"), '{\n\t// ours\n\t"profiles": {"a": {"servers": []}},\n\t"servers": {}\n}\n');
  storeFor(root).editRepo(root, (c) => (c.servers!.web = { command: "x" }));
  const text = fs.readFileSync(path.join(root, "servedev.json"), "utf8");
  expect(text).toContain('\t// ours\n\t"profiles"');
  expect(loadConfig(root)).toEqual({ profiles: { a: { servers: [] } }, servers: { web: { command: "x" } } });
});
