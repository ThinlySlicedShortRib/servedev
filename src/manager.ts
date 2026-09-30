import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { clean, fileSize, readFrom } from "./logs";
import { DB_FILE, LOG_DIR, STATE_FILE, ensureHome } from "./paths";
import { discoverGroups, findFreePort, listeners, processTable, tcpOpen } from "./ports";
import type { Selections } from "./accounts/registry";
import type { ReadySpec } from "./project";
import { Store, runLogFile } from "./store";

export type Status = "starting" | "running" | "stopping" | "stopped" | "exited" | "crashed";
export const ACTIVE: Status[] = ["starting", "running", "stopping"];

export interface Server {
  id: string;
  name: string;
  project: string;
  root: string;
  command: string;
  /** Runs before `command` in the same shell, e.g. "pnpm install". */
  setup?: string;
  cwd: string;
  /** Variables set on purpose (--env, the dashboard). The rest comes from the login shell at each start. */
  env: Record<string, string>;
  /** Port as requested (number or "auto"); re-resolved on every start. */
  portSpec?: number | "auto";
  /** Port assigned for the current run ($PORT / {port}). */
  port?: number;
  ready: ReadySpec;
  status: Status;
  pid?: number;
  exitCode?: number | null;
  error?: string;
  startedAt?: number;
  readyAt?: number;
  stoppedAt?: number;
  /** TCP ports the process group is listening on. */
  ports: number[];
  url?: string;
  /** Log of the current (or last) run. Empty once retention has purged it. */
  logFile: string;
  restarts: number;
  /** Row in the runs table for the current (or last) run. */
  runId?: number;
  pinned?: boolean;
  /** Custom hostname, e.g. keel.localhost, routed to this server by the daemon's proxy. */
  hostname?: string;
  /**
   * Process groups that belong to this run: the one servedev created (= pid) plus any created
   * by its descendants, e.g. turbo runs each task in its own group.
   */
  pgids?: number[];
  /** Accounts the current run was started with, when a profile picked them (see src/accounts). */
  accounts?: ServerAccounts;
}

/** A run's platform accounts: which profile picked them, and the picks by provider id. */
export interface ServerAccounts {
  profile: { id: number; name: string };
  selections: Selections;
}

export type PublicServer = Omit<Server, "env"> & {
  /** The server's custom hostname as a URL through the daemon's proxy, e.g. http://keel.localhost. */
  customUrl?: string;
  /** Git branch checked out in the server's project folder. */
  branch?: string;
  /** Its profile picked different accounts since it started; restarting applies them. */
  accountsStale?: boolean;
  /** How it compares to its repo's servedev.json. */
  config?: "defined" | "differs" | "missing";
  /** Its own variables (the ones set on purpose), values masked. */
  vars?: { name: string; preview: string; secret: boolean }[];
};

export interface ReadyResult {
  ok: boolean;
  timedOut?: boolean;
  reason?: string;
}

export interface StartSpec {
  root: string;
  name: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  portSpec?: number | "auto";
  portArgs?: string;
  setup?: string;
  hostname?: string;
  ready: ReadySpec;
  /**
   * Env from a profile's account picks. Applied to this run only and never saved with the server,
   * so the credentials don't follow it once it runs outside the profile.
   */
  accountEnv?: Record<string, string>;
  /** Environment underneath `env`: the login shell's, plus servedev.json's env. Not saved. */
  baseEnv?: Record<string, string>;
  accounts?: ServerAccounts;
}

interface Runtime {
  gen: number;
  child?: ChildProcess;
  exitCode?: number | null;
  signal?: string | null;
  waiters: Set<(r: ReadyResult) => void>;
  /** [time, size] samples of the log file, for --since. */
  samples: [number, number][];
  scanOffset: number;
  logMatched: boolean;
  loggedPorts: number[];
  /** When a log mark was last written to the database. */
  lastMark: number;
}

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+\.local):(\d{2,5})/g;
const MAX_LOG = 10 * 1024 * 1024;
/** Persist a log write-time mark at most this often per run. */
const MARK_EVERY_MS = 10_000;
const PURGE_EVERY_MS = 60 * 60 * 1000;

export function groupAlive(pgid: number | undefined): boolean {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function signalGroup(pgid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pgid, sig);
  } catch {}
}

function groupsOf(s: Server): number[] {
  return s.pgids?.length ? s.pgids : s.pid ? [s.pid] : [];
}

/** Any process of the server still exists, in any of its groups. */
export function serverAlive(s: Server): boolean {
  return groupsOf(s).some(groupAlive);
}

function signalServer(s: Server, sig: NodeJS.Signals) {
  for (const g of groupsOf(s)) signalGroup(g, sig);
}

export class Manager extends EventEmitter {
  servers = new Map<string, Server>();
  store: Store;
  private rt = new Map<string, Runtime>();
  private dirty = new Set<string>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private purgeTimer?: ReturnType<typeof setInterval>;
  private tick = 0;
  private monitorTimer?: ReturnType<typeof setInterval>;

  constructor() {
    super();
    ensureHome();
    this.store = new Store(DB_FILE);
    this.load();
  }

  // ---------- persistence ----------

  private load() {
    if (this.store.isEmpty()) this.importLegacyState();
    this.store.closeOrphanedRuns();
    for (const s of this.store.loadServers()) {
      this.servers.set(s.id, s);
      const rt = this.runtime(s.id);
      if (!ACTIVE.includes(s.status)) continue;
      if (serverAlive(s)) {
        // Adopt a server that survived a daemon restart.
        rt.scanOffset = fileSize(s.logFile);
        if (s.status === "stopping") void this.stop(s.id);
        else if (!s.readyAt) {
          s.status = "starting";
          void this.readinessLoop(s, rt.gen);
        }
      } else {
        s.status = s.status === "stopping" ? "stopped" : "exited";
        s.exitCode = null;
        s.error ??= "process ended while the servedev daemon was not running";
        s.ports = [];
        s.url = undefined;
        s.stoppedAt ??= Date.now();
      }
    }
    this.store.saveServers(this.list());
  }

  /** One-time import of the pre-SQLite state.json, keeping existing logs as runs. */
  private importLegacyState() {
    let saved: (Server & { restarts?: number })[];
    try {
      saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).servers ?? [];
    } catch {
      return;
    }
    this.store.db.transaction(() => {
      for (const s of saved) {
        s.restarts ??= 0;
        this.store.saveServer({ ...s, runId: undefined });
        const prev = s.logFile.replace(/\.log$/, ".prev.log");
        if (fs.existsSync(prev)) {
          const st = fs.statSync(prev);
          this.store.importRun(s.id, {
            command: s.command,
            status: "stopped",
            startedAt: Math.round(st.birthtimeMs),
            stoppedAt: Math.round(st.mtimeMs),
            logFile: prev,
          });
        }
        s.runId = this.store.importRun(s.id, {
          command: s.command,
          status: s.status,
          pid: s.pid,
          port: s.port,
          url: s.url,
          exitCode: s.exitCode,
          error: s.error,
          startedAt: s.startedAt ?? Date.now(),
          readyAt: s.readyAt,
          stoppedAt: s.stoppedAt,
          logFile: s.logFile,
        });
        this.store.saveServer(s);
      }
    })();
    fs.renameSync(STATE_FILE, STATE_FILE + ".migrated");
  }

  private save(s: Server) {
    this.dirty.add(s.id);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 100);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const list = [...this.dirty].map((id) => this.servers.get(id)).filter((s): s is Server => !!s);
    this.dirty.clear();
    if (list.length) this.store.saveServers(list);
  }

  private changed(s: Server) {
    this.save(s);
    this.emit("change", s);
  }

  private runtime(id: string): Runtime {
    let rt = this.rt.get(id);
    if (!rt) {
      rt = { gen: 0, waiters: new Set(), samples: [], scanOffset: 0, logMatched: false, loggedPorts: [], lastMark: 0 };
      this.rt.set(id, rt);
    }
    return rt;
  }

  // ---------- lookup ----------

  list(): Server[] {
    return [...this.servers.values()];
  }

  find(root: string, name: string): Server | undefined {
    return this.list().find((s) => s.root === root && s.name === name);
  }

  /** Short project label; disambiguated with a hash when two roots share a basename. */
  projectLabel(root: string): string {
    const existing = this.list().find((s) => s.root === root);
    if (existing) return existing.project;
    const base = path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "root";
    const clash = this.list().some((s) => s.project === base && s.root !== root);
    return clash ? `${base}-${crypto.createHash("sha1").update(root).digest("hex").slice(0, 4)}` : base;
  }

  // ---------- lifecycle ----------

  async start(spec: StartSpec, restart = false): Promise<{ server: Server; alreadyRunning: boolean }> {
    let s = this.find(spec.root, spec.name);
    if (s && ACTIVE.includes(s.status) && s.status !== "stopping") {
      if (!restart) return { server: s, alreadyRunning: true };
    }
    if (s && ACTIVE.includes(s.status)) await this.stop(s.id);

    // Resolve the port before touching anything.
    let port: number | undefined;
    if (spec.portSpec === "auto") {
      const reserved = new Set(this.list().filter((o) => ACTIVE.includes(o.status) && o.port).map((o) => o.port!));
      port = await findFreePort(reserved);
    } else if (typeof spec.portSpec === "number") {
      port = spec.portSpec;
      const holder = (await listeners()).find((l) => l.port === port);
      if (holder) {
        const owner = this.list().find((o) => ACTIVE.includes(o.status) && o.pid === holder.pgid);
        throw new Error(
          owner
            ? `port ${port} is already used by servedev server ${owner.id}`
            : `port ${port} is already in use by ${holder.command} (pid ${holder.pid}). Use --port auto, or stop that process.`,
        );
      }
    }

    let command = spec.command;
    if (port !== undefined && spec.portArgs && !command.includes("{port}")) command += spec.portArgs;
    if (port !== undefined) command = command.replaceAll("{port}", String(port));

    if (!fs.existsSync(spec.cwd)) throw new Error(`directory does not exist: ${spec.cwd}`);

    const project = this.projectLabel(spec.root);
    const id = `${project}:${spec.name}`;
    const startedAt = Date.now();
    const previous = s;
    // Record how the previous run ended now; the object is replaced below, so a deferred save would miss it.
    if (previous) {
      this.dirty.delete(previous.id);
      this.store.saveServer(previous);
    }

    s = {
      id,
      name: spec.name,
      project,
      root: spec.root,
      command: spec.command,
      setup: spec.setup,
      cwd: spec.cwd,
      env: spec.env,
      portSpec: spec.portSpec,
      port,
      ready: spec.ready,
      status: "starting",
      startedAt,
      ports: [],
      logFile: "",
      restarts: (previous?.restarts ?? -1) + 1,
      pinned: previous?.pinned,
      hostname: spec.hostname,
      accounts: spec.accounts,
    };
    this.servers.set(id, s);
    // Each start is a run with its own log file; earlier runs stay readable until retention purges them.
    this.store.saveServer(s);
    s.runId = this.store.insertRun(id, command, startedAt);
    s.logFile = runLogFile(LOG_DIR, id, s.runId);
    fs.mkdirSync(path.dirname(s.logFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(s.logFile, "");
    this.store.saveServer(s);
    const logFile = s.logFile;

    const rt = this.runtime(id);
    const gen = ++rt.gen;
    Object.assign(rt, { child: undefined, exitCode: undefined, signal: undefined, samples: [], scanOffset: 0, logMatched: false, loggedPorts: [], lastMark: 0 });

    const env: Record<string, string> = {
      ...(spec.baseEnv ?? (process.env as Record<string, string>)),
      ...spec.env,
      ...spec.accountEnv,
      PWD: spec.cwd,
      BROWSER: "none",
    };
    if (port !== undefined) env.PORT = String(port);
    // Setup output goes to the same log; a failing setup exits before the server starts.
    const script = spec.setup
      ? `echo ${shq(`[servedev] $ ${spec.setup}`)}\n${spec.setup} || exit $?\necho ${shq(`[servedev] $ ${command}`)}\n${command}`
      : command;
    const out = fs.openSync(logFile, "a");
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", script], { cwd: spec.cwd, env, detached: true, stdio: ["ignore", out, out] });
    } finally {
      fs.closeSync(out);
    }
    child.unref();
    rt.child = child;
    s.pid = child.pid;
    s.pgids = child.pid ? [child.pid] : [];
    const server = s;

    child.on("error", (err) => {
      if (rt.gen !== gen) return;
      server.error = err.message;
      this.finalize(server, gen);
    });
    child.on("exit", (code, signal) => {
      if (rt.gen !== gen) return;
      rt.exitCode = code;
      rt.signal = signal;
      if (!serverAlive(server)) this.finalize(server, gen);
    });

    this.changed(s);
    void this.readinessLoop(s, gen);
    return { server: s, alreadyRunning: false };
  }

  /** Called once the whole process group is gone. */
  private finalize(s: Server, gen: number) {
    const rt = this.runtime(s.id);
    if (rt.gen !== gen || !ACTIVE.includes(s.status)) return;
    const wasStopping = s.status === "stopping";
    s.exitCode = rt.exitCode ?? null;
    if (wasStopping) s.status = "stopped";
    else if (rt.exitCode === 0) s.status = "exited";
    else {
      s.status = "crashed";
      if (rt.signal) s.error ??= `killed by ${rt.signal}`;
    }
    s.stoppedAt = Date.now();
    s.ports = [];
    s.url = undefined;
    // Take down any stragglers left in its groups.
    signalServer(s, "SIGKILL");
    const reason = wasStopping
      ? "stopped"
      : s.status === "exited"
        ? "process exited (code 0) before it was ready"
        : `process ${rt.signal ? `was killed by ${rt.signal}` : `exited with code ${rt.exitCode ?? "unknown"}`}${s.readyAt ? "" : " before it was ready"}`;
    this.resolveWaiters(s, { ok: false, reason });
    this.changed(s);
  }

  async stop(id: string): Promise<Server> {
    const s = this.servers.get(id);
    if (!s) throw new Error(`unknown server ${id}`);
    if (!ACTIVE.includes(s.status) || !s.pid) return s;
    const gen = this.runtime(id).gen;
    s.status = "stopping";
    // Catch groups created since the last check, so every process gets the signal.
    this.trackGroups(s, await processTable());
    this.changed(s);
    signalServer(s, "SIGTERM");
    for (let i = 0; i < 50 && serverAlive(s); i++) await Bun.sleep(100);
    if (serverAlive(s)) {
      signalServer(s, "SIGKILL");
      for (let i = 0; i < 20 && serverAlive(s); i++) await Bun.sleep(100);
    }
    this.finalize(s, gen);
    return s;
  }

  /** Set or clear a server's custom hostname. Hostnames are unique across servers. */
  setHostname(id: string, hostname: string | undefined): Server {
    const s = this.servers.get(id);
    if (!s) throw new Error(`unknown server ${id}`);
    const owner = hostname && this.list().find((o) => o.hostname === hostname && o.id !== id);
    if (owner) throw new Error(`${hostname} is already used by ${owner.id}`);
    s.hostname = hostname;
    this.changed(s);
    return s;
  }

  setPinned(id: string, pinned: boolean): Server {
    const s = this.servers.get(id);
    if (!s) throw new Error(`unknown server ${id}`);
    s.pinned = pinned;
    this.changed(s);
    return s;
  }

  async remove(id: string) {
    const s = this.servers.get(id);
    if (!s) return;
    await this.stop(id);
    this.servers.delete(id);
    this.rt.delete(id);
    this.dirty.delete(id);
    for (const run of this.store.deleteServer(id)) if (run.logFile) fs.rmSync(run.logFile, { force: true });
    fs.rmSync(path.dirname(runLogFile(LOG_DIR, id, 0)), { recursive: true, force: true });
    this.emit("remove", s);
  }

  waitReady(id: string, timeoutMs: number): Promise<ReadyResult> {
    const s = this.servers.get(id);
    if (!s) return Promise.resolve({ ok: false, reason: "unknown server" });
    if (s.status === "running") return Promise.resolve({ ok: true });
    if (!ACTIVE.includes(s.status) || s.status === "stopping") {
      return Promise.resolve({ ok: false, reason: `server is ${s.status}${s.exitCode != null ? ` (exit code ${s.exitCode})` : ""}` });
    }
    const rt = this.runtime(id);
    return new Promise((resolve) => {
      const done = (r: ReadyResult) => {
        clearTimeout(timer);
        rt.waiters.delete(done);
        resolve(r);
      };
      const timer = setTimeout(
        () => done({ ok: false, timedOut: true, reason: `not ready after ${Math.round(timeoutMs / 1000)}s` }),
        timeoutMs,
      );
      rt.waiters.add(done);
    });
  }

  private resolveWaiters(s: Server, r: ReadyResult) {
    for (const w of [...this.runtime(s.id).waiters]) w(r);
  }

  // ---------- readiness & monitoring ----------

  private async readinessLoop(s: Server, gen: number) {
    const rt = this.runtime(s.id);
    while (rt.gen === gen && s.status === "starting") {
      if (await this.checkReady(s)) {
        if (rt.gen !== gen || s.status !== "starting") return;
        s.status = "running";
        s.readyAt = Date.now();
        this.resolveWaiters(s, { ok: true });
        this.changed(s);
        return;
      }
      await Bun.sleep(300);
    }
  }

  private async checkReady(s: Server): Promise<boolean> {
    if (s.ready.mode === "none") return true;
    this.scanLog(s);
    await this.refreshPorts([s]);
    const rt = this.runtime(s.id);
    if (s.ready.log && !rt.logMatched) return false;
    if (s.ready.url) {
      const url = this.resolveUrl(s, s.ready.url);
      if (!url) return false;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
        if (res.status >= 500) return false;
      } catch {
        return false;
      }
    }
    if (s.ready.log || s.ready.url) return true;
    // Default: listening on a port. The assigned port also counts even if another
    // process owns the socket (e.g. docker compose).
    return s.ports.length > 0 || (s.port !== undefined && (await tcpOpen(s.port)));
  }

  private resolveUrl(s: Server, u: string): string | undefined {
    if (/^https?:\/\//.test(u)) return s.port !== undefined ? u.replaceAll("{port}", String(s.port)) : u;
    const port = this.primaryPort(s);
    if (!port) return undefined;
    return `http://localhost:${port}${u.startsWith("/") ? u : "/" + u}`;
  }

  private primaryPort(s: Server): number | undefined {
    const rt = this.runtime(s.id);
    const logged = rt.loggedPorts.find((p) => s.ports.includes(p));
    if (logged) return logged;
    if (s.port !== undefined && (s.ports.includes(s.port) || s.ports.length === 0)) return s.port;
    if (s.ports.length) return Math.min(...s.ports);
    return rt.loggedPorts[0];
  }

  /** Incrementally scan new log output for the ready pattern and printed URLs. */
  private scanLog(s: Server) {
    const rt = this.runtime(s.id);
    const size = fileSize(s.logFile);
    if (size < rt.scanOffset) rt.scanOffset = 0;
    if (size === rt.scanOffset) return;
    const from = Math.max(0, rt.scanOffset - 1024);
    const text = clean(readFrom(s.logFile, from));
    rt.scanOffset = size;
    if (s.ready.log && !rt.logMatched) {
      try {
        rt.logMatched = new RegExp(s.ready.log, "im").test(text);
      } catch {
        rt.logMatched = text.toLowerCase().includes(s.ready.log.toLowerCase());
      }
    }
    for (const m of text.matchAll(URL_RE)) {
      const p = Number(m[1]);
      if (!rt.loggedPorts.includes(p)) rt.loggedPorts.push(p);
    }
  }

  /** Add process groups created by the server's descendants. Returns true when new ones were found. */
  private trackGroups(s: Server, table: Awaited<ReturnType<typeof processTable>>): boolean {
    if (!s.pid) return false;
    const groups = discoverGroups(s.pid, groupsOf(s), table);
    if (groups.length === groupsOf(s).length) return false;
    s.pgids = groups;
    return true;
  }

  private async refreshPorts(list: Server[]) {
    const [ls, table] = await Promise.all([listeners(), processTable()]);
    for (const s of list) {
      if (!ACTIVE.includes(s.status)) continue;
      const newGroups = this.trackGroups(s, table);
      const groups = new Set(groupsOf(s));
      const ports = [...new Set(ls.filter((l) => groups.has(l.pgid)).map((l) => l.port))].sort((a, b) => a - b);
      const port = this.primaryPort({ ...s, ports });
      const url = port && (ports.length || s.status === "running") ? `http://localhost:${port}` : undefined;
      if (newGroups || ports.join() !== s.ports.join() || url !== s.url) {
        s.ports = ports;
        s.url = url;
        this.changed(s);
      }
    }
  }

  startMonitor() {
    this.monitorTimer = setInterval(() => void this.monitor(), 1000);
    this.purgeOldLogs();
    this.purgeTimer = setInterval(() => this.purgeOldLogs(), PURGE_EVERY_MS);
  }

  stopMonitor() {
    clearInterval(this.monitorTimer);
    clearInterval(this.purgeTimer);
  }

  /** Delete logs of runs that stopped longer ago than the retention setting. */
  purgeOldLogs(): number {
    const days = Number(this.store.getSetting("log_retention_days"));
    if (!(days > 0)) return 0;
    const cutoff = Date.now() - days * 86_400_000;
    const removed = this.store.purgeRunsBefore(cutoff);
    for (const s of this.list()) {
      if (!ACTIVE.includes(s.status) && s.stoppedAt && s.stoppedAt < cutoff && s.logFile) {
        s.logFile = "";
        this.changed(s);
      }
    }
    // Drop per-server log folders left empty.
    for (const d of fs.readdirSync(LOG_DIR, { withFileTypes: true })) {
      const dir = path.join(LOG_DIR, d.name);
      if (d.isDirectory() && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
    return removed;
  }

  private async monitor() {
    const now = Date.now();
    const active = this.list().filter((s) => ACTIVE.includes(s.status));
    for (const s of active) {
      if (s.status !== "stopping" && !serverAlive(s)) {
        this.finalize(s, this.runtime(s.id).gen);
        continue;
      }
      const rt = this.runtime(s.id);
      let size = fileSize(s.logFile);
      if (size > MAX_LOG) {
        const keep = readFrom(s.logFile, size - 2 * 1024 * 1024);
        fs.truncateSync(s.logFile, 0);
        fs.appendFileSync(s.logFile, "[servedev: log truncated]\n" + keep);
        rt.samples = [];
        rt.scanOffset = 0;
        if (s.runId) this.store.clearMarks(s.runId);
        size = fileSize(s.logFile);
      }
      const last = rt.samples.at(-1);
      if (!last || last[1] !== size) {
        rt.samples.push([now, size]);
        // Persisted marks let --since work after a daemon restart; coarser than the in-memory samples.
        if (s.runId && now - rt.lastMark >= MARK_EVERY_MS) {
          this.store.addMark(s.runId, now, last?.[1] ?? 0);
          rt.lastMark = now;
        }
      }
      if (rt.samples.length > 20_000) rt.samples.splice(0, 10_000);
      if (s.status === "running") this.scanLog(s);
    }
    if (++this.tick % 3 === 0 && active.length) await this.refreshPorts(active);
  }

  /** Byte offset of log output written at or after `sinceMs` ago, in the current run's log. */
  offsetSince(id: string, sinceMs: number): number {
    const cutoff = Date.now() - sinceMs;
    let offset = 0;
    for (const [t, size] of this.runtime(id).samples) {
      if (t >= cutoff) break;
      offset = size;
    }
    const runId = this.servers.get(id)?.runId;
    return runId ? Math.max(offset, this.store.offsetBefore(runId, cutoff)) : offset;
  }
}

export function publicView(s: Server): PublicServer {
  const { env: _env, ...rest } = s;
  return rest;
}
