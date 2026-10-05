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
