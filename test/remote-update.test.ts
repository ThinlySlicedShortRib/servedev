import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HubTracker, cleanHubId, cleanHubName, hubId, hubName, otherHubs, otherHubsWarning } from "../src/remote/hubs";
import type { Transport } from "../src/remote/transport";
import { INSTALL_PROBE, compareVersions, parseInstall, refusal, updateServedev } from "../src/remote/update";

// Real git checkouts in a temp folder, a fake servedev in them, and a "transport" that runs the
// scripts with a local shell: the scripts that would run on the machine, run for real.

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const BUN = process.execPath;
/** These run git (and bun) for real. */
const SLOW = 30_000;

function sh(cwd: string, ...argv: string[]) {
  const p = Bun.spawnSync(argv, { cwd, env: gitEnv(cwd) });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function gitEnv(home: string): Record<string, string> {
  return { PATH: "/usr/bin:/bin", HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
}

const CLI = (v: string) => `const v = "${v}";
const a = process.argv.slice(2);
if (a[0] === "--version") console.log(v);
else if (a[0] === "daemon" && a[1] === "restart") {
  require("fs").appendFileSync(process.env.RESTARTS, v + "\\n");
  console.log("daemon " + v + " running (pid 4242) at http://127.0.0.1:7777; log: x");
} else process.exit(2);
`;

const BINARY = (v: string) => `#!/bin/sh
case "$1" in
  --version) echo ${v} ;;
  daemon) echo ${v} >> "$RESTARTS"; echo "daemon ${v} running (pid 4242) at http://127.0.0.1:7777; log: x" ;;
  *) exit 2 ;;
esac
`;

const PKG = (extra = "") =>
  JSON.stringify(
    { name: "servedev", scripts: { build: "mkdir -p dist && cp src/servedev.sh dist/servedev && chmod +x dist/servedev", "build:ui": "bun scripts/build-ui.ts" }, ...(extra ? { description: extra } : {}) },
    null,
    2,
  );

/**
 * A fake npm for the real scripts/build-ui.ts: `ci` installs, `install` also rewrites the
 * lockfile (as it did on a real machine), `run build -- --outDir <dir>` "builds" ui/index.html (and fails on a broken one).
 */
const NPM = `#!/bin/sh
echo "$*" >> "$NPM_LOG"
case "$1" in
  ci) mkdir -p node_modules && echo '{}' > node_modules/.package-lock.json ;;
  install) mkdir -p node_modules && echo '{}' > node_modules/.package-lock.json && echo ' ' >> package-lock.json ;;
  run) if grep -q broken index.html; then echo "error: vite failed"; exit 1; fi
     rm -rf "$5" && mkdir -p "$5" && cp index.html "$5/index.html" && echo icon > "$5/vite.svg" ;;
  *) exit 2 ;;
esac
`;

/**
 * A servedev checkout (cloned from a bare "origin"), installed the way `kind` says, and another
 * clone to push new commits from. With `ui`, it has a dashboard (ui/), installed and built, and
 * the real scripts/build-ui.ts; with `npm`, a fake npm on PATH.
 */
function setup(kind: "source" | "binary" | "other", opts: { ui?: boolean; npm?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sd-update-")));
  dirs.push(root);
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "servedev");
  const other = path.join(root, "other");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  sh(root, "git", "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "git", "clone", "-q", origin, work);
  fs.mkdirSync(path.join(work, "src"));
  fs.writeFileSync(path.join(work, "src/cli.ts"), CLI("1.0.0"));
  fs.writeFileSync(path.join(work, "src/servedev.sh"), BINARY("1.0.0"));
  fs.writeFileSync(path.join(work, "package.json"), PKG());
  fs.writeFileSync(path.join(work, ".gitignore"), "dist\nnode_modules\nbun.lock\n");
  if (opts.ui) {
    fs.mkdirSync(path.join(work, "ui"));
    fs.mkdirSync(path.join(work, "scripts"));
    fs.copyFileSync(path.join(import.meta.dir, "../scripts/build-ui.ts"), path.join(work, "scripts/build-ui.ts"));
    fs.writeFileSync(path.join(work, "ui/index.html"), "dashboard 1\n");
    fs.writeFileSync(path.join(work, "ui/package.json"), "{}\n");
    fs.writeFileSync(path.join(work, "ui/package-lock.json"), "{}\n");
  }
  sh(work, "git", "checkout", "-q", "-b", "main");
  sh(work, "git", "add", ".");
  sh(work, "git", "commit", "-q", "-m", "First");
  sh(work, "git", "push", "-q", "-u", "origin", "main");
  sh(root, "git", "clone", "-q", origin, other);
  if (opts.ui) {
    // Set up and built there once (both ignored by git).
    fs.mkdirSync(path.join(work, "ui/node_modules"));
    fs.writeFileSync(path.join(work, "ui/node_modules/.package-lock.json"), "{}");
    fs.mkdirSync(path.join(work, "ui/dist"));
    fs.writeFileSync(path.join(work, "ui/dist/index.html"), "dashboard 1\n");
  }
  const npmBin = path.join(root, "npm-bin");
  if (opts.npm) {
    fs.mkdirSync(npmBin);
    fs.writeFileSync(path.join(npmBin, "npm"), NPM, { mode: 0o755 });
  }
  const npmLog = path.join(root, "npm-log");
  fs.writeFileSync(npmLog, "");
  const servedev = path.join(bin, "servedev");
  if (kind === "source") fs.writeFileSync(servedev, `#!/bin/sh\nexec ${BUN} ${work}/src/cli.ts "$@"\n`, { mode: 0o755 });
  else if (kind === "binary") {
    sh(work, "sh", "-c", "mkdir -p dist && cp src/servedev.sh dist/servedev && chmod +x dist/servedev");
    fs.symlinkSync(path.join(work, "dist/servedev"), servedev);
  } else fs.writeFileSync(servedev, BINARY("1.0.0"), { mode: 0o755 });
  const restarts = path.join(root, "restarts");
  fs.writeFileSync(restarts, "");
  /** A new commit on origin. */
  const push = (msg: string, files: Record<string, string>) => {
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(other, f), text);
    sh(other, "git", "commit", "-q", "-am", msg);
    sh(other, "git", "push", "-q");
  };
  // bun is only reachable through the wrapper (source) or on PATH (binary), never ~/.bun here.
  const env = { ...gitEnv(root), PATH: `${bin}:${kind === "binary" ? `${path.dirname(BUN)}:` : ""}${opts.npm ? `${npmBin}:` : ""}/usr/bin:/bin`, RESTARTS: restarts, NPM_LOG: npmLog };
  const lines = (f: string) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  return { root, work, push, env, restarts: () => lines(restarts), npmRuns: () => lines(npmLog) };
}

function localTransport(env: Record<string, string>, shell = "/bin/bash"): Transport & { scripts: string[] } {
  const scripts: string[] = [];
  return {
    kind: "posix",
    scripts,
    async run(script) {
      scripts.push(script);
      const p = Bun.spawnSync([shell, "-c", script], { env });
      return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
    },
    hold: () => {
      throw new Error("not used");
    },
    forward: async () => {},
    cancel: async () => {},
    alive: async () => true,
    close: () => {},
  };
}

for (const shell of ["/bin/bash", "/bin/zsh"].filter((s) => fs.existsSync(s))) {
  test(`finding the install (${path.basename(shell)}): a wrapper running src/cli.ts with bun is a checkout run from source`, async () => {
    const { work, env } = setup("source");
    const r = await localTransport(env, shell).run(INSTALL_PROBE);
    const i = parseInstall(r.stdout);
    expect(i).toMatchObject({ missing: false, kind: "source", entry: `${work}/src/cli.ts`, repo: work, branch: "main", upstream: "origin/main", dirty: [], bun: BUN, version: "1.0.0" });
    expect(i.head).toMatch(/^[0-9a-f]{40}$/);
    expect(refusal("pc", i)).toBeUndefined();
  }, SLOW);

  test(`updating a checkout run from source (${path.basename(shell)}): pull, install when the lockfile changed, restart`, async () => {
    const { work, push, env, restarts } = setup("source");
    const before = sh(work, "git", "rev-parse", "--short=7", "HEAD");
    push("Bump to 1.1.0", { "src/cli.ts": CLI("1.1.0") });
    push("New dependency", { "package.json": PKG("deps changed") });
    const r = await updateServedev(localTransport(env, shell), "pc", "1.1.0");
    expect(r).toMatchObject({ ok: true, kind: "source", repo: work, branch: "main", restarted: true, before: { commit: before, version: "1.0.0" }, after: { version: "1.1.0" } });
    expect(r.after?.commit).toBe(sh(work, "git", "rev-parse", "--short=7", "HEAD"));
    expect(r.commits.map((c) => c.slice(8))).toEqual(["New dependency", "Bump to 1.1.0"]);
    expect(r.done).toEqual([
      `pulled 2 commits from origin/main (${before} → ${r.after?.commit})`,
      "installed dependencies (the lockfile changed)",
      "restarted its daemon (servers keep running)",
    ]);
    // The daemon was restarted with the new code.
    expect(restarts()).toEqual(["1.1.0"]);
  }, SLOW);
}

test("updating a compiled binary in a checkout: pull, build, restart; up to date and built: just restart", async () => {
  const { work, push, env, restarts } = setup("binary");
  const t = localTransport(env);
  expect(parseInstall((await t.run(INSTALL_PROBE)).stdout)).toMatchObject({ kind: "binary", entry: `${work}/dist/servedev`, repo: work, bun: BUN });
  push("Bump to 1.2.0", { "src/servedev.sh": BINARY("1.2.0") });
  const r = await updateServedev(t, "mac", "1.2.0");
  expect(r).toMatchObject({ ok: true, kind: "binary", before: { version: "1.0.0" }, after: { version: "1.2.0" } });
  expect(r.done).toEqual([expect.stringMatching(/^pulled 1 commit from origin\/main/), `built ${work}/dist/servedev`, "restarted its daemon (servers keep running)"]);
  expect(restarts()).toEqual(["1.2.0"]);

  const again = await updateServedev(t, "mac", "1.2.0");
  expect(again.done).toEqual([`already up to date with origin/main (${again.before.commit})`, "restarted its daemon (servers keep running)"]);
  expect(again.commits).toEqual([]);
}, SLOW);

test("a checkout run from source rebuilds its own dashboard when ui/ changed, with npm ci when its lockfile did, and stays clean", async () => {
  const { work, push, env, restarts, npmRuns } = setup("source", { ui: true, npm: true });
  const t = localTransport(env);
  const dashboard = () => fs.readFileSync(path.join(work, "ui/dist/index.html"), "utf8");
  const clean = () => sh(work, "git", "status", "--porcelain");

  push("Server only", { "src/cli.ts": CLI("1.1.0") });
  const serverOnly = await updateServedev(t, "pc", "1.1.0");
  expect(serverOnly.done).toEqual([expect.stringMatching(/^pulled 1 commit/), "restarted its daemon (servers keep running)"]);
  expect(npmRuns()).toEqual([]);

  push("New dashboard", { "ui/index.html": "dashboard 2\n" });
  const r = await updateServedev(t, "pc", "1.1.0");
  expect(r.done).toEqual([expect.stringMatching(/^pulled 1 commit/), "built its own dashboard (ui/ changed)", "restarted its daemon (servers keep running)"]);
  expect(npmRuns()).toEqual(["run build -- --outDir node_modules/.dist-next --emptyOutDir"]);
  expect(dashboard()).toBe("dashboard 2\n");
  expect(fs.readdirSync(path.join(work, "ui/dist")).sort()).toEqual(["index.html", "vite.svg"]);
  expect(fs.existsSync(path.join(work, "ui/node_modules/.dist-next"))).toBe(false);

  // A new lockfile: installed with npm ci, which never rewrites it (npm install did, and the
  // next update refused the dirty checkout).
  push("New dependency", { "ui/package-lock.json": '{ "v": 2 }\n', "ui/index.html": "dashboard 3\n" });
  expect((await updateServedev(t, "pc", "1.1.0")).ok).toBe(true);
  expect(npmRuns().slice(1)).toEqual(["ci", "run build -- --outDir node_modules/.dist-next --emptyOutDir"]);
  expect(dashboard()).toBe("dashboard 3\n");
  expect(clean()).toBe("");
  expect((await updateServedev(t, "pc", "1.1.0")).ok).toBe(true);
  expect(restarts()).toEqual(["1.1.0", "1.1.0", "1.1.0", "1.1.0"]);

  // Up to date but never built (or built before the last change to ui/): built anyway.
  fs.rmSync(path.join(work, "ui/dist"), { recursive: true });
  const unbuilt = await updateServedev(t, "pc", "1.1.0");
  expect(unbuilt.done).toEqual([expect.stringMatching(/^already up to date/), "built its own dashboard (its build was older than ui/)", "restarted its daemon (servers keep running)"]);
  expect(dashboard()).toBe("dashboard 3\n");
}, SLOW);

test("without npm there, or with a dashboard build that fails, the update still restarts and says what to do", async () => {
  const noNpm = setup("source", { ui: true });
  noNpm.push("New dashboard", { "ui/index.html": "dashboard 2\n" });
  const r = await updateServedev(localTransport(noNpm.env), "pc", "1.0.0");
  expect(r).toMatchObject({ ok: true, restarted: true });
  expect(r.done[1]).toBe(`its own dashboard changed, but npm isn't on pc's login shell PATH to build it: to see it at pc's own address, run bun run build:ui in ${noNpm.work} there`);
  expect(fs.readFileSync(path.join(noNpm.work, "ui/dist/index.html"), "utf8")).toBe("dashboard 1\n");

  const broken = setup("source", { ui: true, npm: true });
  broken.push("Broken dashboard", { "ui/index.html": "broken\n" });
  const b = await updateServedev(localTransport(broken.env), "pc", "1.0.0");
  expect(b).toMatchObject({ ok: true, restarted: true });
  expect(b.done[1]).toStartWith(`building its own dashboard failed, so it still shows the old one; fix it, then run bun run build:ui in ${broken.work} there: `);
  expect(b.done[1]).toContain("error: vite failed");
  // The old build is kept.
  expect(fs.readFileSync(path.join(broken.work, "ui/dist/index.html"), "utf8")).toBe("dashboard 1\n");
}, SLOW);

test("refused before anything changes: uncommitted changes, no branch, no upstream, diverged, not a checkout", async () => {
  const dirty = setup("source");
  fs.appendFileSync(path.join(dirty.work, "src/cli.ts"), "// local edit\n");
  await expect(updateServedev(localTransport(dirty.env), "pc", "1.0.0")).rejects.toMatchObject({ status: 409, message: `${dirty.work} on pc has uncommitted changes (M src/cli.ts); commit or stash them there first.` });
  // Untracked files are fine (a pull leaves them alone).
  sh(dirty.work, "git", "checkout", "-q", "--", ".");
  fs.writeFileSync(path.join(dirty.work, "notes.txt"), "x");
  expect((await updateServedev(localTransport(dirty.env), "pc", "1.0.0")).ok).toBe(true);

  const detached = setup("source");
  sh(detached.work, "git", "checkout", "-q", "--detach");
  await expect(updateServedev(localTransport(detached.env), "pc", "1.0.0")).rejects.toThrow(/isn't on a branch \(detached at [0-9a-f]{7}\); check out the branch/);

  const local = setup("source");
  sh(local.work, "git", "checkout", "-q", "-b", "mine");
  await expect(updateServedev(localTransport(local.env), "pc", "1.0.0")).rejects.toThrow("mine in " + local.work + " on pc has no upstream branch to pull from; set one there first (git branch -u origin/mine).");

  const diverged = setup("source");
  diverged.push("Theirs", { "src/cli.ts": CLI("1.1.0") });
  fs.writeFileSync(path.join(diverged.work, "package.json"), PKG("mine"));
  sh(diverged.work, "git", "commit", "-q", "-am", "Mine");
  const head = sh(diverged.work, "git", "rev-parse", "HEAD");
  await expect(updateServedev(localTransport(diverged.env), "pc", "1.0.0")).rejects.toMatchObject({
    status: 409,
    message: `main in ${diverged.work} on pc can't fast-forward: it has 1 commit that origin/main doesn't, and origin/main has 1 it doesn't. Merge or rebase there first.`,
  });
  expect(sh(diverged.work, "git", "rev-parse", "HEAD")).toBe(head);
  expect(diverged.restarts()).toEqual([]);

  const other = setup("other");
  await expect(updateServedev(localTransport(other.env), "pc", "1.0.0")).rejects.toThrow(
    `pc runs servedev from ${other.root}/bin/servedev, so it can't be updated from here (only a git checkout run from source or built with bun run build can). Update it on pc the way it was installed, then run servedev daemon restart there and servedev remote reconnect pc here.`,
  );
}, SLOW);

test("a failed pull changes nothing; a failed build stops before the restart, saying so", async () => {
  const fake = (answers: Record<string, string | { code: number; stdout?: string }>): Transport => ({
    kind: "posix",
    run: async (script) => {
      const key = Object.keys(answers).find((k) => script.includes(k));
      const a = key === undefined ? { code: 127, stdout: "" } : answers[key];
      return typeof a === "string" ? { code: 0, stdout: a, stderr: "" } : { code: a.code, stdout: a.stdout ?? "", stderr: "" };
    },
    hold: () => {
      throw new Error("not used");
    },
    forward: async () => {},
    cancel: async () => {},
    alive: async () => true,
    close: () => {},
  });
  const probe = "@path /usr/local/bin/servedev\n@real /src/sd/dist/servedev\n@version 0.3.0\n@bun /opt/bun\n@entry /src/sd/dist/servedev\n@repo /src/sd\n@branch main\n@upstream origin/main\n@head aaaaaaaaaaaa\n";
  await expect(updateServedev(fake({ "@entry": probe, "git fetch": "@behind 2\n@ahead 0\n", "git pull": { code: 1, stdout: "fatal: Not possible to fast-forward, aborting." } }), "mac", "0.4.0")).rejects.toThrow(
    "git pull --ff-only in /src/sd on mac failed (nothing changed there): fatal: Not possible to fast-forward, aborting.",
  );
  const r = await updateServedev(
    fake({ "@entry": probe, "git fetch": "@behind 1\n@ahead 0\n", "git pull": "@head bbbbbbbbbbbb\n@commit bbbbbbb Fix\n@file src/a.ts\n", "run build": { code: 1, stdout: "error: vite failed" } }),
    "mac",
    "0.4.0",
  );
  expect(r).toMatchObject({ ok: false, restarted: false, error: "bun run build in /src/sd on mac failed: error: vite failed" });
  expect(r.hint).toContain("servedev daemon restart");
});

test("versions compare by number", () => {
  expect(compareVersions("0.10.0", "0.9.1")).toBeGreaterThan(0);
  expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
  expect(compareVersions("0.3.0", "0.3.1")).toBeLessThan(0);
});

// ---------- hubs connected to a machine ----------

test("hubs: open streams counted per hub; a change only when one comes or goes", () => {
  let t = 1000;
  const hubs = new HubTracker(() => t);
  const changes: unknown[] = [];
  hubs.on("change", (l) => changes.push(l));
  const a1 = hubs.connect("mac", "aaaa1111");
  t = 2000;
  const a2 = hubs.connect("mac", "aaaa1111");
  const b = hubs.connect("mini", "bbbb2222");
  expect(hubs.list()).toEqual([
    { name: "mac", hostname: "mac", id: "aaaa1111", since: 1000 },
    { name: "mini", hostname: "mini", id: "bbbb2222", since: 2000 },
  ]);
  a1();
  a1();
  expect(hubs.list().map((h) => h.name)).toEqual(["mac", "mini"]);
  a2();
  b();
  expect(hubs.list()).toEqual([]);
  expect(changes.length).toBe(4);
});

test("hubs: two with the same hostname count as two, shown with the start of their ids; an older one is counted by hostname", () => {
  let t = 1000;
  const hubs = new HubTracker(() => t++);
  const a = hubs.connect("mac", "aaaa1111aaaa1111");
  hubs.connect("mac", "bbbb2222bbbb2222");
  hubs.connect("mac"); // an older hub: no id
  hubs.connect("mac");
  expect(hubs.list()).toEqual([
    { name: "mac (aaaa11)", hostname: "mac", id: "aaaa1111aaaa1111", since: 1000 },
    { name: "mac (bbbb22)", hostname: "mac", id: "bbbb2222bbbb2222", since: 1001 },
    { name: "mac", hostname: "mac", id: null, since: 1002 },
  ]);
  a();
  hubs.connect("mini", "cccc3333");
  // Alone with its hostname again (the older one has no id to show): just the hostname.
  expect(hubs.list().map((h) => h.name)).toEqual(["mac (bbbb22)", "mac", "mini"]);
});

test("hubs: names and ids, the others in a machine's list, and the warning", () => {
  expect(hubName("Seans-MacBook-Pro.local")).toBe("Seans-MacBook-Pro");
  expect(cleanHubName("mac <script>")).toBe("macscript");
  expect(cleanHubName("")).toBeUndefined();
  expect(cleanHubId(" ABCDEF0123456789 ")).toBe("abcdef0123456789");
  expect(cleanHubId("mac (1234)")).toBeUndefined();
  expect(cleanHubId(null)).toBeUndefined();
  // A machine that counts by id: this hub is the entry with its id, even when another has its hostname.
  const byId = [
    { name: "mac (aaaa11)", hostname: "mac", id: "aaaa1111", since: 1 },
    { name: "mac (bbbb22)", hostname: "mac", id: "bbbb2222", since: 2 },
    { name: "mac", hostname: "mac", id: null, since: 3 },
  ];
  expect(otherHubs(byId, { name: "mac", id: "aaaa1111" })).toEqual(["mac (bbbb22)", "mac"]);
  // An older machine lists hostnames only: this hub is the one with its hostname.
  expect(otherHubs([{ name: "mac", since: 1 }, { name: "mini", since: 2 }, "junk"], { name: "mac", id: "aaaa1111" })).toEqual(["mini"]);
  // An older hub ("mac", no id) leaves out the entries named like its hostname: the other "mac" still shows.
  expect(byId.slice(1).map((h) => h.name).filter((n) => n !== "mac")).toEqual(["mac (bbbb22)"]);
  expect(otherHubs(undefined, { name: "mac" })).toEqual([]);
  expect(otherHubsWarning("pc", [])).toBeUndefined();
  expect(otherHubsWarning("pc", ["mini"])).toBe("another hub, mini, is connected to pc too: each forwards its servers' ports, so some may have other port numbers here");
  expect(otherHubsWarning("pc", ["a", "b"])).toStartWith("other hubs (a, b) are connected to pc too");
});

test("hubs: the id is made once and kept, readable only by the user", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-hubid-"));
  try {
    const file = path.join(dir, "home", "hub-id");
    const id = hubId(file);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(hubId(file)).toBe(id);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
