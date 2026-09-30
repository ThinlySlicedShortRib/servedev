import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRESETS, clean, parseDuration, queryLines, searchLines } from "../src/logs";
import { discoverGroups, parseLsof, parsePs } from "../src/ports";
import { detectPackageManager, planInstall } from "../src/install";
import { detectCommand, findRoot } from "../src/project";
import { programName } from "../src/daemon";

test("clean strips ANSI and collapses carriage returns", () => {
  expect(clean("\x1b[32mready\x1b[0m\nprogress 10%\rprogress 100%\r\n")).toBe("ready\nprogress 100%\n");
});

test("queryLines filters, tails and caps", () => {
  const raw = Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? `ERROR ${i}` : `line ${i}`)).join("\n") + "\n";
  expect(queryLines(raw, { tail: 3 }).lines).toEqual(["line 97", "line 98", "line 99"]);
  const errs = queryLines(raw, { grep: "error", tail: 2 });
  expect(errs.lines).toEqual(["ERROR 80", "ERROR 90"]);
  expect(errs.total).toBe(10);
  expect(queryLines(raw, { grep: "(", tail: 5 }).lines).toEqual([]); // invalid regex falls back to literal
  expect(queryLines(raw, { tail: 100, maxChars: 30 }).truncated).toBe(true);
});

test("parseDuration", () => {
  expect(parseDuration("30s")).toBe(30_000);
  expect(parseDuration("2m")).toBe(120_000);
  expect(parseDuration("90")).toBe(90_000);
  expect(() => parseDuration("soon")).toThrow();
});

test("parseLsof", () => {
  const out = "p100\ng100\ncnode\nf20\nn*:3000\nf21\nn[::1]:3000\np200\ng150\ncpython3\nf4\nn127.0.0.1:8000\n";
  expect(parseLsof(out)).toEqual([
    { pid: 100, pgid: 100, command: "node", port: 3000 },
    { pid: 200, pgid: 150, command: "python3", port: 8000 },
  ]);
});

test("detectCommand picks package manager and port flag", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  const sub = path.join(dir, "src");
  fs.mkdirSync(sub);
  expect(findRoot(sub)).toBe(dir);
  expect(detectCommand(dir, dir)).toMatchObject({ command: "pnpm run dev", portArgs: " --port {port}" });
  fs.rmSync(path.join(dir, "pnpm-lock.yaml"));
  expect(detectCommand(dir, dir)).toMatchObject({ command: "npm run dev", portArgs: " -- --port {port}" });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
  expect(detectCommand(dir, dir)).toMatchObject({ command: "npm run start", portArgs: undefined });
  fs.rmSync(dir, { recursive: true });
});

test("detectPackageManager prefers packageManager and pnpm workspaces over nearer lockfiles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-"));
  const app = path.join(root, "apps", "web");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  fs.writeFileSync(path.join(app, "package-lock.json"), "{}"); // per-app lockfile kept for CI
  expect(detectPackageManager(app, root)).toBe("npm");
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  expect(detectPackageManager(app, root)).toBe("pnpm");
  expect(detectCommand(app, root)).toMatchObject({ command: "pnpm run dev", portArgs: " --port {port}" });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.5.0" }));
  expect(detectPackageManager(app, root)).toBe("yarn");
  fs.rmSync(root, { recursive: true });
});

test("planInstall installs at the workspace root and tracks pnpm lockfile changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-"));
  const app = path.join(root, "apps", "web");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  fs.writeFileSync(path.join(app, "package-lock.json"), "{}");

  let plan = planInstall(app, root)!;
  expect(plan).toMatchObject({ pm: "pnpm", dir: root, state: "missing" });
  expect(plan.reason).toContain("pnpm-workspace.yaml");
  expect(plan.setup).toBe(`(cd '${root}' && pnpm install --config.confirmModulesPurge=false)`);

  fs.mkdirSync(path.join(root, "node_modules", ".pnpm"), { recursive: true });
  fs.copyFileSync(path.join(root, "pnpm-lock.yaml"), path.join(root, "node_modules", ".pnpm", "lock.yaml"));
  expect(planInstall(app, root)!.state).toBe("ok");
  fs.appendFileSync(path.join(root, "pnpm-lock.yaml"), "packages: {}\n");
  expect(planInstall(app, root)!.state).toBe("stale");

  expect(planInstall(path.join(root, "apps"), root)).toBeUndefined(); // no package.json there
  fs.rmSync(root, { recursive: true });
});

test("planInstall uses npm's hidden lockfile timestamp", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { vite: "^7.0.0" } }));
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
  expect(planInstall(dir, dir)).toMatchObject({ pm: "npm", dir, setup: "npm install", state: "missing" });
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", ".package-lock.json"), "{}");
  const t = Date.now() / 1000;
  fs.utimesSync(path.join(dir, "node_modules", ".package-lock.json"), t - 60, t - 60);
  expect(planInstall(dir, dir)!.state).toBe("stale");
  fs.utimesSync(path.join(dir, "node_modules", ".package-lock.json"), t + 5, t + 5);
  expect(planInstall(dir, dir)!.state).toBe("ok");
  fs.rmSync(dir, { recursive: true });
});

test("searchLines merges overlapping context and respects limit and fromLine", () => {
  const text = ["a", "ERR one", "b", "c", "ERR two", "d", "e", "f", "g", "ERR three", "h"].join("\n");
  const re = /ERR/;
  const r = searchLines(text, re, { context: 1 });
  expect(r.total).toBe(3);
  expect(r.blocks.map((b) => b.lines.map((l) => `${l.n}${l.match ? ":" : "-"}`).join(" "))).toEqual([
    "1- 2: 3- 4- 5: 6-", // adjacent ranges join, as in grep
    "9- 10: 11-",
  ]);
  expect(searchLines(text, re, { context: 3 }).blocks.length).toBe(1);
  expect(searchLines(text, re, { context: 0, limit: 1 }).blocks[0].lines).toEqual([{ n: 10, text: "ERR three", match: true }]);
  expect(searchLines(text, re, { context: 0, fromLine: 5 }).total).toBe(2);
});

test("errors preset is case-aware", () => {
  const hits = ["Email: x", "listen EADDRINUSE: :::3000", "Found 0 errors", "TypeError: x is undefined", "exited with code 1", "exit code 0", "errorBoundary.tsx compiled", " ERROR  (node:1) [DEP0205] DeprecationWarning: module.register() is deprecated"].filter((l) =>
    PRESETS.errors.test(l),
  );
  expect(hits).toEqual(["listen EADDRINUSE: :::3000", "TypeError: x is undefined", "exited with code 1"]);
});

test("discoverGroups follows the process tree into groups created by children (turbo)", () => {
  const table = parsePs(`
  100     1   100 pnpm run dev
  101   100   100 turbo run dev
  102   101   200 pnpm --filter web dev
  103   102   200 next dev
  104   103   200 next-server
  300     1   300 unrelated
  105     1   200 orphaned child of a dead middle process`);
  expect(discoverGroups(100, [], table).sort()).toEqual([100, 200]);
  // Known groups are kept even when their leader is gone.
  expect(discoverGroups(100, [100, 200], parsePs("  105     1   200 orphan")).sort()).toEqual([100, 200]);
  expect(discoverGroups(100, [], table)).not.toContain(300);
});

test("programName names the program behind interpreters", () => {
  expect(programName("node /Users/x/node_modules/.bin/../turbo/bin/turbo run dev")).toBe("turbo");
  expect(programName("node /opt/homebrew/bin/pnpm run dev")).toBe("pnpm");
  expect(programName("/x/@turbo/darwin-arm64/bin/turbo run dev")).toBe("turbo");
  expect(programName("next-server (v15.5.26)")).toBe("next-server");
  expect(programName("node --inspect server.js")).toBe("node");
});

test("planInstall has nothing to do when package.json lists no dependencies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
  expect(planInstall(dir, dir)).toMatchObject({ state: "ok", detail: "package.json lists no dependencies." });
  fs.rmSync(dir, { recursive: true });
});
