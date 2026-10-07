import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The Manager reads SERVEDEV_HOME when it's imported, so each case runs it in a child process with a home of its own.
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

async function stopWith(stop: string): Promise<{ status: string; log: string; dir: string }> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sd-stop-")));
  dirs.push(dir);
  const script = `
    const { Manager, serverAlive } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/manager.ts"))});
    const m = new Manager();
    const { server } = await m.start({
      project: "p", root: ${JSON.stringify(dir)}, name: "svc", command: "sleep 30", cwd: ${JSON.stringify(dir)},
      env: { MARK: "from-env" }, ready: { mode: "none" }, stop: ${JSON.stringify(stop)},
    });
    await m.waitReady(server.id, 5000);
    const s = await m.stop(server.id);
    m.saveNow();
    console.log(JSON.stringify({ status: s.status, alive: serverAlive(s), log: require("node:fs").readFileSync(s.logFile, "utf8") }));
    process.exit(0);
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, SERVEDEV_HOME: path.join(dir, ".home") }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (!out.trim()) throw new Error(err);
  const r = JSON.parse(out.trim().split("\n").at(-1)!);
  expect(r.alive).toBe(false);
  return { status: r.status, log: r.log, dir };
}

test("a stop command runs in the server's folder with its env, logged, before signals", async () => {
  const { status, log, dir } = await stopWith('echo "$MARK" > marker && echo bye');
  expect(status).toBe("stopped");
  expect(fs.readFileSync(path.join(dir, "marker"), "utf8").trim()).toBe("from-env");
  expect(log).toContain(`[servedev] $ echo "$MARK" > marker && echo bye\nbye\n`);
  expect(log).not.toContain("stopping with signals");
});

test("a failing stop command falls back to signals and says so in the log", async () => {
  const { status, log } = await stopWith("exit 3");
  expect(status).toBe("stopped");
  expect(log).toContain("[servedev] stop command exited with code 3; stopping with signals");
});

/** Runs `script` against a fresh Manager in a child process (one daemon's lifetime) with its home under `dir`; returns its last line, parsed. */
async function daemon(dir: string, script: string): Promise<any> {
  const code = `
    const { Manager, serverAlive } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/manager.ts"))});
    const m = new Manager();
    ${script}
    process.exit(0);
  `;
  const proc = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, SERVEDEV_HOME: path.join(dir, ".home") }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (!out.trim()) throw new Error(err);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

function stopEnvRows(dir: string): (string | null)[] {
  const db = new Database(path.join(dir, ".home", "servedev.db"), { readonly: true });
  try {
    return (db.query("SELECT stop_env FROM runs ORDER BY id").all() as { stop_env: string | null }[]).map((r) => r.stop_env);
  } finally {
    db.close();
  }
}

/** The first daemon starts "svc" with a profile's account variable and goes away, leaving it running. */
async function startAndLeave(dir: string, stop?: string): Promise<{ id: string; pid: number }> {
  return daemon(
    dir,
    `const { server } = await m.start({
       project: "p", root: ${JSON.stringify(dir)}, name: "svc", command: "sleep 30", cwd: ${JSON.stringify(dir)},
       env: { MARK: "from-env" }, accountEnv: { CLOUDSDK_CORE_PROJECT: "acct-proj" }, ready: { mode: "none" },
       stop: ${JSON.stringify(stop)},
     });
     await m.waitReady(server.id, 5000);
     m.saveNow();
     console.log(JSON.stringify({ id: server.id, pid: server.pid }));`,
  );
}

test("after a daemon restart, a stop command still gets the run's account variables, deleted once it's stopped", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sd-stop-")));
  dirs.push(dir);
  const started = await startAndLeave(dir, 'echo "$MARK $CLOUDSDK_CORE_PROJECT" > marker');
  try {
    // Only the account variables are kept (the rest can be rebuilt), in a database only the user can read.
    expect(stopEnvRows(dir)).toEqual([JSON.stringify({ CLOUDSDK_CORE_PROJECT: "acct-proj" })]);
    expect(fs.statSync(path.join(dir, ".home", "servedev.db")).mode & 0o777).toBe(0o600);

    // A new daemon adopts it, applies the config (where the stop command comes from), and stops it.
    const r = await daemon(
      dir,
      `const s0 = m.servers.get(${JSON.stringify(started.id)});
       const adopted = s0.status;
       m.sync([{ id: s0.id, project: "p", name: "svc", root: s0.root, command: "sleep 30", cwd: s0.cwd, env: { MARK: "from-env" },
         stop: 'echo "$MARK $CLOUDSDK_CORE_PROJECT" > marker', ready: { mode: "none" }, pinned: false, source: { repo: false, local: true } }]);
       const s = await m.stop(s0.id);
       m.saveNow();
       console.log(JSON.stringify({ adopted, status: s.status, alive: serverAlive(s), servers: JSON.stringify(m.list()) }));`,
    );
    expect(r.adopted).toBe("running");
    expect(r.status).toBe("stopped");
    expect(r.alive).toBe(false);
    expect(fs.readFileSync(path.join(dir, "marker"), "utf8").trim()).toBe("from-env acct-proj");
    // Never part of a server (what the API and dashboard get), and gone once the run is over.
    expect(r.servers).not.toContain("acct-proj");
    expect(stopEnvRows(dir)).toEqual([null]);
  } finally {
    try {
      process.kill(-started.pid, "SIGKILL");
    } catch {}
  }
});

test("a run without a stop command doesn't save its account variables", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sd-stop-")));
  dirs.push(dir);
  const started = await startAndLeave(dir);
  try {
    expect(stopEnvRows(dir)).toEqual([null]);
  } finally {
    try {
      process.kill(-started.pid, "SIGKILL");
    } catch {}
  }
});
