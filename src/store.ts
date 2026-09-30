/**
 * SQLite persistence: server definitions, one row per run, log write-time marks (for --since
 * across daemon restarts), and settings. Log text itself stays in files, one per run.
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Selections } from "./accounts/registry";
import type { Server, Status } from "./manager";
import type { ReadySpec } from "./project";

export interface Run {
  id: number;
  serverId: string;
  command: string;
  status: Status;
  pid?: number;
  port?: number;
  url?: string;
  exitCode?: number | null;
  error?: string;
  startedAt: number;
  readyAt?: number;
  stoppedAt?: number;
  logFile: string;
}

export const SETTINGS = {
  log_retention_days: { default: "7", describe: "Delete logs of runs that stopped more than this many days ago." },
  proxy_port: {
    default: "80",
    describe: "Port for custom hostnames like keel.localhost. 80 gives URLs without a port; falls back to 7780 when 80 is taken.",
  },
} as const;
export type SettingKey = keyof typeof SETTINGS;

const MIGRATIONS = [
  `CREATE TABLE servers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     project TEXT NOT NULL,
     root TEXT NOT NULL,
     command TEXT NOT NULL,
     setup TEXT,
     cwd TEXT NOT NULL,
     env TEXT NOT NULL,
     port_spec TEXT,
     ready TEXT NOT NULL,
     pinned INTEGER NOT NULL DEFAULT 0,
     restarts INTEGER NOT NULL DEFAULT 0,
     current_run_id INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
     command TEXT NOT NULL,
     status TEXT NOT NULL,
     pid INTEGER,
     port INTEGER,
     ports TEXT NOT NULL DEFAULT '[]',
     url TEXT,
     exit_code INTEGER,
     error TEXT,
     started_at INTEGER NOT NULL,
     ready_at INTEGER,
     stopped_at INTEGER,
     log_file TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX runs_by_server ON runs(server_id, started_at DESC);
   CREATE INDEX runs_by_stop ON runs(stopped_at);
   CREATE TABLE log_marks (
     run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     t INTEGER NOT NULL,
     offset INTEGER NOT NULL
   );
   CREATE INDEX log_marks_by_run ON log_marks(run_id, t);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE TABLE profiles (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE profile_servers (
     profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
     server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     PRIMARY KEY (profile_id, server_id)
   );`,
  // Process groups of a run (turbo & co. create groups of their own).
  `ALTER TABLE runs ADD COLUMN pgids TEXT NOT NULL DEFAULT '[]';`,
  // Custom hostname (e.g. keel.localhost) served by the daemon's proxy.
  `ALTER TABLE servers ADD COLUMN hostname TEXT;
   CREATE UNIQUE INDEX servers_by_hostname ON servers(hostname) WHERE hostname IS NOT NULL;`,
  // Dashboard grid layouts, one per scope ("all" or "profile:<id>").
  `CREATE TABLE layouts (scope TEXT PRIMARY KEY, items TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  // Platform accounts: a profile's picks (by provider), and what a server's current run started with.
  `ALTER TABLE profiles ADD COLUMN accounts TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE servers ADD COLUMN accounts TEXT;`,
];

/** A tile in the dashboard grid: server id, position/size in grid units, and what it shows. */
export interface LayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mode?: "logs" | "preview";
}

export interface Profile {
  id: number;
  name: string;
  /** Server ids in start order. */
  servers: string[];
  /** Accounts its servers use instead of the machine's, by provider id, e.g. { gcloud: { account: "me@x.com" } }. */
  accounts: Selections;
}

type Row = Record<string, any>;

const toRun = (r: Row): Run => ({
  id: r.id,
  serverId: r.server_id,
  command: r.command,
  status: r.status,
  pid: r.pid ?? undefined,
  port: r.port ?? undefined,
  url: r.url ?? undefined,
  exitCode: r.exit_code,
  error: r.error ?? undefined,
  startedAt: r.started_at,
  readyAt: r.ready_at ?? undefined,
  stoppedAt: r.stopped_at ?? undefined,
  logFile: r.log_file,
});

export class Store {
  db: Database;

  constructor(file: string) {
    const fresh = !fs.existsSync(file);
    this.db = new Database(file, { create: true });
    if (fresh) fs.chmodSync(file, 0o600); // env vars can hold secrets
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate() {
    const version = (this.db.query("PRAGMA user_version").get() as Row).user_version as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  isEmpty(): boolean {
    return !this.db.query("SELECT 1 FROM servers LIMIT 1").get();
  }

  // ---------- servers ----------

  /** Servers joined with their current run, in the in-memory shape the manager uses. */
  loadServers(): Server[] {
    const rows = this.db
      .query(
        `SELECT s.*, r.id AS run_id, r.status, r.pid, r.port, r.ports, r.url, r.exit_code, r.error,
                r.started_at, r.ready_at, r.stopped_at, r.log_file, r.pgids
           FROM servers s LEFT JOIN runs r ON r.id = s.current_run_id`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      project: r.project,
      root: r.root,
      command: r.command,
      setup: r.setup ?? undefined,
      cwd: r.cwd,
      env: JSON.parse(r.env),
      portSpec: r.port_spec == null ? undefined : JSON.parse(r.port_spec),
      ready: JSON.parse(r.ready) as ReadySpec,
      pinned: !!r.pinned,
      hostname: r.hostname ?? undefined,
      accounts: r.accounts ? JSON.parse(r.accounts) : undefined,
      restarts: r.restarts,
      runId: r.run_id ?? undefined,
      status: (r.status ?? "stopped") as Status,
      pid: r.pid ?? undefined,
      port: r.port ?? undefined,
      ports: r.ports ? JSON.parse(r.ports) : [],
      url: r.url ?? undefined,
      exitCode: r.exit_code,
      error: r.error ?? undefined,
      startedAt: r.started_at ?? undefined,
      readyAt: r.ready_at ?? undefined,
      stoppedAt: r.stopped_at ?? undefined,
      logFile: r.log_file ?? "",
      pgids: r.pgids ? JSON.parse(r.pgids) : [],
    }));
  }

  /** Write a server's definition and its current run's state. */
  saveServer(s: Server) {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO servers (id, name, project, root, command, setup, cwd, env, port_spec, ready, pinned, hostname, accounts, restarts, current_run_id, created_at, updated_at)
         VALUES ($id, $name, $project, $root, $command, $setup, $cwd, $env, $port_spec, $ready, $pinned, $hostname, $accounts, $restarts, $run, $now, $now)
         ON CONFLICT(id) DO UPDATE SET name = $name, project = $project, root = $root, command = $command, setup = $setup,
           cwd = $cwd, env = $env, port_spec = $port_spec, ready = $ready, pinned = $pinned, hostname = $hostname,
           accounts = $accounts, restarts = $restarts, current_run_id = $run, updated_at = $now`,
      )
      .run({
        $id: s.id,
        $name: s.name,
        $project: s.project,
        $root: s.root,
        $command: s.command,
        $setup: s.setup ?? null,
        $cwd: s.cwd,
        $env: JSON.stringify(s.env),
        $port_spec: s.portSpec === undefined ? null : JSON.stringify(s.portSpec),
        $ready: JSON.stringify(s.ready),
        $pinned: s.pinned ? 1 : 0,
        $hostname: s.hostname ?? null,
        $accounts: s.accounts ? JSON.stringify(s.accounts) : null,
        $restarts: s.restarts,
        $run: s.runId ?? null,
        $now: now,
      });
    if (s.runId) {
      this.db
        .query(
          `UPDATE runs SET status = $status, pid = $pid, port = $port, ports = $ports, url = $url, exit_code = $exit,
             error = $error, ready_at = $ready_at, stopped_at = $stopped_at, log_file = $log, pgids = $pgids WHERE id = $id`,
        )
        .run({
          $id: s.runId,
          $status: s.status,
          $pid: s.pid ?? null,
          $port: s.port ?? null,
          $ports: JSON.stringify(s.ports),
          $url: s.url ?? null,
          $exit: s.exitCode ?? null,
          $error: s.error ?? null,
          $ready_at: s.readyAt ?? null,
          $stopped_at: s.stoppedAt ?? null,
          $log: s.logFile,
          $pgids: JSON.stringify(s.pgids ?? []),
        });
    }
  }

  saveServers(list: Server[]) {
    this.db.transaction(() => list.forEach((s) => this.saveServer(s)))();
  }

  deleteServer(id: string): Run[] {
    const runs = this.runs(id, 1_000_000);
    this.db.query("DELETE FROM servers WHERE id = ?").run(id);
    return runs;
  }

  // ---------- runs ----------

  /** Create a run row; returns its id. The log file path is set by the caller via saveServer. */
  insertRun(serverId: string, command: string, startedAt: number, logFile = ""): number {
    const r = this.db
      .query("INSERT INTO runs (server_id, command, status, started_at, log_file) VALUES (?, ?, 'starting', ?, ?) RETURNING id")
      .get(serverId, command, startedAt, logFile) as Row;
    return r.id;
  }

  run(id: number): Run | undefined {
    const r = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as Row | null;
    return r ? toRun(r) : undefined;
  }

  /** Most recent first. */
  runs(serverId: string, limit = 50): Run[] {
    return (this.db.query("SELECT * FROM runs WHERE server_id = ? ORDER BY id DESC LIMIT ?").all(serverId, limit) as Row[]).map(
      toRun,
    );
  }

  /** The run before `runId` for the same server. */
  previousRun(serverId: string, runId: number | undefined): Run | undefined {
    const r = this.db
      .query("SELECT * FROM runs WHERE server_id = ? AND id < ? ORDER BY id DESC LIMIT 1")
      .get(serverId, runId ?? Number.MAX_SAFE_INTEGER) as Row | null;
    return r ? toRun(r) : undefined;
  }

  /** Insert a complete run row (used when importing pre-SQLite state). */
  importRun(serverId: string, r: Omit<Run, "id" | "serverId">): number {
    const row = this.db
      .query(
        `INSERT INTO runs (server_id, command, status, pid, port, url, exit_code, error, started_at, ready_at, stopped_at, log_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        serverId,
        r.command,
        r.status,
        r.pid ?? null,
        r.port ?? null,
        r.url ?? null,
        r.exitCode ?? null,
        r.error ?? null,
        r.startedAt,
        r.readyAt ?? null,
        r.stoppedAt ?? null,
        r.logFile,
      ) as Row;
    return row.id;
  }

  /**
   * Runs that aren't their server's current run can't still be going. If one is recorded as
   * active (the daemon died mid-restart), mark it stopped as of the next run's start.
   */
  closeOrphanedRuns() {
    this.db
      .query(
        `UPDATE runs SET status = 'stopped',
           stopped_at = COALESCE(stopped_at, (SELECT MIN(n.started_at) FROM runs n WHERE n.server_id = runs.server_id AND n.id > runs.id), started_at)
         WHERE status IN ('starting', 'running', 'stopping')
           AND id NOT IN (SELECT current_run_id FROM servers WHERE current_run_id IS NOT NULL)`,
      )
      .run();
  }

  // ---------- log marks (--since) ----------

  addMark(runId: number, t: number, offset: number) {
    this.db.query("INSERT INTO log_marks (run_id, t, offset) VALUES (?, ?, ?)").run(runId, t, offset);
  }

  clearMarks(runId: number) {
    this.db.query("DELETE FROM log_marks WHERE run_id = ?").run(runId);
  }

  /** Log size at the last mark before `cutoff`, i.e. where output written after it begins. */
  offsetBefore(runId: number, cutoff: number): number {
    const r = this.db.query("SELECT offset FROM log_marks WHERE run_id = ? AND t < ? ORDER BY t DESC LIMIT 1").get(runId, cutoff) as Row | null;
    return r?.offset ?? 0;
  }

  // ---------- profiles ----------

  profiles(): Profile[] {
    const rows = this.db.query("SELECT id, name, accounts FROM profiles ORDER BY name COLLATE NOCASE").all() as Row[];
    const members = this.db.query("SELECT server_id FROM profile_servers WHERE profile_id = ? ORDER BY position");
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      servers: (members.all(r.id) as Row[]).map((m) => m.server_id),
      accounts: JSON.parse(r.accounts),
    }));
  }

  profile(ref: string | number): Profile | undefined {
    return this.profiles().find((p) => p.id === Number(ref) || p.name.toLowerCase() === String(ref).toLowerCase());
  }

  createProfile(name: string, servers: string[], accounts: Selections = {}): Profile {
    const row = this.db
      .query("INSERT INTO profiles (name, accounts, created_at) VALUES (?, ?, ?) RETURNING id")
      .get(name, JSON.stringify(accounts), Date.now()) as Row;
    this.setProfileServers(row.id, servers);
    return this.profile(row.id)!;
  }

  updateProfile(id: number, changes: { name?: string; servers?: string[]; accounts?: Selections }): Profile {
    this.db.transaction(() => {
      if (changes.name !== undefined) this.db.query("UPDATE profiles SET name = ? WHERE id = ?").run(changes.name, id);
      if (changes.accounts) this.db.query("UPDATE profiles SET accounts = ? WHERE id = ?").run(JSON.stringify(changes.accounts), id);
      if (changes.servers) this.setProfileServers(id, changes.servers);
    })();
    return this.profile(id)!;
  }

  private setProfileServers(id: number, servers: string[]) {
    this.db.query("DELETE FROM profile_servers WHERE profile_id = ?").run(id);
    const add = this.db.query("INSERT INTO profile_servers (profile_id, server_id, position) VALUES (?, ?, ?)");
    [...new Set(servers)].forEach((s, i) => add.run(id, s, i));
  }

  deleteProfile(id: number) {
    this.db.query("DELETE FROM profiles WHERE id = ?").run(id);
  }

  // ---------- grid layouts ----------

  getLayout(scope: string): LayoutItem[] | undefined {
    const r = this.db.query("SELECT items FROM layouts WHERE scope = ?").get(scope) as Row | null;
    return r ? JSON.parse(r.items) : undefined;
  }

  setLayout(scope: string, items: LayoutItem[]) {
    this.db
      .query("INSERT INTO layouts (scope, items, updated_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at")
      .run(scope, JSON.stringify(items), Date.now());
  }

  /** Take removed servers off every saved grid. Returns the scopes that changed. */
  dropFromLayouts(ids: string[]): string[] {
    const drop = new Set(ids);
    const changed: string[] = [];
    for (const r of this.db.query("SELECT scope, items FROM layouts").all() as Row[]) {
      const items = JSON.parse(r.items) as LayoutItem[];
      const kept = items.filter((it) => !drop.has(it.i));
      if (kept.length !== items.length) {
        this.setLayout(r.scope, kept);
        changed.push(r.scope);
      }
    }
    return changed;
  }

  deleteLayout(scope: string) {
    this.db.query("DELETE FROM layouts WHERE scope = ?").run(scope);
  }

  // ---------- settings ----------

  getSetting(key: SettingKey): string {
    const r = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as Row | null;
    return r?.value ?? SETTINGS[key].default;
  }

  setSetting(key: SettingKey, value: string) {
    this.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Internal state kept in the settings table under "meta:" keys (not user settings). */
  getMeta(key: string): string | undefined {
    const r = this.db.query("SELECT value FROM settings WHERE key = ?").get(`meta:${key}`) as Row | null;
    return r?.value;
  }

  setMeta(key: string, value: string) {
    this.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`meta:${key}`, value);
  }

  // ---------- retention ----------

  /**
   * Delete log files of runs that stopped before `cutoff`. Runs that are some server's current
   * run keep their row (so the list still shows how it last ended) with the log file cleared;
   * older runs are deleted outright. Returns the number of log files removed.
   */
  purgeRunsBefore(cutoff: number): number {
    const old = this.db
      .query(
        `SELECT r.*, (SELECT 1 FROM servers s WHERE s.current_run_id = r.id) AS is_current
           FROM runs r WHERE r.stopped_at IS NOT NULL AND r.stopped_at < ?`,
      )
      .all(cutoff) as Row[];
    let removed = 0;
    this.db.transaction(() => {
      for (const r of old) {
        if (r.log_file && fs.existsSync(r.log_file)) {
          fs.rmSync(r.log_file, { force: true });
          removed++;
        }
        if (r.is_current) {
          this.db.query("UPDATE runs SET log_file = '' WHERE id = ?").run(r.id);
          this.clearMarks(r.id);
        } else this.db.query("DELETE FROM runs WHERE id = ?").run(r.id);
      }
    })();
    return removed;
  }

  close() {
    this.db.close();
  }
}

/** Log file for a run: logs/<server-id>/<run-id>.log */
export function runLogFile(logDir: string, serverId: string, runId: number): string {
  return path.join(logDir, serverId.replace(/[^\w.-]+/g, "_"), `${runId}.log`);
}
