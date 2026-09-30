import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRESETS, fileSize, lineAtOffset, parseDuration, queryLines, readFrom, searchLines, toRegex, type Preset, type SearchBlock } from "./logs";
import { ACTIVE, Manager, publicView, type PublicServer, type ReadyResult, type Server } from "./manager";
import { listeners, processTable, type Proc } from "./ports";
import { HostProxy, type Route } from "./proxy";
import { DAEMON_PORT, VERSION, getToken } from "./paths";
import { autostartStatus, installAutostart, uninstallAutostart } from "./autostart";
import { gitBranch } from "./git";
import { cwdsOf, detectExternal, launcherOf, startTimesOf, suggestName, type ExternalServer } from "./external";
import { selfCommand } from "./client";
import { ConfigConflict, configState, planSave, saveToConfig } from "./config-file";
import { maskSecrets } from "./sanitize";
import { applyVars, explicitPart, getLoginEnv, looksSecret, maskValue, migrateSnapshot, type EnvMigration } from "./env";
import { AccountRegistry, PROVIDERS_DIR, type Selections } from "./accounts/registry";
import { planInstall, type InstallPlan } from "./install";
import { detectCommand, findRoot, loadConfig, normalizeReady, type ReadySpec } from "./project";
import { SETTINGS, type LayoutItem, type Profile, type Run, type SettingKey } from "./store";
import uiBundle from "../ui/dist/index.html" with { type: "text" };

// The dashboard (ui/) builds to a single self-contained HTML file, embedded here as text.
const uiHtml = uiBundle as unknown as string;
/** Identifies this dashboard build; open tabs reload when the daemon serves a different one. */
const UI_BUILD = `${VERSION}-${Bun.hash(uiHtml).toString(36)}`;

export interface StartRequest {
  root: string;
  /** The client's working directory. */
  clientCwd: string;
  name?: string;
  /** Full server id; used by the dashboard to restart a known server. */
  id?: string;
  command?: string;
  /** Command to run before the server on this and later starts. */
  setup?: string;
  /** Run the package manager install before starting. */
  install?: boolean;
  /** Custom hostname, e.g. keel.localhost. */
  hostname?: string;
  cwd?: string;
  /**
   * Variables to set on purpose, merged into the server's (an empty value removes one); with
   * replaceVars they replace them.
   */
  vars?: Record<string, string>;
  replaceVars?: boolean;
  /** Old clients send their whole environment; only what differs from the login shell is kept. */
  env?: Record<string, string>;
  port?: number | "auto";
  ready?: ReadySpec;
  timeout?: number;
  restart?: boolean;
  wait?: boolean;
  /**
   * Profile whose accounts the server runs with (id or name); null for this machine's accounts.
   * Omitted: the profile it last ran with, else the one profile it's in that picks accounts.
   */
  profile?: number | string | null;
}

export interface SearchRequest {
  root?: string;
  /** Search every project, not just `root`. */
  all?: boolean;
  /** Server names or ids; default: every server in scope. */
  servers?: string[];
  query?: string;
  preset?: Preset;
  context?: number;
  /** Max matches shown per server run (most recent first kept). */
  limit?: number;
  since?: string;
  /** current (default), previous, both, or all: every run still within log retention. */
  runs?: "current" | "previous" | "both" | "all";
}

/** Where a log came from. */
export interface RunInfo {
  id?: number;
  current: boolean;
  status: string;
  exitCode?: number | null;
  startedAt?: number;
  stoppedAt?: number;
}

export interface SearchResult {
  id: string;
  name: string;
  project: string;
  status: string;
  exitCode?: number | null;
  run: RunInfo;
  total: number;
  blocks: SearchBlock[];
}

export interface SearchResponse {
  pattern: string;
  searched: number;
  results: SearchResult[];
}

export interface StartResponse {
  server: PublicServer;
  alreadyRunning: boolean;
  ready?: ReadyResult;
  logTail?: string;
  detected?: string;
  /** The install that runs before the server on this start. */
  install?: InstallPlan;
  /** Dependencies look out of date but no install was requested. */
  installHint?: InstallPlan;
  /** Why the server didn't get a profile's accounts, when that's ambiguous. */
  accountsNote?: string;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ProcessGroup {
  pgid: number;
  /** "servedev" for the group servedev created, else the program that created it, e.g. "turbo". */
  createdBy: string;
  processes: { pid: number; ppid: number; depth: number; command: string; ports: number[] }[];
}

/** "turbo" for "node /x/node_modules/turbo/bin/turbo run dev"; "pnpm" for "node /opt/homebrew/bin/pnpm". */
export function programName(command: string): string {
  const [first, second] = command.split(/\s+/);
  const base = (p: string) => p.split("/").pop()!.replace(/\.(c|m)?js$/, "");
  const interpreter = /^(node|bun|deno|python\d*(\.\d+)?|ruby)$/.test(base(first ?? ""));
  return interpreter && second && !second.startsWith("-") ? base(second) : base(first ?? "");
}

/** "http://Keel.localhost:3000/" -> "keel.localhost"; throws on anything that isn't a hostname. */
export function normalizeHostname(input: string): string {
  const h = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  const label = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
  if (!new RegExp(`^${label}(\\.${label})+$`).test(h) || h.length > 253) {
    throw new HttpError(400, `"${input}" isn't a hostname; use something like keel.localhost`);
  }
  return h;
}

/**
 * Whether a page with these headers may be shown in the dashboard's preview frame. The dashboard is
 * a different origin, so X-Frame-Options DENY or SAMEORIGIN both block it, and so does a CSP
 * frame-ancestors list that doesn't allow the dashboard.
 */
export function frameVerdict(headers: Headers, dashboardOrigin: string): { frameable: boolean; reason?: string } {
  const xfo = headers.get("x-frame-options")?.trim().toUpperCase();
  if (xfo === "DENY" || xfo === "SAMEORIGIN") return { frameable: false, reason: `X-Frame-Options: ${xfo}` };
  const csp = headers.get("content-security-policy") ?? "";
  const fa = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp)?.[1]?.trim();
  if (fa !== undefined) {
    const sources = fa.split(/\s+/);
    const host = new URL(dashboardOrigin).host;
    const allowed = sources.some((src) => src === "*" || src === dashboardOrigin || src.replace(/^https?:\/\//, "") === host);
    if (!allowed) return { frameable: false, reason: `Content-Security-Policy: frame-ancestors ${fa}` };
  }
  return { frameable: true };
}

export interface ProfileStartResult {
  id: string;
  ok: boolean;
  alreadyRunning?: boolean;
  url?: string;
  reason?: string;
}

export async function runDaemon(opts: { autostart?: boolean } = {}) {
  const token = getToken();
  const manager = new Manager();
  await migrateEnvSnapshots();

  /**
   * Servers used to store the whole environment of whatever started them (terminal ids, agent
   * tokens, NODE_OPTIONS shims). Once, keep only what looks set on purpose; report names only.
   */
  async function migrateEnvSnapshots() {
    if (manager.store.getMeta("env_migrated")) return;
    const login = await getLoginEnv();
    const reports: EnvMigration[] = [];
    for (const s of manager.list()) {
      const { env, report } = migrateSnapshot(s.id, s.env ?? {}, login);
      s.env = env;
      manager.store.saveServer(s);
      reports.push(report);
    }
    manager.store.setMeta("env_migration", JSON.stringify({ at: Date.now(), servers: reports }));
    manager.store.setMeta("env_migrated", "1");
    if (reports.length) {
      console.log(`env cleanup: servers now keep only variables set on purpose; the rest comes from your login shell at each start.`);
      for (const r of reports) {
        console.log(
          `  ${r.id}: ${r.before} stored → ${r.kept.length} kept${r.kept.length ? ` (${r.kept.join(", ")})` : ""}` +
            (r.secretsDropped.length ? `; secret-looking dropped: ${r.secretsDropped.join(", ")}` : "") +
            (r.secretsKept.length ? `; secret-looking kept: ${r.secretsKept.join(", ")}` : ""),
        );
      }
    }
  }

  // Custom hostnames (keel.localhost) -> each server's current port.
  const proxy = new HostProxy((host): Route => {
    const s = manager.list().find((x) => x.hostname === host);
    if (!s) return { status: "unknown", hostnames: manager.list().flatMap((x) => (x.hostname ? [x.hostname] : [])).sort() };
    const port = s.url ? Number(new URL(s.url).port) : s.ports[0];
    if (!ACTIVE.includes(s.status) || !port) return { status: "stopped", serverId: s.id, hostname: host };
    return { status: "ok", port, serverId: s.id };
  });

  /** Run the proxy only while some server has a hostname. */
  function syncProxy(restart = false) {
    const wanted = manager.list().some((s) => s.hostname);
    if (restart || !wanted) proxy.stop();
    if (wanted && !proxy.running) {
      proxy.start(Number(manager.store.getSetting("proxy_port")));
      console.log(proxy.running ? `hostname proxy on port ${proxy.port}${proxy.error ? ` (${proxy.error})` : ""}` : `hostname proxy failed: ${proxy.error}`);
      // Every hostname's URL depends on the proxy port.
      for (const s of manager.list()) if (s.hostname) manager.emit("change", s);
    }
  }

  function proxyStatus() {
    return { running: proxy.running, port: proxy.port, error: proxy.error };
  }

  // Branch per project folder. Checked every few seconds so a `git checkout` shows up in the dashboard.
  const branches = new Map<string, string | undefined>();
  function branchOf(root: string): string | undefined {
    if (!branches.has(root)) branches.set(root, gitBranch(root));
    return branches.get(root);
  }
  setInterval(() => {
    for (const root of new Set(manager.list().map((s) => s.root))) {
      const now = gitBranch(root);
      if (branches.has(root) && branches.get(root) !== now) {
        branches.set(root, now);
        for (const s of manager.list()) if (s.root === root) manager.emit("change", s);
      } else branches.set(root, now);
    }
  }, 5000);

  function view(s: Server): PublicServer {
    return {
      ...publicView(s),
      // Credentials on a command line (e.g. a taken-over cloud-sql-proxy --token=…) aren't shown.
      command: maskSecrets(s.command),
      setup: s.setup && maskSecrets(s.setup),
      customUrl: s.hostname ? proxy.urlFor(s.hostname) : undefined,
      branch: branchOf(s.root),
      accountsStale: accountsStale(s) || undefined,
      config: configState(s),
      vars: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, preview: maskValue(value), secret: looksSecret(name) })),
    };
  }

  // ---------- platform accounts ----------

  const accounts = new AccountRegistry();
  await accounts.load();
  let profileCache: Profile[] | undefined;
  const profiles = () => (profileCache ??= manager.store.profiles());

  /** A running server's profile has since picked different accounts (or was deleted): a restart applies them. */
  function accountsStale(s: Server): boolean {
    if (!ACTIVE.includes(s.status)) return false;
    const inProfile = (id: number) => profiles().find((p) => p.id === id);
    if (s.accounts) {
      const p = inProfile(s.accounts.profile.id);
      return !p || canonical(p.accounts) !== canonical(s.accounts.selections);
    }
    return false;
  }

  /** Selections as a string that ignores key order. */
  function canonical(sel: Selections): string {
    return JSON.stringify(
      Object.keys(sel)
        .sort()
        .map((id) => [id, Object.entries(sel[id]).sort(([a], [b]) => a.localeCompare(b))]),
    );
  }

  /** Which profile's accounts a start uses; see StartRequest.profile. */
  function accountProfile(existing: Server | undefined, req: StartRequest): { profile?: Profile; note?: string } {
    const picks = (p?: Profile) => (p && Object.keys(p.accounts).length ? p : undefined);
    if (req.profile === null || req.profile === "none") return {};
    if (req.profile !== undefined) return { profile: picks(profileRef(req.profile)) };
    if (!existing) return {};
    const candidates = profiles().filter((p) => p.servers.includes(existing.id) && picks(p));
    const last = candidates.find((p) => p.id === existing.accounts?.profile.id);
    if (last) return { profile: last };
    if (candidates.length === 1) return { profile: candidates[0] };
    if (candidates.length > 1) {
      return {
        note:
          `${existing.id} is in several profiles that pick accounts (${candidates.map((p) => p.name).join(", ")}), so it started with this machine's accounts. ` +
          `Start it from a profile to use that profile's.`,
      };
    }
    return {};
  }

  function accountsChanged() {
    manager.emit("accounts", {});
  }
  syncProxy();
  manager.startMonitor();

  const allowedHosts = new Set([`127.0.0.1:${DAEMON_PORT}`, `localhost:${DAEMON_PORT}`]);

  function defaultName(root: string): string {
    const names = Object.keys(loadConfig(root).servers ?? {});
    if (names.length === 1) return names[0];
    const existing = manager.list().filter((s) => s.root === root);
    if (existing.length === 1) return existing[0].name;
    if (names.length > 1) throw new HttpError(400, `several servers are configured (${names.join(", ")}); pass a name`);
    return "dev";
  }

  /** Resolve a server reference: full id, or name within the project (falls back to a globally unique name when reading). */
  function resolveRef(root: string | undefined, ref: string | undefined, mutate: boolean): Server {
    const all = manager.list();
    if (ref?.includes(":")) {
      const s = manager.servers.get(ref);
      if (s) return s;
    }
    const inProject = all.filter((s) => s.root === root);
    if (!ref) {
      if (inProject.length === 1) return inProject[0];
      throw new HttpError(400, inProject.length ? `pass a server name (${inProject.map((s) => s.name).join(", ")})` : "no servers in this project");
    }
    const hit = inProject.find((s) => s.name === ref);
    if (hit) return hit;
    const global = all.filter((s) => s.name === ref);
    if (!mutate && global.length === 1) return global[0];
    const known = all.map((s) => s.id).join(", ") || "none";
    throw new HttpError(404, `no server "${ref}" in ${root ?? "this project"}${global.length ? ` (use the full id: ${global.map((s) => s.id).join(", ")})` : ""}. Known servers: ${known}`);
  }

  function logTail(s: Server, n = 30): string {
    return queryLines(readFrom(s.logFile, 0, 256 * 1024), { tail: n, maxChars: 6000 }).lines.join("\n");
  }

  async function start(req: StartRequest): Promise<StartResponse> {
    let existing: Server | undefined;
    if (req.id) {
      existing = manager.servers.get(req.id);
      if (!existing) throw new HttpError(404, `unknown server ${req.id}`);
      req.root = existing.root;
      req.name = existing.name;
    }
    if (!req.root) throw new HttpError(400, "root is required");
    const root = path.resolve(req.root);
    const name = req.name || defaultName(root);
    if (!/^[\w.-]+$/.test(name)) throw new HttpError(400, `invalid server name "${name}" (use letters, digits, . _ -)`);
    existing ??= manager.find(root, name);

    const conf = loadConfig(root).servers?.[name];
    const cwdOverride = req.cwd ? path.resolve(req.clientCwd ?? root, req.cwd) : undefined;
    let command: string | undefined;
    let cwd: string;
    let portArgs: string | undefined;
    let detected: string | undefined;
    if (req.command) {
      command = req.command;
      cwd = cwdOverride ?? req.clientCwd ?? root;
    } else if (conf) {
      command = conf.command;
      cwd = cwdOverride ?? path.resolve(root, conf.cwd ?? ".");
    } else if (existing) {
      command = existing.command;
      cwd = cwdOverride ?? existing.cwd;
    } else {
      cwd = cwdOverride ?? req.clientCwd ?? root;
      const d = detectCommand(cwd, root);
      if (d) {
        command = d.command;
        portArgs = d.portArgs;
        detected = d.kind;
      }
    }
    if (!command) {
      throw new HttpError(
        400,
        `don't know how to start "${name}" in ${cwd}: no command given, no servedev.json entry, and no package.json dev script. ` +
          `Pass one: servedev start ${name} -- <command>`,
      );
    }
    const plan = planInstall(cwd, root);
    if (req.install && !plan) throw new HttpError(400, `--install: no package.json in ${cwd}`);
    let setup = req.setup ?? (req.install ? plan!.setup : undefined) ?? conf?.setup ?? existing?.setup;
    // A detected JS dev script with no dependencies installed would just fail; install first.
    if (!setup && detected && plan?.state === "missing") setup = plan.setup;
    const installing = !!plan && setup === plan.setup;
    const hostname = req.hostname ? normalizeHostname(req.hostname) : conf?.hostname ? normalizeHostname(conf.hostname) : existing?.hostname;
    const taken = hostname && manager.list().find((o) => o.hostname === hostname && !(o.root === root && o.name === name));
    if (taken) throw new HttpError(409, `${hostname} is already used by ${taken.id}`);
    let portSpec = req.port ?? conf?.port ?? existing?.portSpec;
    if (portSpec === undefined && command.includes("{port}")) portSpec = "auto";
    const hasReady = req.ready && Object.values(req.ready).some((v) => v !== undefined);
    const ready = (hasReady ? req.ready : undefined) ?? normalizeReady(conf?.ready) ?? existing?.ready ?? {};
    // Only variables set on purpose are kept with the server; the login shell supplies the rest at each start.
    const login = await getLoginEnv();
    let env = existing?.env ?? {};
    if (req.env) env = explicitPart(req.env, login);
    if (req.vars) env = applyVars(req.replaceVars ? {} : env, req.vars);
    const baseEnv = { ...login, ...conf?.env };
    const { profile: picker, note: accountsNote } = accountProfile(existing, req);
    let accountEnv: Record<string, string> | undefined;
    if (picker && !(existing && ACTIVE.includes(existing.status) && !req.restart)) {
      try {
        accountEnv = await accounts.env(picker.accounts);
      } catch (e) {
        throw new HttpError(409, `can't start with ${picker.name}'s accounts: ${(e as Error).message}`);
      }
    }
    const serverAccounts = picker && accountEnv ? { profile: { id: picker.id, name: picker.name }, selections: picker.accounts } : undefined;

    let result;
    try {
      result = await manager.start(
        { root, name, command, cwd, env, baseEnv, portSpec, portArgs, setup, hostname, ready, accountEnv, accounts: serverAccounts },
        req.restart,
      );
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    const s = result.server;
    if (hostname) syncProxy();
    const res: StartResponse = { server: view(s), alreadyRunning: result.alreadyRunning, detected, accountsNote };
    if (!result.alreadyRunning && installing) res.install = plan;
    else if (plan?.state === "stale" || (plan?.state === "missing" && !installing)) res.installHint = plan;
    if (req.wait !== false) {
      const timeoutSec = req.timeout ?? conf?.timeout ?? (s.setup ? 300 : 60);
      res.ready = await manager.waitReady(s.id, timeoutSec * 1000);
      res.server = view(s);
      if (!res.ready.ok) res.logTail = logTail(s);
    }
    return res;
  }

  /** Servers declared in servedev.json of known projects that have never been started. */
  /** What the dashboard needs to prefill "new server" for a folder. */
  function inspectDir(raw: string) {
    const dir = path.resolve(raw.trim().replace(/^~(?=$|\/)/, os.homedir()));
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {}
    if (!isDir) return { dir, exists: false };
    const root = findRoot(dir);
    let configError: string | undefined;
    let servers: Record<string, { command: string }> = {};
    try {
      servers = loadConfig(root).servers ?? {};
    } catch (e) {
      configError = (e as Error).message;
    }
    const existing = manager.list().filter((s) => s.root === root);
    const detected = detectCommand(dir, root);
    const taken = new Set([...existing.map((s) => s.name), ...Object.keys(servers)]);
    const base = dir === root ? "dev" : path.basename(dir).toLowerCase().replace(/[^\w.-]+/g, "-") || "dev";
    let suggestedName = base;
    for (let i = 2; taken.has(suggestedName); i++) suggestedName = `${base}-${i}`;
    return {
      dir,
      exists: true,
      root,
      project: manager.projectLabel(root),
      detected: detected && { command: detected.command, kind: detected.kind },
      install: planInstall(dir, root),
      configured: Object.entries(servers).map(([name, c]) => ({
        name,
        command: c.command,
        status: existing.find((s) => s.name === name)?.status,
      })),
      existing: existing.map((s) => ({ name: s.name, status: s.status })),
      suggestedName,
      configError,
    };
  }

  let picking = false;
  /** Native folder picker on the machine running the daemon. Resolves to null when cancelled. */
  async function pickFolder(start?: string): Promise<string | null> {
    if (picking) throw new HttpError(409, "a folder picker is already open");
    let cmd: string[];
    if (process.platform === "darwin") {
      const from = start && fs.existsSync(start) ? ` default location (POSIX file ${JSON.stringify(start)})` : "";
      // `activate` brings osascript's own dialog to the front; no Automation permission needed.
      cmd = ["osascript", "-e", "activate", "-e", `POSIX path of (choose folder with prompt "Choose a folder to run a dev server in"${from})`];
    } else if (Bun.which("zenity")) {
      cmd = ["zenity", "--file-selection", "--directory", "--title=Choose a folder to run a dev server in", ...(start ? [`--filename=${start}/`] : [])];
    } else {
      throw new HttpError(501, "no native folder picker on this system; type the path instead");
    }
    picking = true;
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code === 0) return out.trim().replace(/(.)\/$/, "$1") || null;
      if (proc.signalCode || /-128|cancel/i.test(err) || (cmd[0] === "zenity" && code === 1)) return null;
      throw new HttpError(500, `folder picker failed: ${err.trim() || `exit ${code}`}`);
    } finally {
      picking = false;
    }
  }

  function search(req: SearchRequest): SearchResponse {
    if (!req.query && !req.preset) throw new HttpError(400, "pass a query or a preset (errors, warnings)");
    if (req.preset && !PRESETS[req.preset]) throw new HttpError(400, `unknown preset "${req.preset}" (use errors or warnings)`);
    const re = req.preset ? PRESETS[req.preset] : toRegex(req.query!);
    let targets: Server[];
    if (req.servers?.length) targets = req.servers.map((ref) => resolveRef(req.root, ref, false));
    else {
      targets = req.all ? manager.list() : manager.list().filter((s) => s.root === req.root);
      if (!targets.length) {
        throw new HttpError(404, `no servers in ${req.root ?? "this project"}${manager.list().length ? "; pass all to search every project" : ""}`);
      }
    }
    const sinceMs = req.since ? parseDuration(req.since) : undefined;
    const results: SearchResult[] = [];
    let searched = 0;
    for (const s of targets) {
      for (const { file, info } of runsFor(s, req.runs ?? "current")) {
        const size = fileSize(file);
        if (!size) continue;
        // --since means "written in the last N", so runs that ended before the window are skipped.
        if (sinceMs !== undefined && !info.current && (info.stoppedAt ?? 0) < Date.now() - sinceMs) continue;
        searched++;
        const raw = readFrom(file, 0);
        const fromLine =
          sinceMs !== undefined && info.current && size <= 4 * 1024 * 1024
            ? lineAtOffset(raw, manager.offsetSince(s.id, sinceMs))
            : undefined;
        const { blocks, total } = searchLines(raw, re, { context: req.context ?? 2, limit: req.limit ?? 20, fromLine });
        if (total) results.push({ id: s.id, name: s.name, project: s.project, status: s.status, exitCode: s.exitCode, run: info, total, blocks });
      }
    }
    return { pattern: req.preset ? `${req.preset} preset` : `/${req.query}/i`, searched, results };
  }

  function currentRunInfo(s: Server): RunInfo {
    return { id: s.runId, current: true, status: s.status, exitCode: s.exitCode, startedAt: s.startedAt, stoppedAt: s.stoppedAt };
  }

  function runInfo(s: Server, r: Run): RunInfo {
    if (r.id === s.runId) return currentRunInfo(s);
    return { id: r.id, current: false, status: r.status, exitCode: r.exitCode, startedAt: r.startedAt, stoppedAt: r.stoppedAt };
  }

  /** Log files to read for a server, newest first. */
  function runsFor(s: Server, which: "current" | "previous" | "both" | "all"): { file: string; info: RunInfo }[] {
    const current = { file: s.logFile, info: currentRunInfo(s) };
    const prev = () => {
      const r = manager.store.previousRun(s.id, s.runId);
      return r ? [{ file: r.logFile, info: runInfo(s, r) }] : [];
    };
    if (which === "current") return [current];
    if (which === "previous") return prev();
    if (which === "both") return [current, ...prev()];
    return manager.store.runs(s.id, 500).map((r) => (r.id === s.runId ? current : { file: r.logFile, info: runInfo(s, r) }));
  }

  /** The run a logs request refers to: ?run=<id>, ?prev=1, or the current run. */
  function pickRun(s: Server, runParam: string | null, prev: boolean): { file: string; info: RunInfo } {
    if (runParam) {
      const r = manager.store.run(Number(runParam));
      if (!r || r.serverId !== s.id) throw new HttpError(404, `${s.id} has no run ${runParam}; list them with servedev runs ${s.name}`);
      return { file: r.id === s.runId ? s.logFile : r.logFile, info: runInfo(s, r) };
    }
    if (prev) {
      const [p] = runsFor(s, "previous");
      if (!p) throw new HttpError(404, `${s.id} has no earlier run`);
      return p;
    }
    return { file: s.logFile, info: currentRunInfo(s) };
  }

  function settings() {
    return Object.fromEntries(
      (Object.keys(SETTINGS) as SettingKey[]).map((k) => [k, { value: manager.store.getSetting(k), ...SETTINGS[k] }]),
    );
  }

  function accountSelections(raw: unknown): Selections {
    try {
      return accounts.normalize(raw);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }

  /** Provider errors are the user's to fix (bad account, CLI missing), not daemon failures. */
  async function accountCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
  }

  function profileRef(ref: unknown): Profile {
    const p = ref === undefined ? undefined : manager.store.profile(ref as string | number);
    if (!p) {
      const names = manager.store.profiles().map((x) => x.name);
      throw new HttpError(404, `no profile "${ref}"${names.length ? ` (have: ${names.join(", ")})` : "; create one with servedev profile create <name>"}`);
    }
    return p;
  }

  /** Server refs from a client (names within `root`, or ids) to ids. */
  function serverIds(root: string | undefined, refs: unknown): string[] {
    if (!Array.isArray(refs)) return [];
    return refs.map((r) => resolveRef(root, String(r), false).id);
  }

  function profilesChanged() {
    profileCache = undefined;
    manager.emit("profiles", manager.store.profiles());
    // Servers started with a profile's accounts may now be out of date.
    for (const s of manager.list()) if (s.accounts) manager.emit("change", s);
  }

  /** Start a profile's servers in order, waiting for each; servers outside the profile are left alone. */
  function startProfile(p: Profile, timeout?: number): Promise<ProfileStartResult[]> {
    return startSequence(p.servers, timeout, p.id);
  }

  /** Start servers one after another (each waits for the previous to be ready); running ones are skipped. */
  async function startSequence(ids: string[], timeout?: number, profile?: number | null): Promise<ProfileStartResult[]> {
    const results: ProfileStartResult[] = [];
    for (const id of ids) {
      const s = manager.servers.get(id);
      if (!s) continue;
      if (s.status === "running" || s.status === "starting") {
        results.push({ id, ok: true, alreadyRunning: true, url: s.url });
        continue;
      }
      try {
        const r = await start({ id, root: s.root, clientCwd: s.cwd, wait: true, timeout, profile });
        results.push({ id, ok: !!r.ready?.ok, url: r.server.url, reason: r.ready?.ok ? undefined : r.ready?.reason });
      } catch (e) {
        results.push({ id, ok: false, reason: (e as Error).message });
      }
    }
    return results;
  }

  /** The server's processes, grouped by process group, each group as a tree. */
  async function processGroups(s: Server): Promise<ProcessGroup[]> {
    if (!ACTIVE.includes(s.status) || !s.pid) return [];
    const [table, ls] = await Promise.all([processTable(), listeners()]);
    const groups = s.pgids?.length ? s.pgids : [s.pid];
    const byPid = new Map(table.map((p) => [p.pid, p]));
    return groups
      .map((pgid): ProcessGroup => {
        const members = table.filter((p) => p.pgid === pgid);
        const inGroup = new Set(members.map((p) => p.pid));
        const leader = byPid.get(pgid);
        const parent = leader && byPid.get(leader.ppid);
        const createdBy = pgid === s.pid ? "servedev" : parent ? programName(parent.command) : "a process that has exited";
        const ordered: ProcessGroup["processes"] = [];
        const visit = (p: Proc, depth: number) => {
          ordered.push({
            pid: p.pid,
            ppid: p.ppid,
            depth,
            command: maskSecrets(p.command),
            ports: [...new Set(ls.filter((l) => l.pid === p.pid).map((l) => l.port))].sort((a, b) => a - b),
          });
          for (const c of members.filter((m) => m.ppid === p.pid)) visit(c, depth + 1);
        };
        for (const root of members.filter((m) => !inGroup.has(m.ppid))) visit(root, 0);
        return { pgid, createdBy, processes: ordered };
      })
      .filter((g) => g.processes.length > 0);
  }

  /**
   * Poller that follows a server's current log: starts `backlog` bytes from the end, and resets
   * when the server restarts (new run, new file) or the file is truncated.
   */
  function followLog(id: string, backlog: number, onReset: () => void, onData: (text: string) => void): () => void {
    let file = manager.servers.get(id)?.logFile ?? "";
    let offset = Math.max(0, fileSize(file) - backlog);
    onReset();
    return () => {
      const current = manager.servers.get(id)?.logFile ?? "";
      if (current !== file) {
        file = current;
        offset = 0;
        onReset();
      }
      const size = fileSize(file);
      if (size < offset) {
        offset = 0;
        onReset();
      }
      if (size > offset) {
        const text = readFrom(file, offset);
        offset = size;
        onData(text);
      }
    };
  }

  function layoutItems(raw: unknown): LayoutItem[] {
    if (!Array.isArray(raw)) throw new HttpError(400, "layout items must be an array");
    return (raw as LayoutItem[]).map((it) => {
      if (typeof it?.i !== "string" || ![it.x, it.y, it.w, it.h].every((n) => Number.isInteger(n) && n >= 0)) {
        throw new HttpError(400, "each layout item needs i (server id) and whole-number x, y, w, h");
      }
      return { i: it.i, x: it.x, y: it.y, w: it.w, h: it.h, ...(it.mode === "preview" ? { mode: "preview" as const } : {}) };
    });
  }

  /** Dev servers listening from inside a project that servedev didn't start. */
  async function scanExternal(): Promise<ExternalServer[]> {
    const [ls, table] = await Promise.all([listeners(), processTable()]);
    const groups = new Set(manager.list().filter((s) => ACTIVE.includes(s.status)).flatMap((s) => (s.pgids?.length ? s.pgids : s.pid ? [s.pid] : [])));
    const managed = new Set(table.filter((p) => groups.has(p.pgid)).map((p) => p.pid));
    const byPid = new Map(table.map((p) => [p.pid, p]));
    const launchers = new Set<number>();
    const lookup = new Set<number>();
    for (const l of ls) {
      if (managed.has(l.pid) || l.pid === process.pid) continue;
      const launcher = launcherOf(l.pid, byPid);
      if (!launcher) continue;
      launchers.add(launcher.pid);
      lookup.add(launcher.pid).add(l.pid);
    }
    const [cwds, started] = await Promise.all([cwdsOf([...lookup]), startTimesOf([...launchers])]);
    return detectExternal({ table, listeners: ls, managed, cwds, started, self: process.pid });
  }

  function externalView(e: ExternalServer, others: ExternalServer[] = []) {
    // Unique among this project's servers and the other outside servers found alongside it.
    const taken = new Set(manager.list().filter((s) => s.root === e.root).map((s) => s.name));
    for (const o of others) if (o.root === e.root && o.id !== e.id && o.pid < e.pid) taken.add(suggestName(o));
    const base = suggestName(e);
    let suggestedName = base;
    for (let i = 2; taken.has(suggestedName); i++) suggestedName = `${base}-${i}`;
    // Aux ports (e.g. Vite's HMR on 24678) sort after the app's own port.
    const port = e.ports.find((p) => p < 10000) ?? e.ports[0];
    const project = e.orphaned ? path.basename(e.root) : manager.projectLabel(e.root);
    return {
      ...e,
      command: maskSecrets(e.command),
      project,
      suggestedName,
      url: port ? `http://localhost:${port}` : undefined,
      branch: e.orphaned ? undefined : gitBranch(e.cwd),
    };
  }

  /** Stop an outside server's own process tree (not its whole process group, which may hold a shell). */
  async function stopTree(pids: number[]) {
    const alive = () => pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    const signal = (sig: NodeJS.Signals) => alive().forEach((pid) => {
      try {
        process.kill(pid, sig);
      } catch {}
    });
    signal("SIGTERM");
    for (let i = 0; i < 50 && alive().length; i++) await Bun.sleep(100);
    if (alive().length) {
      signal("SIGKILL");
      for (let i = 0; i < 20 && alive().length; i++) await Bun.sleep(100);
    }
  }

  /** Stop and forget servers, and take them off profiles (via the database) and saved grids. */
  async function removeServers(ids: string[]) {
    for (const id of ids) await manager.remove(id);
    for (const scope of manager.store.dropFromLayouts(ids)) manager.emit("layout", { scope, source: null });
    manager.emit("profiles", manager.store.profiles());
    syncProxy();
  }

  function configured() {
    const roots = [...new Set(manager.list().map((s) => s.root))];
    const out: { root: string; project: string; name: string; command: string; branch?: string }[] = [];
    for (const root of roots) {
      let conf;
      try {
        conf = loadConfig(root);
      } catch {
        continue;
      }
      for (const [name, c] of Object.entries(conf.servers ?? {})) {
        if (!manager.find(root, name)) out.push({ root, project: manager.projectLabel(root), name, command: c.command, branch: branchOf(root) });
      }
    }
    return out;
  }

  function sse(req: Request, setup: (send: (event: string, data: unknown) => void) => () => void): Response {
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {}
        };
        const ping = setInterval(() => send("ping", {}), 15_000);
        const inner = setup(send);
        cleanup = () => {
          clearInterval(ping);
          inner();
        };
        req.signal.addEventListener("abort", () => {
          cleanup();
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  async function handle(req: Request, url: URL): Promise<Response | object> {
    const p = url.pathname;
    const q = url.searchParams;
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, any>) : {};

    if (p === "/api/health") return { ok: true, version: VERSION, pid: process.pid };
    if (p === "/api/pin" && req.method === "POST") {
      const s = resolveRef(body.root, body.id ?? body.name, true);
      manager.setPinned(s.id, body.pinned !== false);
      // Pinned servers start at login; make sure the login item exists.
      const autostart = s.pinned && !autostartStatus().installed ? installAutostart(selfCommand()) : autostartStatus();
      return { server: view(s), autostart };
    }
    if (p === "/api/hostname" && req.method === "POST") {
      const s = resolveRef(body.root, body.id ?? body.name, true);
      const hostname = body.hostname ? normalizeHostname(String(body.hostname)) : undefined;
      try {
        manager.setHostname(s.id, hostname);
      } catch (e) {
        throw new HttpError(409, (e as Error).message);
      }
      syncProxy();
      const resolvesLocally = !hostname || hostname.endsWith(".localhost");
      return {
        server: view(s),
        proxy: proxyStatus(),
        note: resolvesLocally ? undefined : `${hostname} doesn't point at this Mac by itself; add "127.0.0.1 ${hostname}" to /etc/hosts, or use a .localhost name.`,
      };
    }
    if (p === "/api/proxy") return { ...proxyStatus(), hostnames: manager.list().flatMap((s) => (s.hostname ? [{ hostname: s.hostname, id: s.id, url: proxy.urlFor(s.hostname) }] : [])) };
    if (p === "/api/autostart") {
      if (req.method === "POST") return body.enabled === false ? uninstallAutostart() : installAutostart(selfCommand());
      return autostartStatus();
    }
    if (p === "/api/profiles" && req.method === "GET") return { profiles: manager.store.profiles() };
    if (p === "/api/accounts" && req.method === "GET") {
      if (q.get("refresh") === "1") {
        await accounts.load(true);
        accounts.invalidate();
      }
      return { providers: await accounts.states(), hidden: await accounts.hidden(), errors: accounts.errors, dir: PROVIDERS_DIR };
    }
    if (p === "/api/accounts/options") {
      const selection = q.get("selection") ? JSON.parse(q.get("selection")!) : {};
      return { options: await accountCall(() => accounts.options(q.get("provider") ?? "", q.get("field") ?? "", selection)) };
    }
    // Would these picks work? Same checks as a start (saved credentials, CLI tokens), without starting anything.
    if (p === "/api/accounts/check" && req.method === "POST") {
      try {
        await accounts.env(accounts.normalize(body.accounts));
        return {};
      } catch (e) {
        return { error: (e as Error).message };
      }
    }
    if (p === "/api/accounts/set" && req.method === "POST") {
      await accountCall(() => accounts.set(String(body.provider), String(body.field), String(body.value ?? "")));
      accountsChanged();
      return { provider: await accounts.state(accounts.get(String(body.provider))) };
    }
    // Adding platforms: the catalog, custom JSON providers, and dry runs of either.
    if (p === "/api/accounts/catalog") return { entries: await accounts.catalog(), dir: PROVIDERS_DIR };
    if (p === "/api/accounts/providers" && req.method === "POST") {
      const raw = body.catalog ? await accountCall(async () => accounts.catalogSpec(String(body.catalog))) : body.spec;
      const r = await accountCall(() => accounts.saveSpec(raw, { replace: !!body.replace, override: !!body.override }));
      accountsChanged();
      const state = (await accounts.available()).some((x) => x.id === r.spec.id) ? await accounts.state(accounts.get(r.spec.id)) : undefined;
      return { ...r, provider: state, installed: !!state };
    }
    if (p === "/api/accounts/providers/delete" && req.method === "POST") {
      const id = String(body.id ?? "");
      const r = await accountCall(() => accounts.removeSpec(id));
      accountsChanged();
      // Profiles that picked accounts for it would fail to start (and to save), so their picks go too.
      // A built-in with the same id comes back, and keeps them.
      const usedBy = r.restoredBuiltIn ? [] : profiles().filter((x) => x.accounts[id]);
      for (const x of usedBy) {
        const { [id]: _, ...rest } = x.accounts;
        manager.store.updateProfile(x.id, { accounts: rest });
      }
      if (usedBy.length) profilesChanged();
      return { removed: id, ...r, clearedFrom: usedBy.map((x) => x.name) };
    }
    {
      const m = p.match(/^\/api\/accounts\/providers\/([a-z][a-z0-9-]*)\/spec$/);
      if (m) return accountCall(() => accounts.specOf(m[1]));
    }
    if (p === "/api/accounts/test" && req.method === "POST") {
      return accounts.testSpec(body.spec, body.selection ?? {});
    }
    if (p === "/api/accounts/action" && req.method === "POST") {
      const message = await accountCall(() => accounts.action(String(body.provider), String(body.action), body.args ?? {}));
      accountsChanged();
      return { message, provider: await accounts.state(accounts.get(String(body.provider))) };
    }
    if (p === "/api/profiles" && req.method === "POST") {
      const name = String(body.name ?? "").trim();
      if (!name) throw new HttpError(400, "a profile needs a name");
      if (manager.store.profile(name)) throw new HttpError(409, `a profile called "${name}" already exists`);
      const layout = body.layout === undefined ? undefined : layoutItems(body.layout);
      const ids = body.running
        ? manager.list().filter((s) => s.status === "running" || s.status === "starting").map((s) => s.id)
        : layout
          ? layout.map((it) => resolveRef(undefined, it.i, false).id)
          : serverIds(body.root, body.servers);
      const profile = manager.store.createProfile(name, ids, accountSelections(body.accounts));
      // Saving a custom grid as a profile keeps its arrangement.
      if (layout) {
        manager.store.setLayout(`profile:${profile.id}`, layout);
        manager.emit("layout", { scope: `profile:${profile.id}`, source: body.source ?? null });
      }
      profilesChanged();
      return { profile };
    }
    if (p === "/api/profiles/update" && req.method === "POST") {
      const current = profileRef(body.id ?? body.profile);
      let servers = body.servers ? serverIds(body.root, body.servers) : current.servers;
      if (body.add) servers = [...servers, ...serverIds(body.root, body.add)];
      if (body.remove) {
        const drop = new Set(serverIds(body.root, body.remove));
        servers = servers.filter((id) => !drop.has(id));
      }
      const rename = body.rename === undefined ? undefined : String(body.rename).trim();
      if (rename !== undefined && !rename) throw new HttpError(400, "a profile needs a name");
      if (rename && manager.store.profile(rename) && manager.store.profile(rename)!.id !== current.id) {
        throw new HttpError(409, `a profile called "${rename}" already exists`);
      }
      let picks: Selections | undefined;
      if (body.accounts !== undefined) picks = accountSelections(body.accounts);
      // Change some fields and keep the rest: a provider set to null, or a field set to null or "", is cleared.
      if (body.mergeAccounts) {
        const merged: Record<string, Record<string, unknown> | null> = { ...current.accounts };
        for (const [id, sel] of Object.entries(body.mergeAccounts as Record<string, Record<string, unknown> | null>)) {
          merged[id] = sel === null ? null : { ...(current.accounts[id] ?? {}), ...sel };
        }
        picks = accountSelections(merged);
      }
      const profile = manager.store.updateProfile(current.id, { name: rename, servers, accounts: picks });
      profilesChanged();
      return { profile };
    }
    if (p === "/api/profiles/delete" && req.method === "POST") {
      const profile = profileRef(body.id ?? body.profile);
      manager.store.deleteProfile(profile.id);
      manager.store.deleteLayout(`profile:${profile.id}`);
      profilesChanged();
      return { deleted: profile.name };
    }
    // Bulk actions for the dashboard: the servers of whatever it's showing (all, a profile, a grid).
    if (p === "/api/servers/start" && req.method === "POST") {
      const ids = serverIds(undefined, body.ids);
      if (body.wait === false) {
        void startSequence(ids, body.timeout, body.profile);
        return { starting: ids };
      }
      return { results: await startSequence(ids, body.timeout, body.profile) };
    }
    if (p === "/api/servers/stop" && req.method === "POST") {
      const ids = serverIds(undefined, body.ids);
      await Promise.all(ids.map((id) => manager.stop(id)));
      return { stopped: ids };
    }
    if (p === "/api/profiles/start" && req.method === "POST") {
      const profile = profileRef(body.id ?? body.profile);
      if (body.wait === false) {
        void startProfile(profile, body.timeout);
        return { profile, started: true };
      }
      return { profile, results: await startProfile(profile, body.timeout) };
    }
    if (p === "/api/search" && req.method === "POST") return search(body as SearchRequest);
    if (p === "/api/frame-check") {
      // Follow redirects by hand (login pages are where anti-framing headers usually live).
      let url = q.get("url") ?? "";
      if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+\.localhost)(:\d+)?(\/|$)/i.test(url)) {
        throw new HttpError(400, "only local URLs can be checked");
      }
      for (let hop = 0; hop < 5; hop++) {
        let res: Response;
        try {
          res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "sec-fetch-dest": "iframe" } });
        } catch (e) {
          return { frameable: false, url, reason: `couldn't load it: ${(e as Error).message}` };
        }
        const verdict = frameVerdict(res.headers, `http://127.0.0.1:${DAEMON_PORT}`);
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!verdict.frameable || res.status < 300 || res.status >= 400 || !location) return { ...verdict, url };
        url = new URL(location, url).toString();
      }
      return { frameable: true, url };
    }
    if (p === "/api/external" && req.method === "GET") {
      const found = await scanExternal();
      return { servers: found.map((e) => externalView(e, found)) };
    }
    // Servers still running from deleted folders (e.g. removed worktrees). Stops the given ids (what
    // the user confirmed), re-checked against a fresh scan; without ids, every such server.
    if (p === "/api/external/stop-hung" && req.method === "POST") {
      const hung = (await scanExternal()).filter((e) => e.orphaned);
      const wanted = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : undefined;
      const targets = wanted ? hung.filter((e) => wanted.has(e.id)) : hung;
      await Promise.all(targets.map((e) => stopTree(e.pids)));
      return { stopped: targets.map((e) => externalView(e, hung)) };
    }
    if (p === "/api/external/stop" && req.method === "POST") {
      const e = (await scanExternal()).find((x) => x.id === body.id);
      if (!e) throw new HttpError(404, "that server isn't running anymore");
      await stopTree(e.pids);
      return { stopped: e.id };
    }
    if (p === "/api/external/takeover" && req.method === "POST") {
      // Re-scan so we act on what's running now, not what the dashboard last saw.
      const e = (await scanExternal()).find((x) => x.id === body.id);
      if (!e) throw new HttpError(404, "that server isn't running anymore (or servedev already manages it)");
      if (e.orphaned) throw new HttpError(409, `its folder ${e.cwd} was deleted, so there's nothing to restart it from; stop it instead`);
      // The dashboard shows the command with credentials masked; unchanged means "the real one".
      const sent = body.command === undefined ? undefined : String(body.command).trim();
      const command = sent === undefined || maskSecrets(sent) === maskSecrets(e.command) ? e.command : sent;
      if (!command) throw new HttpError(400, "a command is needed to start it again");
      await stopTree(e.pids);
      // Give the ports a moment to be released before the same command binds them again.
      for (let i = 0; i < 30 && (await listeners()).some((l) => e.ports.includes(l.port)); i++) await Bun.sleep(100);
      // Keep its port. Ports in the command (vite --port 5213) come back by themselves; otherwise the
      // original probably read $PORT from an environment servedev can't see, so pass it on.
      const port = e.ports.find((x) => x < 10000) ?? e.ports[0];
      const keepPort = port && !new RegExp(`\\b${port}\\b`).test(command) ? port : undefined;
      return start({
        root: e.root,
        clientCwd: e.cwd,
        port: keepPort,
        name: body.name ? String(body.name) : externalView(e).suggestedName,
        // The command runs where it was started (e.g. a monorepo root for pnpm --filter).
        command,
        hostname: body.hostname || undefined,
        wait: body.wait,
      });
    }
    // Save a server into its repo's servedev.json (GET previews, POST writes).
    if (p === "/api/config") {
      const s = resolveRef(undefined, (req.method === "POST" ? body.id : q.get("id")) ?? undefined, false);
      if (req.method !== "POST") return { server: s.id, ...planSave(s, { includeSecrets: q.get("includeSecrets") === "1" }) };
      try {
        const r = saveToConfig(s, { force: !!body.force, includeSecrets: !!body.includeSecrets });
        manager.emit("change", s);
        return { server: s.id, ...r };
      } catch (e) {
        if (e instanceof ConfigConflict) throw new HttpError(409, e.message);
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (p === "/api/inspect") return inspectDir(q.get("dir") ?? "");
    if (p === "/api/pick-folder" && req.method === "POST") return { path: await pickFolder(body.start) };
    if (p === "/api/servers") return { servers: manager.list().map(view), configured: configured() };
    if (p === "/api/start" && req.method === "POST") return start(body as StartRequest);
    if (p === "/api/stop" && req.method === "POST") {
      const s = resolveRef(body.root, body.id ?? body.name, true);
      return { server: view(await manager.stop(s.id)) };
    }
    if (p === "/api/restart" && req.method === "POST") {
      const s = resolveRef(body.root, body.id ?? body.name, true);
      return start({
        id: s.id,
        root: s.root,
        clientCwd: s.cwd,
        restart: true,
        wait: body.wait,
        timeout: body.timeout,
        env: body.env,
        vars: body.vars,
        profile: body.profile,
      });
    }
    if (p === "/api/remove" && req.method === "POST") {
      const s = resolveRef(body.root, body.id ?? body.name, true);
      await removeServers([s.id]);
      return { removed: s.id };
    }
    // A tracked folder (project): every server servedev knows in it. Files on disk are untouched.
    if (p === "/api/projects/remove" && req.method === "POST") {
      const root = body.root ? path.resolve(String(body.root)) : manager.list().find((s) => s.project === body.project)?.root;
      const ids = manager.list().filter((s) => s.root === root).map((s) => s.id);
      if (!root || !ids.length) throw new HttpError(404, `servedev isn't tracking any servers in ${body.root ?? body.project}`);
      await removeServers(ids);
      return { removed: ids, root };
    }
    if (p === "/api/wait" && req.method === "POST") {
      const s = resolveRef(body.root, body.id ?? body.name, false);
      const ready = await manager.waitReady(s.id, (body.timeout ?? 60) * 1000);
      return { server: view(s), ready, logTail: ready.ok ? undefined : logTail(s) };
    }
    if (p === "/api/logs") {
      const s = resolveRef(q.get("root") ?? undefined, q.get("id") ?? q.get("name") ?? undefined, false);
      const { file, info } = pickRun(s, q.get("run"), q.get("prev") === "1");
      const since = q.get("since");
      const from = since && info.current ? manager.offsetSince(s.id, parseDuration(since)) : 0;
      const tail = q.get("tail");
      const result = queryLines(readFrom(file, from), {
        tail: tail === "all" ? Infinity : Number(tail ?? 50),
        grep: q.get("grep") ?? undefined,
        maxChars: Number(q.get("maxChars") ?? 20_000),
      });
      const purged = !info.current && !fileSize(file) && !!info.stoppedAt;
      return { server: view(s), run: info, purged, ...result };
    }
    if (p === "/api/processes") {
      const s = resolveRef(q.get("root") ?? undefined, q.get("id") ?? q.get("name") ?? undefined, false);
      return { server: view(s), groups: await processGroups(s) };
    }
    if (p === "/api/runs") {
      const s = resolveRef(q.get("root") ?? undefined, q.get("id") ?? q.get("name") ?? undefined, false);
      const runs = manager.store.runs(s.id, Number(q.get("limit") ?? 50)).map((r) => ({
        ...runInfo(s, r),
        id: r.id,
        command: maskSecrets(r.command),
        port: r.port,
        readyAt: r.id === s.runId ? s.readyAt : r.readyAt,
        logSize: fileSize(r.id === s.runId ? s.logFile : r.logFile),
      }));
      return { server: view(s), runs, retentionDays: Number(manager.store.getSetting("log_retention_days")) };
    }
    if (p === "/api/settings") {
      if (req.method === "POST") {
        const key = body.key as SettingKey;
        if (!(key in SETTINGS)) throw new HttpError(400, `unknown setting "${key}" (have: ${Object.keys(SETTINGS).join(", ")})`);
        const value = String(body.value);
        if (key === "log_retention_days" && !(Number(value) >= 1)) throw new HttpError(400, "log_retention_days must be a number of days, at least 1");
        manager.store.setSetting(key, value);
        if (key === "log_retention_days") manager.purgeOldLogs();
        if (key === "proxy_port") syncProxy(true);
      }
      const migration = manager.store.getMeta("env_migration");
      return { settings: settings(), envMigration: migration ? JSON.parse(migration) : undefined };
    }
    if (p === "/api/stream/events") {
      return sse(req, (send) => {
        send("snapshot", { build: UI_BUILD, servers: manager.list().map(view), configured: configured(), profiles: manager.store.profiles() });
        const onProfiles = (profiles: Profile[]) => send("profiles", profiles);
        manager.on("profiles", onProfiles);
        const onLayout = (change: { scope: string; source: string | null }) => send("layout", change);
        manager.on("layout", onLayout);
        const onAccounts = () => send("accounts", {});
        manager.on("accounts", onAccounts);
        const onChange = (s: Server) => send("server", view(s));
        const onRemove = (s: Server) => send("remove", { id: s.id });
        manager.on("change", onChange);
        manager.on("remove", onRemove);
        return () => {
          manager.off("change", onChange);
          manager.off("remove", onRemove);
          manager.off("profiles", onProfiles);
          manager.off("layout", onLayout);
          manager.off("accounts", onAccounts);
        };
      });
    }
    if (p === "/api/stream/logs") {
      const { id } = resolveRef(undefined, q.get("id") ?? undefined, false);
      return sse(req, (send) => {
        const poll = followLog(id, 200 * 1024, () => send("reset", {}), (text) => send("data", text));
        poll();
        const timer = setInterval(poll, 250);
        return () => clearInterval(timer);
      });
    }
    // Several servers' logs over one connection: browsers allow only ~6 connections per host,
    // so a grid of tiles can't each hold its own stream.
    if (p === "/api/stream/logs-multi") {
      const ids = (q.get("ids") ?? "").split(",").filter(Boolean).map((ref) => resolveRef(undefined, ref, false).id);
      return sse(req, (send) => {
        const polls = ids.map((id) =>
          followLog(id, Number(q.get("backlog") ?? 24 * 1024), () => send("reset", { id }), (text) => send("data", { id, text })),
        );
        const tick = () => polls.forEach((poll) => poll());
        tick();
        const timer = setInterval(tick, 300);
        return () => clearInterval(timer);
      });
    }
    if (p === "/api/layouts" && req.method === "GET") {
      return { scope: q.get("scope") ?? "all", items: manager.store.getLayout(q.get("scope") ?? "all") ?? null };
    }
    if (p === "/api/layouts" && req.method === "POST") {
      const scope = String(body.scope ?? "");
      // "draft": the unsaved custom grid; "profile:<id>": a saved profile's grid.
      if (!/^(draft|all|profile:\d+)$/.test(scope)) throw new HttpError(400, `invalid layout scope "${scope}"`);
      const items = layoutItems(body.items);
      manager.store.setLayout(scope, items);
      // Open dashboards reload this grid; `source` lets the tab that saved it ignore its own change.
      manager.emit("layout", { scope, source: body.source ?? null });
      return { scope, items };
    }
    if (p === "/api/shutdown" && req.method === "POST") {
      setTimeout(() => {
        manager.saveNow();
        process.exit(0);
      }, 50);
      return { ok: true };
    }
    throw new HttpError(404, `not found: ${req.method} ${p}`);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: DAEMON_PORT,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // DNS-rebinding and cross-site protection: only our own host/origin, and a token for the API.
      if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("forbidden host", { status: 403 });
      const origin = req.headers.get("origin");
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) return new Response("forbidden origin", { status: 403 });

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(uiHtml.replace("{{SERVEDEV_TOKEN}}", token).replace("{{SERVEDEV_BUILD}}", UI_BUILD), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
      if (url.pathname !== "/api/health") {
        const given = req.headers.get("x-servedev-token") ?? url.searchParams.get("token");
        if (given !== token) return Response.json({ error: "missing or invalid token" }, { status: 401 });
      }
      try {
        const result = await handle(req, url);
        return result instanceof Response ? result : Response.json(result);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        return Response.json({ error: (e as Error).message }, { status });
      }
    },
  });

  const shutdown = () => {
    manager.saveNow();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`servedev daemon ${VERSION} listening on http://127.0.0.1:${server.port} (pid ${process.pid})`);

  // Launched at login: bring up pinned servers that aren't already running.
  if (opts.autostart) {
    for (const s of manager.list().filter((x) => x.pinned && !["starting", "running", "stopping"].includes(x.status))) {
      try {
        const r = await start({ id: s.id, root: s.root, clientCwd: s.cwd, wait: true });
        console.log(`autostart ${s.id}: ${r.ready?.ok ? `ready at ${r.server.url ?? "(no port)"}` : r.ready?.reason}`);
      } catch (e) {
        console.log(`autostart ${s.id}: ${(e as Error).message}`);
      }
    }
  }
}
