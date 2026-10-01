import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigConflict, ConfigStore, mergeSelections, resolveConfig } from "../src/config";
import { normalizeRemote, repoIdentity } from "../src/git";
import { applyChanges, parseJsonc } from "../src/jsonc";
import { buildMigration } from "../src/migrate-config";
import { locate } from "../src/setup";
import { Store } from "../src/store";

const dirs: string[] = [];
const stores: ConfigStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.unwatch());
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

function tmp(prefix = "sd-cfg-"): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function write(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

/** A git repo with a remote, a servedev.json, and one commit. */
function repo(config: unknown, remote = "git@github.com:Acme/App.git"): string {
  const root = tmp("sd-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", remote);
  write(path.join(root, "servedev.json"), config);
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return root;
}

function store(local: unknown): ConfigStore {
  const home = tmp("sd-home-");
  write(path.join(home, "config.json"), local);
  const s = new ConfigStore(path.join(home, "config.json"));
  stores.push(s);
  return s;
}

test("jsonc: comments and trailing commas parse; errors have a line", () => {
  expect(parseJsonc('{ // hi\n "a": [1, 2,], }').data).toEqual({ a: [1, 2] });
  expect(parseJsonc('{\n  "a": 1\n  "b": 2\n}').error).toMatchObject({ line: 3 });
});

test("jsonc: edits keep comments and touch only what changed", () => {
  const text = '{\n  // servers everyone uses\n  "servers": {\n    "api": { "command": "go run ." } // the API\n  }\n}\n';
  const before = parseJsonc(text).data as any;
  const after = structuredClone(before);
  after.servers.api.port = 8080;
  after.profiles = { Dev: { servers: ["api"] } };
  const out = applyChanges(text, before, after);
  expect(out).toContain("// servers everyone uses");
  expect(out).toContain("// the API");
  expect(parseJsonc(out).data).toEqual(after);
});

test("git: remotes normalize the same across ssh and https", () => {
  expect(normalizeRemote("git@github.com:Acme/App.git")).toBe("github.com/acme/app");
  expect(normalizeRemote("https://github.com/acme/app")).toBe("github.com/acme/app");
  expect(normalizeRemote("ssh://git@github.com/acme/app.git/")).toBe("github.com/acme/app");
});

test("resolve: repo servers, your changes on top, your own servers, pins", () => {
  const root = repo({
    servers: { api: { command: "go run .", port: 8080, env: { MODE: "dev" } }, web: { command: "vite", cwd: "web" } },
  });
  const s = store({
    projects: { app: { path: root } },
    servers: { app: { web: { port: 5173 }, worker: { command: "node worker.js", ready: "none" }, api: { hostname: null } } },
    pinned: ["app:web"],
  });
  const r = resolveConfig(s);
  expect(r.servers.get("app:api")).toMatchObject({ command: "go run .", portSpec: 8080, repoEnv: { MODE: "dev" }, source: { repo: true, local: true } });
  expect(r.servers.get("app:web")).toMatchObject({ command: "vite", cwd: path.join(root, "web"), portSpec: 5173, pinned: true, source: { repo: true, local: true } });
  expect(r.servers.get("app:worker")).toMatchObject({ ready: { mode: "none" }, source: { repo: false, local: true } });
  expect(r.projects.get("app")).toMatchObject({ repo: "github.com/acme/app", branch: "main" });
});

test("resolve: shared profiles, your overrides (accounts, skipped servers, grid), local profiles", () => {
  const root = repo({
    servers: { api: { command: "a" }, web: { command: "w" }, db: { command: "d" } },
    profiles: {
      "Full stack": { servers: ["db", "api", "web", "gone"], accounts: { gcloud: { project: "acme-dev" } }, grid: [{ i: "api", x: 0, y: 0, w: 6, h: 9 }] },
    },
  });
  const s = store({
    projects: { app: { path: root } },
    overrides: { "github.com/acme/app": { "Full stack": { accounts: { gcloud: { account: "me@x.com" } }, skip: ["db"] } } },
    profiles: { Mine: { servers: ["app:web", "api", "nope:x"] } },
  });
  const r = resolveConfig(s);
  const shared = r.profiles.find((p) => p.id === "app:Full stack")!;
  expect(shared).toMatchObject({
    kind: "shared",
    servers: ["app:api", "app:web"],
    skipped: ["app:db"],
    missing: ["app:gone"],
    accounts: { gcloud: { project: "acme-dev", account: "me@x.com" } },
    grid: { source: "repo", hasRepoDefault: true, hasOverride: false },
  });
  expect(r.grids.get("profile:app:Full stack")).toEqual([{ i: "app:api", x: 0, y: 0, w: 6, h: 9 }]);
  expect(r.issues.some((i) => i.message.includes('"gone"'))).toBe(true);
  // Local profiles take ids or unique names; unknown refs are reported, not fatal.
  expect(r.profiles.find((p) => p.id === "local:Mine")).toMatchObject({ kind: "local", servers: ["app:web", "app:api"], missing: ["nope:x"] });
});

test("resolve: a shared profile shows once per worktree; one override applies to all", () => {
  const main = repo({ servers: { api: { command: "a" } }, profiles: { Dev: { servers: ["api"] } } });
  const wt = path.join(tmp("sd-wt-"), "feat-x");
  git(main, "worktree", "add", "-q", "-b", "feat-x", wt);
  write(path.join(wt, "servedev.json"), { servers: { api: { command: "a2" }, web: { command: "w" } }, profiles: { Dev: { servers: ["api", "web"] } } });
  expect(repoIdentity(wt)).toBe(repoIdentity(main));
  const s = store({
    projects: { app: { path: main }, "feat-x": { path: wt } },
    overrides: { "github.com/acme/app": { Dev: { accounts: { github: { user: "me" } } } } },
  });
  const devs = resolveConfig(s).profiles.filter((p) => p.name === "Dev");
  expect(devs.map((p) => [p.id, p.branch, p.servers])).toEqual([
    ["app:Dev", "main", ["app:api"]],
    ["feat-x:Dev", "feat-x", ["feat-x:api", "feat-x:web"]],
  ]);
  expect(devs.every((p) => p.accounts.github?.user === "me")).toBe(true);
});

test("resolve: emails in a shared profile's accounts are flagged", () => {
  const root = repo({ servers: { api: { command: "a" } }, profiles: { Dev: { servers: ["api"], accounts: { gcloud: { account: "bob@acme.com" } } } } });
  const r = resolveConfig(store({ projects: { app: { path: root } } }));
  expect(r.issues.find((i) => i.level === "warning" && i.message.includes("looks like someone's email"))).toBeTruthy();
});

test("broken JSON keeps the last good config and reports file:line", () => {
  const root = repo({ servers: { api: { command: "a" } } });
  const s = store({ projects: { app: { path: root } } });
  expect(resolveConfig(s).servers.has("app:api")).toBe(true);
  fs.writeFileSync(path.join(root, "servedev.json"), '{\n  "servers": {\n    "api": { "command": "b" \n  }\n');
  s.refresh();
  const r = resolveConfig(s);
  expect(r.servers.get("app:api")?.command).toBe("a");
  expect(r.issues[0]).toMatchObject({ level: "error", file: path.join(root, "servedev.json") });
  expect(r.issues[0].line).toBeGreaterThan(0);
  expect(() => s.editRepo(root, (c) => (c.servers = {}))).toThrow(/syntax error at line/);
});

test("writes are atomic, keep comments, and refuse to overwrite a newer edit", () => {
  const s = store('{\n  // my setup\n  "version": 1\n}\n');
  const version = s.version(s.localFile);
  s.editLocal((c) => (c.pinned = ["a:b"]), { expect: version });
  expect(fs.readFileSync(s.localFile, "utf8")).toContain("// my setup");
  expect(() => s.editLocal((c) => (c.pinned = []), { expect: version })).toThrow(ConfigConflict);
  // Yours alone: it can hold your servers' variables.
  expect((fs.statSync(s.localFile).mode & 0o777).toString(8)).toBe("600");
  expect(fs.readdirSync(path.dirname(s.localFile)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("refresh notices edits, file replacement (git checkout) and deletion", () => {
  const root = repo({ servers: { api: { command: "a" } } });
  const s = store({ projects: { app: { path: root } } });
  const seen: string[][] = [];
  s.on("change", (files: string[]) => seen.push(files));
  const file = path.join(root, "servedev.json");
  fs.writeFileSync(`${file}.new`, JSON.stringify({ servers: { api: { command: "b" } } }));
  fs.renameSync(`${file}.new`, file);
  expect(s.refresh()).toEqual([file]);
  expect(s.repo(root).servers?.api.command).toBe("b");
  expect(s.refresh()).toEqual([]);
  fs.rmSync(file);
  expect(s.refresh()).toEqual([file]);
  expect(s.repo(root)).toEqual({});
  expect(seen.length).toBe(2);
});

test("ensureProject names folders uniquely and records the remote", () => {
  const a = repo({}, "https://github.com/acme/app");
  const b = path.join(tmp("sd-other-"), path.basename(a));
  fs.mkdirSync(b);
  const s = store({});
  const la = s.ensureProject(a);
  const lb = s.ensureProject(b);
  expect(la).toBe(path.basename(a).toLowerCase());
  expect(lb).toMatch(new RegExp(`^${la}-[0-9a-f]{4}$`));
  expect(s.local.projects?.[la]).toEqual({ path: a, remote: "github.com/acme/app" });
  expect(s.ensureProject(a)).toBe(la);
});

test("mergeSelections: field by field, empty values dropped", () => {
  expect(mergeSelections({ gcloud: { project: "p" } }, { gcloud: { account: "me", project: "" }, github: { user: "u" } })).toEqual({
    gcloud: { project: "p", account: "me" },
    github: { user: "u" },
  });
});

test("setup finds a moved repo by remote; a worktree needs its own folder", () => {
  const scan = {
    repos: [
      { path: "/new/code/app", remote: "github.com/acme/app", worktree: false },
      { path: "/new/code/app-wt/feat-x", remote: "github.com/acme/app", worktree: true },
    ],
    folders: new Map<string, string[]>(),
  };
  expect(locate("app", { path: "/old/app", remote: "github.com/acme/app" }, scan)).toMatchObject({ status: "found", path: "/new/code/app", how: "remote" });
  expect(locate("feat-x", { path: "/old/.worktrees/feat-x", remote: "github.com/acme/app", worktree: "feat-x" }, scan)).toMatchObject({ status: "found", how: "worktree" });
  expect(locate("feat-y", { path: "/old/app-feat-y", remote: "github.com/acme/app", worktree: "feat-y" }, scan)).toMatchObject({
    status: "missing",
    reason: expect.stringContaining("worktree add"),
  });
  expect(locate("lib", { path: "/old/lib", remote: "github.com/acme/lib" }, scan)).toMatchObject({ status: "missing" });
});

test("migration: servers, profiles, grids, pins and settings move from SQLite to config.json", () => {
  const root = repo({ servers: { api: { command: "go run .", port: 8080 } } });
  const dbFile = path.join(tmp("sd-db-"), "servedev.db");
  const st = new Store(dbFile);
  const now = Date.now();
  const add = (name: string, extra: Record<string, unknown>) =>
    st.db
      .query(
        `INSERT INTO servers (id, name, project, root, command, setup, cwd, env, port_spec, ready, pinned, hostname, restarts, created_at, updated_at)
         VALUES ($id, $name, 'app', $root, $command, $setup, $cwd, $env, $port, $ready, $pinned, $hostname, 0, $now, $now)`,
      )
      .run({ $id: `app:${name}`, $name: name, $root: root, $command: "x", $setup: null, $cwd: root, $env: "{}", $port: null, $ready: "{}", $pinned: 0, $hostname: null, $now: now, ...extra });
  add("api", { $command: "go run .", $port: "8080", $hostname: "api.localhost", $pinned: 1 });
  add("web", { $command: "pnpm dev", $cwd: path.join(root, "web"), $env: '{"DEBUG":"1"}', $ready: '{"mode":"none"}' });
  st.db.exec(`INSERT INTO profiles (id, name, accounts, created_at) VALUES (4, 'Stack', '{"gcloud":{"account":"me@x.com"}}', 0);
              INSERT INTO profile_servers VALUES (4, 'app:web', 0), (4, 'app:api', 1);
              INSERT INTO layouts VALUES ('profile:4', '[{"i":"app:web","x":0,"y":0,"w":6,"h":9}]', 0);
              INSERT INTO layouts VALUES ('draft', '[{"i":"app:api","x":6,"y":0,"w":6,"h":9}]', 0);
              INSERT INTO settings VALUES ('log_retention_days', '14'), ('meta:x', '1');`);
  const { config, report } = buildMigration(st.db as Database, {}, (r) => JSON.parse(fs.readFileSync(path.join(r, "servedev.json"), "utf8")));
  expect(config.projects).toEqual({ app: { path: root, remote: "github.com/acme/app" } });
  // api is in servedev.json: only what the database added is kept (the hostname).
  expect(config.servers).toEqual({ app: { api: { hostname: "api.localhost" }, web: { command: "pnpm dev", cwd: "web", ready: "none", env: { DEBUG: "1" } } } });
  expect(config.profiles).toEqual({ Stack: { servers: ["app:web", "app:api"], accounts: { gcloud: { account: "me@x.com" } }, grid: [{ i: "app:web", x: 0, y: 0, w: 6, h: 9 }] } });
  expect(config.grid).toEqual([{ i: "app:api", x: 6, y: 0, w: 6, h: 9 }]);
  expect(config.pinned).toEqual(["app:api"]);
  expect(config.settings).toEqual({ log_retention_days: 14 });
  expect(report.profileIds).toEqual({ "4": "local:Stack" });
  // Already in config.json wins (e.g. copied from another machine); running it again changes nothing.
  const again = buildMigration(st.db as Database, config, () => ({}));
  expect(again.config).toEqual(config);
  st.close();
});

test("jsonc: adding a property doesn't reformat its neighbours; short lists stay inline", () => {
  const text = '{\n  "servers": {\n    "web": { "command": "node server.js", "cwd": "web" } // web\n  }\n}\n';
  const before = parseJsonc(text).data as any;
  const after = structuredClone(before);
  after.servers.extra = { command: "sleep 1" };
  after.profiles = { A: { servers: ["web", "extra"] } };
  const out = applyChanges(text, before, after);
  expect(out).toContain('"web": { "command": "node server.js", "cwd": "web" }, // web\n');
  expect(out).toContain('"servers": ["web", "extra"]');
  expect(parseJsonc(out).data).toEqual(after);
});

test("migration: credentials on a command line don't move into config.json", () => {
  const root = repo({});
  const st = new Store(path.join(tmp("sd-db-"), "servedev.db"));
  const now = Date.now();
  st.db
    .query(
      `INSERT INTO servers (id, name, project, root, command, setup, cwd, env, port_spec, ready, pinned, hostname, restarts, created_at, updated_at)
       VALUES ('app:proxy', 'proxy', 'app', $root, $command, NULL, $root, '{}', NULL, '{}', 0, NULL, 0, $now, $now)`,
    )
    .run({ $root: root, $command: "cloud-sql-proxy --token=ya29.FAKEFAKEFAKEFAKEFAKE proj:region:db --port=5433", $now: now });
  const { config, report } = buildMigration(st.db as Database, {}, () => ({}));
  expect(config.servers?.app?.proxy?.command).toBe("cloud-sql-proxy proj:region:db --port=5433");
  expect(report.notes.join("\n")).toContain("--token");
  st.close();
});
