import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DirError, isHiddenDir, listDirs, resolveDirPath } from "../src/dirs";
import type { PublicServer } from "../src/manager";
import { TOOLS, machineRef } from "../src/mcp";
import { remoteFolder } from "../src/ops";
import { VERSION } from "../src/paths";
import { RemoteApiError } from "../src/remote/api";
import { assertRemotePath, isMissingEndpoint, remoteStartBody, tooOld, type RemoteFolder } from "../src/remote/create";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-dirs-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// ---------- /api/dirs ----------

test("dir paths: ~ is home, relative paths are from home, .. and // are normalized", () => {
  const home = "/home/me";
  expect(resolveDirPath("", home)).toBe(home);
  expect(resolveDirPath("  ~ ", home)).toBe(home);
  expect(resolveDirPath("~/code/app/", home)).toBe("/home/me/code/app");
  expect(resolveDirPath("code", home)).toBe("/home/me/code");
  expect(resolveDirPath("/mnt/c/Users/x/../y//z", home)).toBe("/mnt/c/Users/y/z");
  // .. can't climb above /, and the answer says where it really is.
  expect(resolveDirPath("/../../etc", home)).toBe("/etc");
  expect(resolveDirPath("~/../../..", home)).toBe("/");
  expect(() => resolveDirPath("~root/x", home)).toThrow(/only ~/);
  expect(() => resolveDirPath("/tmp/\0x", home)).toThrow(DirError);
});

test("dirs: subfolders only, sorted, with project markers; hidden ones counted, not listed", async () => {
  const d = tmp();
  for (const sub of ["web", "api", "Docs", ".cache", "node_modules", "app10", "app9"]) fs.mkdirSync(path.join(d, sub));
  fs.writeFileSync(path.join(d, "web", "package.json"), "{}");
  fs.writeFileSync(path.join(d, "api", "servedev.json"), "{}");
  fs.mkdirSync(path.join(d, "api", ".git"));
  fs.writeFileSync(path.join(d, "Docs", ".git"), "gitdir: elsewhere"); // a worktree
  fs.writeFileSync(path.join(d, "secret.txt"), "never listed");
  fs.writeFileSync(path.join(d, "package.json"), "{}");
  fs.symlinkSync(path.join(d, "web"), path.join(d, "web-link"));
  fs.symlinkSync(path.join(d, "secret.txt"), path.join(d, "file-link"));
  fs.symlinkSync(path.join(d, "gone"), path.join(d, "dangling"));

  const r = await listDirs(d, { home: d });
  expect(r.path).toBe(d);
  expect(r.parent).toBe(path.dirname(d));
  expect(r.package).toBe(true);
  expect(r.dirs.map((x) => x.name)).toEqual(["api", "app9", "app10", "Docs", "web", "web-link"]);
  expect(r.dirs.find((x) => x.name === "api")).toEqual({ name: "api", path: path.join(d, "api"), servedev: true, git: true });
  expect(r.dirs.find((x) => x.name === "web")).toMatchObject({ package: true });
  expect(r.dirs.find((x) => x.name === "Docs")).toMatchObject({ git: true });
  expect(r.dirs.find((x) => x.name === "web-link")).toMatchObject({ link: true, package: true });
  expect(r.hidden).toBe(2);
  expect(JSON.stringify(r)).not.toContain("never listed");
  expect(JSON.stringify(r)).not.toContain("secret.txt");

  const all = await listDirs(d, { home: d, hidden: true });
  expect(all.dirs.map((x) => x.name)).toContain(".cache");
  expect(all.dirs.map((x) => x.name)).toContain("node_modules");
  expect(all.hidden).toBe(0);

  const few = await listDirs(d, { home: d, limit: 2 });
  expect(few.dirs.map((x) => x.name)).toEqual(["api", "app9"]);
  expect(few.truncated).toBe(true);

  // "~/web/.." from a home of d is d itself.
  expect((await listDirs("~/web/..", { home: d })).path).toBe(d);
  expect(isHiddenDir(".git")).toBe(true);
  expect(isHiddenDir("src")).toBe(false);
});

test("dirs: clear errors for a missing folder, a file, and the filesystem root has no parent", async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "f"), "x");
  await expect(listDirs(path.join(d, "nope"))).rejects.toMatchObject({ status: 404, message: expect.stringContaining("no folder at") });
  await expect(listDirs(path.join(d, "f"))).rejects.toMatchObject({ status: 400 });
  const root = await listDirs("/", { limit: 1 });
  expect(root.path).toBe("/");
  expect(root.parent).toBeUndefined();
});

// ---------- starting on another machine ----------

const known = [{ id: "demo:api", name: "api", project: "demo", root: "/home/pc/demo", cwd: "/home/pc/demo/api", status: "stopped", ports: [] }] as unknown as PublicServer[];

function deps(folders: Record<string, RemoteFolder> = {}) {
  const asked: string[] = [];
  return {
    asked,
    deps: {
      machine: "pc",
      servers: known,
      inspect: async (dir: string) => {
        asked.push(dir);
        return folders[dir] ?? { dir: dir.replace(/^~/, "/home/pc"), exists: false };
      },
    },
  };
}

test("a new server on a machine: the folder is looked up there, and only start options go along", async () => {
  const { deps: d, asked } = deps({ "~/code/app": { dir: "/home/pc/code/app", exists: true, root: "/home/pc/code" } });
  const body = await remoteStartBody(d, {
    name: "web",
    dir: "~/code/app",
    command: "python3 -m http.server {port}",
    port: "auto",
    install: true,
    ready: { log: "Serving" },
    vars: { DEBUG: "1" },
    // Never sent: this machine's paths and environment.
    root: "/Users/me/here",
    clientCwd: "/Users/me/here",
    env: { PATH: "/opt/homebrew/bin" },
    machine: "pc",
  });
  expect(asked).toEqual(["~/code/app"]);
  expect(body).toEqual({
    name: "web",
    root: "/home/pc/code",
    clientCwd: "/home/pc/code/app",
    command: "python3 -m http.server {port}",
    port: "auto",
    install: true,
    ready: { log: "Serving" },
    vars: { DEBUG: "1" },
  });
  // No name: the remote picks one from the folder, like a local start does.
  expect(await remoteStartBody(d, { dir: "~/code/app" })).toEqual({ root: "/home/pc/code", clientCwd: "/home/pc/code/app" });
});

test("starting on a machine: known servers by name or id, helpful errors otherwise", async () => {
  const { deps: d } = deps();
  expect(await remoteStartBody(d, { name: "api", restart: true })).toEqual({ id: "demo:api", clientCwd: "/home/pc/demo/api", restart: true });
  expect(await remoteStartBody(d, { name: "demo:api", command: "x" })).toEqual({ id: "demo:api", clientCwd: "/home/pc/demo/api", command: "x" });
  await expect(remoteStartBody(d, { name: "web" })).rejects.toMatchObject({ status: 404, message: expect.stringContaining("--on pc --dir") });
  await expect(remoteStartBody(d, {})).rejects.toMatchObject({ status: 400 });
  await expect(remoteStartBody(d, { name: "web", dir: "~/nope" })).rejects.toMatchObject({ status: 404, message: "no folder at /home/pc/nope on pc" });
  // Relative paths would depend on the remote daemon's cwd.
  await expect(remoteStartBody(d, { name: "web", dir: "code/app" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("absolute path or one starting with ~/") });
  expect(() => assertRemotePath("pc", "/mnt/c/Users/x")).not.toThrow();
});

test("a ~ working directory is expanded on the machine", async () => {
  const { deps: d, asked } = deps({ "~/code/app": { dir: "/home/pc/code/app", exists: true, root: "/home/pc/code" }, "~/code/app/web": { dir: "/home/pc/code/app/web", exists: true } });
  const body = await remoteStartBody(d, { name: "web", dir: "~/code/app", cwd: "~/code/app/web" });
  expect(body.cwd).toBe("/home/pc/code/app/web");
  expect(asked).toEqual(["~/code/app/web", "~/code/app"]);
});

test("an older servedev on the machine: its missing endpoint becomes a clear message", () => {
  expect(isMissingEndpoint(new RemoteApiError(404, "not found: GET /api/dirs"))).toBe(true);
  expect(isMissingEndpoint(new RemoteApiError(404, "no folder at /x"))).toBe(false);
  expect(isMissingEndpoint(new Error("not found: GET /api/dirs"))).toBe(false);
  const e = tooOld("pc", "0.2.0", "0.3.0", "list its folders");
  expect(e.status).toBe(501);
  expect(e.message).toBe("pc runs servedev 0.2.0, which can't list its folders; update it (this machine runs 0.3.0).");
});

test("a folder under this machine's home (the shell expanded ~) means the same place under the home there", () => {
  expect(remoteFolder("/Users/me/code/app", "/Users/me")).toBe("~/code/app");
  expect(remoteFolder("/Users/me", "/Users/me")).toBe("~");
  expect(remoteFolder("/Users/meg/x", "/Users/me")).toBe("/Users/meg/x");
  expect(remoteFolder("/mnt/c/code", "/Users/me")).toBe("/mnt/c/code");
  expect(remoteFolder("~/x", "/Users/me")).toBe("~/x");
});

// ---------- MCP ----------

test("MCP: server tools take a machine; machines have their own tools", () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const name of ["start_server", "stop_server", "restart_server", "remove_server", "server_status", "server_logs", "search_logs", "server_runs", "list_servers", "inspect_folder", "list_folders"]) {
    const props = (byName.get(name)?.inputSchema as { properties: Record<string, { type?: string }> }).properties;
    expect(props.machine?.type).toBe("string");
  }
  const start = (byName.get("start_server")!.inputSchema as { properties: Record<string, unknown> }).properties;
  expect(start.dir).toBeDefined();
  expect(byName.get("list_machines")).toBeDefined();
  expect((byName.get("reconnect_machine")!.inputSchema as { required?: string[] }).required).toEqual(["machine"]);
  // Every schema is a plain JSON Schema object (clients reject anything else).
  for (const t of TOOLS) {
    expect(t.inputSchema.type).toBe("object");
    expect(JSON.parse(JSON.stringify(t.inputSchema))).toEqual(t.inputSchema);
  }
  expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
});

test("MCP: a name plus machine becomes a pc/ reference", () => {
  expect(machineRef("api", "pc")).toBe("pc/api");
  expect(machineRef("pc/demo:api", "pc")).toBe("pc/demo:api");
  expect(machineRef("api", undefined)).toBe("api");
  expect(machineRef("api", "")).toBe("api");
  expect(() => machineRef(undefined, "pc")).toThrow(/name on pc/);
  expect(() => machineRef("box/api", "pc")).toThrow(/isn't on pc/);
});

// ---------- CLI ----------

/** Run the CLI against a fake daemon that records what it's asked. */
async function cli(args: string[], reply: (path: string, body: any) => unknown, userHome = tmp()) {
  const home = tmp();
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  fs.writeFileSync(path.join(home, "token"), "t0k");
  const calls: { path: string; body: any }[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") return Response.json({ ok: true, version: VERSION, pid: 1 });
      if (req.headers.get("x-servedev-token") !== "t0k") return Response.json({ error: "bad token" }, { status: 401 });
      const body = req.method === "POST" ? await req.json() : Object.fromEntries(url.searchParams);
      calls.push({ path: url.pathname, body });
      return Response.json(reply(url.pathname, body));
    },
  });
  cleanups.push(() => srv.stop(true));
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env, SERVEDEV_HOME: home, SERVEDEV_PORT: String(srv.port), HOME: userHome },
    cwd: userHome,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { calls, out, err, code, userHome };
}

const started = {
  server: {
    id: "pc/code:web",
    name: "web",
    project: "code",
    status: "running",
    ports: [8000],
    url: "http://127.0.0.1:8000",
    remoteUrl: "http://localhost:8000",
    customUrl: "http://web.pc.localhost:7780",
    machine: "pc",
    pid: 5,
    startedAt: Date.now() - 1000,
    readyAt: Date.now(),
  },
  alreadyRunning: false,
  ready: { ok: true },
};

test("CLI: start --on <machine> --dir <path there> -- <command> sends a remote create with the start options", async () => {
  const r = await cli(
    ["start", "web", "--on", "pc", "--dir", "/mnt/c/code/app", "--port", "auto", "--install", "--ready-log", "Serving", "--env", "A=1", "--", "python3", "-m", "http.server", "{port}"],
    () => started,
  );
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0].path).toBe("/api/start");
  expect(r.calls[0].body).toEqual({
    machine: "pc",
    name: "web",
    dir: "/mnt/c/code/app",
    command: "python3 -m http.server '{port}'",
    install: true,
    port: "auto",
    ready: { log: "Serving" },
    wait: true,
    vars: { A: "1" },
  });
  expect(r.out).toContain("web is ready at http://web.pc.localhost:7780");
  expect(r.out).toContain("on pc (localhost:8000 there)");
});

test("CLI: a pc/ name works without --on; a folder under home here goes as ~ there", async () => {
  const userHome = tmp();
  const r = await cli(["start", "pc/web", "--dir", path.join(userHome, "code"), "--no-wait"], () => ({ ...started, ready: undefined }), userHome);
  expect(r.calls[0].body).toMatchObject({ machine: "pc", name: "web", dir: "~/code", wait: false });
  expect(r.out).toContain("web is starting (id pc/code:web");
  const r2 = await cli(["start", "web", "--on", "pc", "--dir", "/srv/app"], () => started);
  expect(r2.calls[0].body.dir).toBe("/srv/app");
  const r3 = await cli(["start", "box/web", "--on", "pc"], () => started);
  expect(r3.code).toBe(1);
  expect(r3.err).toContain("box/web is on box, not pc");
});

test("CLI: dirs --on asks the machine; a local --dir starts as if run in that folder", async () => {
  const r = await cli(["dirs", "~/code", "--on", "pc"], () => ({ path: "/home/pc/code", home: "/home/pc", dirs: [{ name: "app", path: "/home/pc/code/app", package: true }], hidden: 1, machine: "pc" }));
  expect(r.calls[0]).toEqual({ path: "/api/dirs", body: { path: "~/code", machine: "pc" } });
  expect(r.out).toContain("/home/pc/code on pc: 1 folder, 1 hidden");
  expect(r.out).toContain("app/  [package.json]");

  const local = await cli(["start", "web", "--dir", "proj", "--", "x"], () => ({ ...started, server: { ...started.server, id: "proj:web", machine: undefined, customUrl: undefined } }));
  // (the folder doesn't exist in this test, so nothing is sent)
  expect(local.calls).toHaveLength(0);
  expect(local.err).toContain("no folder at");
});
