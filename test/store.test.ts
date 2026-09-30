import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "../src/manager";
import { Store, runLogFile } from "../src/store";

function server(id: string): Server {
  return {
    id,
    name: id.split(":")[1],
    project: id.split(":")[0],
    root: "/tmp/p",
    command: "npm run dev",
    cwd: "/tmp/p",
    env: { A: "1" },
    ready: {},
    status: "starting",
    ports: [],
    logFile: "",
    restarts: 0,
  };
}

test("store keeps runs, previous run, marks, and purges old logs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-db-"));
  const store = new Store(path.join(dir, "db.sqlite"));
  expect(store.isEmpty()).toBe(true);

  const s = server("p:web");
  store.saveServer(s);
  const day = 86_400_000;
  const now = Date.now();
  const logs: string[] = [];
  for (const [i, age] of [10, 3, 0].entries()) {
    s.runId = store.insertRun(s.id, s.command, now - age * day - 1000);
    s.logFile = runLogFile(dir, s.id, s.runId);
    fs.mkdirSync(path.dirname(s.logFile), { recursive: true });
    fs.writeFileSync(s.logFile, `run ${i}\n`);
    logs.push(s.logFile);
    s.status = age ? "stopped" : "running";
    s.stoppedAt = age ? now - age * day : undefined;
    store.saveServer(s);
  }

  const loaded = store.loadServers();
  expect(loaded).toHaveLength(1);
  expect(loaded[0]).toMatchObject({ id: "p:web", status: "running", runId: s.runId, env: { A: "1" } });
  expect(store.runs(s.id).map((r) => r.status)).toEqual(["running", "stopped", "stopped"]);
  expect(store.previousRun(s.id, s.runId)?.logFile).toBe(logs[1]);

  store.addMark(s.runId!, now - 60_000, 100);
  store.addMark(s.runId!, now - 5_000, 400);
  expect(store.offsetBefore(s.runId!, now - 30_000)).toBe(100);
  expect(store.offsetBefore(s.runId!, now - 120_000)).toBe(0);

  expect(store.purgeRunsBefore(now - 7 * day)).toBe(1); // only the 10-day-old run
  expect(fs.existsSync(logs[0])).toBe(false);
  expect(fs.existsSync(logs[1])).toBe(true);
  expect(store.runs(s.id)).toHaveLength(2);

  // A stopped server's last run keeps its row (so the UI shows how it ended) but loses the log.
  s.status = "stopped";
  s.stoppedAt = now - 9 * day;
  store.saveServer(s);
  store.purgeRunsBefore(now - 7 * day);
  expect(store.run(s.runId!)).toMatchObject({ status: "stopped", logFile: "" });
  expect(store.runs(s.id)).toHaveLength(2); // the 3-day-old run is still inside the window

  // A run left "stopping" when a newer run exists gets closed at the newer run's start.
  const orphan = store.insertRun(s.id, s.command, now - 1000);
  store.db.query("UPDATE runs SET status = 'stopping' WHERE id = ?").run(orphan);
  const newer = store.insertRun(s.id, s.command, now);
  s.runId = newer;
  store.saveServer(s);
  store.closeOrphanedRuns();
  expect(store.run(orphan)).toMatchObject({ status: "stopped", stoppedAt: now });

  store.deleteServer(s.id);
  expect(store.isEmpty()).toBe(true);
  store.close();
  fs.rmSync(dir, { recursive: true });
});

