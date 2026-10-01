import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRESETS, fileSize, lineAtOffset, parseDuration, queryLines, readFrom, searchLines, toRegex, type Preset, type SearchBlock } from "./logs";
import { ACTIVE, Manager, publicView, type PublicServer, type ReadyResult, type Server } from "./manager";
import { listeners, processTable, type Proc } from "./ports";
import { HostProxy, type Route } from "./proxy";
import { DAEMON_PORT, DB_FILE, LOCAL_CONFIG, VERSION, getToken } from "./paths";
import { autostartStatus, installAutostart, uninstallAutostart } from "./autostart";
import { gitBranch } from "./git";
import { cwdsOf, detectExternal, launcherOf, startTimesOf, suggestName, type ExternalServer } from "./external";
import { selfCommand } from "./client";
import { configState, mergedEntry, planSave, readyToConfig, sameValue } from "./config-file";
import {
  ConfigConflict,
  ConfigStore,
  SETTINGS,
  mergeSelections,
  resolveConfig,
  type ConfigIssue,
  type LocalConfig,
  type ProfileOverride,
  type ProfileView,
  type Resolved,
  type ServerDef,
  type SettingKey,
} from "./config";
import { buildMigration, describeMigration, dropConfigTables } from "./migrate-config";
import { defaultScanRoots, locate, scanForRepos, type Located } from "./setup";
import { deepEqual } from "./jsonc";
import repoSchema from "../schema/servedev.schema.json";
import localSchema from "../schema/config.schema.json";
import { maskSecrets } from "./sanitize";
import { applyVars, explicitPart, getLoginEnv, looksSecret, maskValue, migrateSnapshot, type EnvMigration } from "./env";
import { AccountRegistry, PROVIDERS_DIR, type Selections } from "./accounts/registry";
import { planInstall, type InstallPlan } from "./install";
import { detectCommand, findRoot, loadConfig, type GridTile, type ReadySpec, type ServerConfig } from "./project";
import type { Run } from "./store";
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
  profile?: string | null;
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
  // Branch per project folder (see branchOf below).
  const branches = new Map<string, string | undefined>();
  await migrateEnvSnapshots();

  // ---------- configuration (JSON files) ----------

  const config = new ConfigStore(LOCAL_CONFIG);
  migrateConfig();
  let resolved: Resolved = resolveConfig(config);
  manager.retentionDays = () => config.setting("log_retention_days");
  manager.sync(resolved.servers.values());

  /**
   * Once: servers, profiles, grids, pins and settings move from the database into config.json.
   * The database is copied first (servedev.db.pre-config) so nothing can be lost.
   */
  function migrateConfig() {
    if (manager.store.getMeta("config_migrated")) return;
    const db = manager.store.db;
    const hasRows = !!db.query("SELECT 1 FROM servers LIMIT 1").get();
    const backup = `${DB_FILE}.pre-config`;
    if (hasRows && !fs.existsSync(backup)) {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      fs.copyFileSync(DB_FILE, backup);
      fs.chmodSync(backup, 0o600);
    }
    const safeRepo = (root: string) => {
      try {
        return loadConfig(root);
      } catch {
        return {};
      }
    };
    const { config: next, report } = buildMigration(db, config.local, safeRepo);
    if (hasRows || Object.keys(report.profileIds).length) {
      config.editLocal((c) => {
        for (const k of Object.keys(c)) delete (c as Record<string, unknown>)[k];
        Object.assign(c, next);
      });
      for (const line of describeMigration(report)) console.log(line);
      if (hasRows) console.log(`  (the database from before is kept at ${backup})`);
    }
    manager.store.setMeta("profile_ids", JSON.stringify(report.profileIds));
    manager.store.setMeta("config_report", JSON.stringify({ at: Date.now(), ...report }));
    dropConfigTables(db);
    manager.store.setMeta("config_migrated", "1");
  }

  /** Re-read config after a file changed (an editor, git, the dashboard, an agent) and apply it. */
  function reconcile() {
    const before = JSON.stringify(resolved.profiles) + JSON.stringify([...resolved.grids]);
    const issuesBefore = JSON.stringify(resolved.issues);
    resolved = resolveConfig(config);
    manager.sync(resolved.servers.values());
    // Keep server branch tags in step with a checkout the config noticed.
    for (const info of resolved.projects.values()) {
      if (branches.has(info.root) && branches.get(info.root) !== info.branch) {
        branches.set(info.root, info.branch);
        for (const s of manager.list()) if (s.root === info.root) manager.emit("change", s);
      }
    }
    if (JSON.stringify(resolved.profiles) + JSON.stringify([...resolved.grids]) !== before) profilesChanged();
    if (JSON.stringify(resolved.issues) !== issuesBefore) manager.emit("config", configSummary());
    syncProxy();
  }
  config.on("change", () => reconcile());
  // git status of servedev.json is part of each shared profile ("uncommitted changes"), so rebuild them.
  config.on("status", () => reconcile());
  config.watch();

  function configSummary() {
    return { file: config.localFile, issues: resolved.issues, files: config.files().map(({ file, kind, exists, error }) => ({ file, kind, exists, error })) };
  }

  /** Config edits turn into HTTP errors the user can act on. */
  function configCall<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof ConfigConflict) throw new HttpError(409, e.message);
      throw new HttpError(400, (e as Error).message);
    }
  }

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
      proxy.start(config.setting("proxy_port"));
      console.log(proxy.running ? `hostname proxy on port ${proxy.port}${proxy.error ? ` (${proxy.error})` : ""}` : `hostname proxy failed: ${proxy.error}`);
      // Every hostname's URL depends on the proxy port.
      for (const s of manager.list()) if (s.hostname) manager.emit("change", s);
    }
  }

  function proxyStatus() {
    return { running: proxy.running, port: proxy.port, error: proxy.error };
  }

  // Branch per project folder. Checked every few seconds so a `git checkout` shows up in the dashboard.
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
      config: configState(s, repoEntry(s.root, s.name)),
      source: resolved.servers.get(s.id)?.source,
      vars: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, preview: maskValue(value), secret: looksSecret(name) })),
    };
  }

  // ---------- platform accounts ----------

  const accounts = new AccountRegistry();
  await accounts.load();
  const profiles = () => resolved.profiles;

  /** A running server's profile has since picked different accounts (or was deleted): a restart applies them. */
  function accountsStale(s: Server): boolean {
    if (!ACTIVE.includes(s.status)) return false;
    const inProfile = (id: string) => profiles().find((p) => p.id === id);
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
  function accountProfile(existing: Server | undefined, req: StartRequest): { profile?: ProfileView; note?: string } {
    const picks = (p?: ProfileView) => (p && Object.keys(p.accounts).length ? p : undefined);
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
    const here = [...resolved.servers.values()].filter((d) => d.root === root).map((d) => d.name);
    if (here.length === 1) return here[0];
    if (here.length > 1) throw new HttpError(400, `several servers are configured here (${here.join(", ")}); pass a name`);
    return "dev";
  }

  /** The servedev.json entry for a server, if its repo defines it. */
  function repoEntry(root: string, name: string): ServerConfig | undefined {
    const e = config.repo(root).servers?.[name];
    return e && typeof e === "object" ? e : undefined;
  }

  /**
   * Record changes to a server in config.json: a server of your own, or your changes on top of
   * servedev.json's. A value that matches the repo's isn't stored; null clears the repo's value.
   */
  function writeServer(project: string, root: string, name: string, patch: Partial<Record<keyof ServerConfig, unknown>>) {
    const repo = repoEntry(root, name);
    config.editLocal((c) => {
      c.servers ??= {};
      const mine = ((c.servers[project] ??= {})[name] ??= {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const repoValue = repo?.[key as keyof ServerConfig];
        if (value === null) {
          if (repoValue === undefined) delete mine[key];
          else mine[key] = null;
        } else if (repo && sameValue(key, repoValue, value)) delete mine[key];
        else mine[key] = value;
      }
    });
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
      const def = resolved.servers.get(req.id);
      if (!existing && !def) throw new HttpError(404, `unknown server ${req.id}`);
      req.root = def?.root ?? existing!.root;
      req.name = def?.name ?? existing!.name;
    }
    if (!req.root) throw new HttpError(400, "root is required");
    const root = path.resolve(req.root);
    const project = configCall(() => config.ensureProject(root));
    if (config.local.projects?.[project] && !resolved.projects.has(project)) reconcile();
    const name = req.name || defaultName(root);
    if (!/^[\w.-]+$/.test(name)) throw new HttpError(400, `invalid server name "${name}" (use letters, digits, . _ -)`);
    const id = `${project}:${name}`;
    existing ??= manager.servers.get(id);
    let def = resolved.servers.get(id);

    // What this request changes about the server; it's remembered in config.json.
    const patch: Partial<Record<keyof ServerConfig, unknown>> = {};
    const cwdOverride = req.cwd ? path.resolve(req.clientCwd ?? root, req.cwd) : undefined;
    const rel = (dir: string) => path.relative(root, dir) || undefined;
    let detected: string | undefined;
    let portArgs: string | undefined;
    if (req.command) {
      patch.command = req.command;
      patch.cwd = rel(cwdOverride ?? req.clientCwd ?? root) ?? null;
    } else if (cwdOverride) patch.cwd = rel(cwdOverride) ?? null;
    if (!def && !req.command) {
      const cwd = cwdOverride ?? req.clientCwd ?? root;
      const d = detectCommand(cwd, root);
      if (!d) {
        throw new HttpError(
          400,
          `don't know how to start "${name}" in ${cwd}: no command given, no servedev.json entry, and no package.json dev script. ` +
            `Pass one: servedev start ${name} -- <command>`,
        );
      }
      patch.command = d.command;
      patch.cwd = rel(cwd) ?? null;
      portArgs = d.portArgs;
      detected = d.kind;
    }
    const cwd = cwdOverride ?? (req.command ? (req.clientCwd ?? root) : def?.cwd ?? req.clientCwd ?? root);
    const plan = planInstall(cwd, root);
    if (req.install && !plan) throw new HttpError(400, `--install: no package.json in ${cwd}`);
    if (req.setup !== undefined) patch.setup = req.setup || null;
    else if (req.install) patch.setup = plan!.setup;
    // A detected JS dev script with no dependencies installed would just fail; install first.
    else if (!def?.setup && detected && plan?.state === "missing") patch.setup = plan.setup;
    if (req.hostname) {
      const hostname = normalizeHostname(req.hostname);
      const taken = [...resolved.servers.values()].find((o) => o.hostname === hostname && o.id !== id);
      if (taken) throw new HttpError(409, `${hostname} is already used by ${taken.id}`);
      patch.hostname = hostname;
    }
    let portSpec = req.port ?? def?.portSpec;
    if (portSpec === undefined && String(patch.command ?? def?.command ?? "").includes("{port}")) portSpec = "auto";
    if (req.port !== undefined || (portSpec !== undefined && !def)) patch.port = portSpec;
    // Frameworks that take --port get it in the stored command, so later starts don't need detection.
    if (portArgs && portSpec !== undefined && !String(patch.command).includes("{port}")) patch.command = `${patch.command}${portArgs}`;
    const hasReady = req.ready && Object.values(req.ready).some((v) => v !== undefined);
    if (hasReady) patch.ready = readyToConfig(req.ready) ?? null;
    // Only variables set on purpose are kept with the server; the login shell supplies the rest at each start.
    const login = await getLoginEnv();
    if (req.env || req.vars) {
      let env = def?.env ?? {};
      if (req.env) env = explicitPart(req.env, login);
      if (req.vars) env = applyVars(req.replaceVars ? {} : env, req.vars);
      patch.env = Object.keys(env).length ? env : null;
    }
    if (Object.values(patch).some((v) => v !== undefined)) {
      configCall(() => writeServer(project, root, name, patch));
      reconcile();
      def = resolved.servers.get(id);
    }
    if (!def) {
      const issue = resolved.issues.find((i) => i.message.includes(`"${name}"`));
      throw new HttpError(400, issue ? `${issue.file}: ${issue.message}` : `${id} isn't defined; pass a command`);
    }
    const installing = !!plan && def.setup === plan.setup;
    if (def.hostname) {
      const taken = manager.list().find((o) => o.hostname === def!.hostname && o.id !== id && ACTIVE.includes(o.status));
      if (taken) throw new HttpError(409, `${def.hostname} is already used by ${taken.id}`);
    }
    const baseEnv = { ...login, ...def.repoEnv };
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
        {
          project,
          root,
          name,
          command: def.command,
          cwd: def.cwd,
          env: def.env,
          baseEnv,
          portSpec: def.portSpec,
          setup: def.setup,
          hostname: def.hostname,
          ready: def.ready,
          pinned: def.pinned,
          accountEnv,
          accounts: serverAccounts,
        },
        req.restart,
      );
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    const s = result.server;
    if (def.hostname) syncProxy();
    const res: StartResponse = { server: view(s), alreadyRunning: result.alreadyRunning, detected, accountsNote };
    if (!result.alreadyRunning && installing) res.install = plan;
    else if (plan?.state === "stale" || (plan?.state === "missing" && !installing)) res.installHint = plan;
    if (req.wait !== false) {
      const timeoutSec = req.timeout ?? def.timeout ?? (s.setup ? 300 : 60);
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
      project: config.labelOf(root) ?? path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
      tracked: !!config.labelOf(root),
      profiles: Object.keys(config.repo(root).profiles ?? {}),
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
      (Object.keys(SETTINGS) as SettingKey[]).map((k) => [k, { value: String(config.setting(k)), default: String(SETTINGS[k].default), describe: SETTINGS[k].describe }]),
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

  /**
   * A profile by id ("local:Mine", "capcon-apps:Full stack"), by name (yours win; a shared name in
   * several worktrees needs the id), or by an id from before profiles moved to config.json.
   */
  function profileRef(ref: unknown): ProfileView {
    const all = profiles();
    const key = String(ref ?? "");
    const byId = all.find((p) => p.id === key);
    if (byId) return byId;
    const legacy = JSON.parse(manager.store.getMeta("profile_ids") ?? "{}")[key];
    if (legacy) {
      const p = all.find((x) => x.id === legacy);
      if (p) return p;
    }
    const named = all.filter((p) => p.name.toLowerCase() === key.toLowerCase());
    const mine = named.find((p) => p.kind === "local");
    if (mine) return mine;
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      throw new HttpError(409, `"${key}" is shared in several worktrees; pick one by id: ${named.map((p) => `${p.id}${p.branch ? ` (${p.branch})` : ""}`).join(", ")}`);
    }
    throw new HttpError(
      404,
      `no profile "${key}"${all.length ? ` (have: ${all.map((x) => x.id).join(", ")})` : "; create one with servedev profile create <name>"}`,
    );
  }

  /** Server refs from a client (names within `root`, or ids) to ids. */
  function serverIds(root: string | undefined, refs: unknown): string[] {
    if (!Array.isArray(refs)) return [];
    return refs.map((r) => resolveRef(root, String(r), false).id);
  }

  function profilesChanged() {
    manager.emit("profiles", profiles());
    // Servers started with a profile's accounts may now be out of date.
    for (const s of manager.list()) if (s.accounts) manager.emit("change", s);
  }

  /** Start a profile's servers in order, waiting for each; servers outside the profile are left alone. */
  function startProfile(p: ProfileView, timeout?: number): Promise<ProfileStartResult[]> {
    return startSequence(p.servers, timeout, p.id);
  }

  /** Start servers one after another (each waits for the previous to be ready); running ones are skipped. */
  async function startSequence(ids: string[], timeout?: number, profile?: string | null): Promise<ProfileStartResult[]> {
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

  function layoutItems(raw: unknown): GridTile[] {
    if (!Array.isArray(raw)) throw new HttpError(400, "layout items must be an array");
    return (raw as GridTile[]).map((it) => {
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
    const project = e.orphaned ? path.basename(e.root) : (config.labelOf(e.root) ?? path.basename(e.root).toLowerCase());
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

  /**
   * Stop and forget servers: their history, and your config for them (your own servers, pins,
   * places in your profiles and grids). A server servedev.json defines stays defined unless
   * `fromRepo`, which takes it out of servedev.json too.
   */
  async function removeServers(ids: string[], opts: { fromRepo?: boolean } = {}) {
    const inRepo = ids.filter((id) => resolved.servers.get(id)?.source.repo);
    if (inRepo.length && !opts.fromRepo) {
      throw new HttpError(
        409,
        `${inRepo.join(", ")} ${inRepo.length === 1 ? "is" : "are"} defined in servedev.json, shared with everyone on the repo. ` +
          `Remove ${inRepo.length === 1 ? "it" : "them"} from servedev.json too (fromRepo), or edit the file.`,
      );
    }
    for (const id of ids) await manager.remove(id);
    const drop = new Set(ids);
    configCall(() =>
      config.editLocal((c) => {
        for (const id of ids) {
          const d = resolved.servers.get(id);
          if (d) delete c.servers?.[d.project]?.[d.name];
        }
        c.pinned = c.pinned?.filter((id) => !drop.has(id));
        for (const p of Object.values(c.profiles ?? {})) {
          p.servers = p.servers.filter((id) => !drop.has(id));
          if (p.grid) p.grid = p.grid.filter((t) => !drop.has(t.i));
        }
        if (c.grid) c.grid = c.grid.filter((t) => !drop.has(t.i));
      }),
    );
    if (opts.fromRepo) {
      for (const id of inRepo) {
        const d = resolved.servers.get(id)!;
        configCall(() =>
          config.editRepo(d.root, (c) => {
            delete c.servers?.[d.name];
            for (const p of Object.values(c.profiles ?? {})) {
              p.servers = p.servers.filter((n) => n !== d.name);
              if (p.grid) p.grid = p.grid.filter((t) => t.i !== d.name);
            }
          }),
        );
      }
    }
    reconcile();
  }

  /** Servers are all defined in config now; nothing is "configured but unknown". Kept for old dashboards. */
  function configured(): never[] {
    return [];
  }

  // ---------- profiles and grids in config files ----------

  const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

  /** A shared profile's key in config.json's overrides: its repo, then its name. */
  function editOverride(p: ProfileView, edit: (o: ProfileOverride) => void) {
    config.editLocal((c) => {
      c.overrides ??= {};
      const o = ((c.overrides[p.repo!] ??= {})[p.name] ??= {});
      edit(o);
    });
  }

  function assertProfileName(name: string) {
    if (!name) throw new HttpError(400, "a profile needs a name");
    if (/[\n\r]/.test(name) || name.length > 80) throw new HttpError(400, "profile names are one line, up to 80 characters");
  }

  /** Server ids of one project as names in its servedev.json; anything else is an error. */
  function namesIn(project: string, ids: string[], what: string): string[] {
    return ids.map((id) => {
      const d = resolved.servers.get(id);
      if (!d || d.project !== project) throw new HttpError(400, `${id} isn't a server in ${project}, so it can't be in ${what}`);
      return d.name;
    });
  }

  /** Create a profile: yours (config.json), or shared through a project's servedev.json. */
  function createProfile(body: Record<string, any>): ProfileView {
    const name = String(body.name ?? "").trim();
    assertProfileName(name);
    const layout = body.layout === undefined ? undefined : layoutItems(body.layout);
    const ids: string[] = body.running
      ? manager.list().filter((s) => s.status === "running" || s.status === "starting").map((s) => s.id)
      : layout
        ? layout.map((it) => resolveRef(undefined, it.i, false).id)
        : serverIds(body.root, body.servers);
    const picks = accountSelections(body.accounts);
    if (body.shared) {
      const project = String(body.project ?? resolved.servers.get(ids[0] ?? "")?.project ?? config.labelOf(path.resolve(String(body.root ?? ""))) ?? "");
      const info = resolved.projects.get(project);
      if (!info) throw new HttpError(400, "a shared profile belongs to a project; pass project (or servers from one project)");
      if (config.repo(info.root).profiles?.[name]) throw new HttpError(409, `${info.file} already has a profile called "${name}"`);
      const names = namesIn(project, ids, `a profile shared in ${project}`);
      const { needs, mine } = splitPicks(picks);
      configCall(() =>
        config.editRepo(info.root, (c) => {
          c.profiles ??= {};
          c.profiles[name] = {
            ...(body.description ? { description: String(body.description) } : {}),
            servers: names,
            ...(Object.keys(needs).length ? { accounts: needs } : {}),
            ...(layout ? { grid: layout.map((t) => ({ ...t, i: resolved.servers.get(t.i)!.name })) } : {}),
          };
        }),
      );
      reconcile();
      const view = profiles().find((p) => p.id === `${project}:${name}`)!;
      if (Object.keys(mine).length) configCall(() => editOverride(view, (o) => (o.accounts = mine)));
      reconcile();
      return profileRef(`${project}:${name}`);
    }
    if (config.local.profiles?.[name]) throw new HttpError(409, `you already have a profile called "${name}"`);
    configCall(() =>
      config.editLocal((c) => {
        c.profiles ??= {};
        c.profiles[name] = {
          ...(body.description ? { description: String(body.description) } : {}),
          servers: ids,
          ...(Object.keys(picks).length ? { accounts: picks } : {}),
          ...(layout ? { grid: layout } : {}),
        };
      }),
    );
    reconcile();
    return profileRef(`local:${name}`);
  }

  /** Account picks that name a person (emails) stay yours; the rest (projects, regions) can be shared. */
  function splitPicks(picks: Selections): { needs: Selections; mine: Selections } {
    const needs: Selections = {};
    const mine: Selections = {};
    for (const [provider, sel] of Object.entries(picks)) {
      for (const [field, value] of Object.entries(sel)) {
        const target = EMAIL_LIKE.test(value) ? mine : needs;
        (target[provider] ??= {})[field] = value;
      }
    }
    return { needs, mine };
  }

  /**
   * Change a profile. Yours: everything is in config.json. Shared: servers, name, description and
   * `needs` (what the servers need, without anyone's identity) are written to servedev.json; your
   * account picks (`accounts` / `mergeAccounts`), skipped servers and grid go to config.json.
   */
  function updateProfile(current: ProfileView, body: Record<string, any>): ProfileView {
    const expect = typeof body.version === "string" ? body.version : undefined;
    let servers: string[] | undefined;
    if (body.servers) servers = serverIds(body.root, body.servers);
    if (body.add) servers = [...(servers ?? [...current.servers, ...current.skipped]), ...serverIds(body.root, body.add)];
    if (body.remove) {
      const drop = new Set(serverIds(body.root, body.remove));
      servers = (servers ?? [...current.servers, ...current.skipped]).filter((id) => !drop.has(id));
    }
    if (servers) servers = [...new Set(servers)];
    const rename = body.rename === undefined ? undefined : String(body.rename).trim();
    if (rename !== undefined) assertProfileName(rename);
    let picks: Selections | undefined;
    const base = current.kind === "shared" ? (current.mine ?? {}) : current.accounts;
    if (body.accounts !== undefined) picks = accountSelections(body.accounts);
    if (body.mergeAccounts) {
      const merged: Record<string, Record<string, unknown> | null> = { ...base };
      for (const [id, sel] of Object.entries(body.mergeAccounts as Record<string, Record<string, unknown> | null>)) {
        merged[id] = sel === null ? null : { ...(base[id] ?? {}), ...sel };
      }
      picks = accountSelections(merged);
    }
    const description = body.description === undefined ? undefined : String(body.description);

    if (current.kind === "local") {
      const name = current.name;
      if (rename && rename !== name && config.local.profiles?.[rename]) throw new HttpError(409, `you already have a profile called "${rename}"`);
      configCall(() =>
        config.editLocal(
          (c) => {
            const p = c.profiles?.[name];
            if (!p) throw new HttpError(404, `profile "${name}" is gone from config.json`);
            if (servers) {
              p.servers = servers;
              if (p.grid) p.grid = p.grid.filter((t) => servers!.includes(t.i));
            }
            if (picks) {
              if (Object.keys(picks).length) p.accounts = picks;
              else delete p.accounts;
            }
            if (description !== undefined) {
              if (description) p.description = description;
              else delete p.description;
            }
            if (rename && rename !== name) {
              c.profiles![rename] = p;
              delete c.profiles![name];
            }
          },
          { expect },
        ),
      );
      reconcile();
      return profileRef(`local:${rename || name}`);
    }

    // Shared.
    const info = resolved.projects.get(current.project!)!;
    const needs = body.needs === undefined ? undefined : accountSelections(body.needs);
    if (rename && rename !== current.name && config.repo(info.root).profiles?.[rename]) {
      throw new HttpError(409, `${info.file} already has a profile called "${rename}"`);
    }
    const names = servers && namesIn(current.project!, servers, `${current.name} (shared in ${current.project})`);
    if (names || needs || description !== undefined || (rename && rename !== current.name)) {
      configCall(() =>
        config.editRepo(
          info.root,
          (c) => {
            const p = c.profiles?.[current.name];
            if (!p) throw new HttpError(404, `profile "${current.name}" is gone from ${info.file}`);
            if (names) {
              // Servers you skip stay in the shared list; skipping is yours, not the team's.
              const skipped = current.skipped.map((id) => resolved.servers.get(id)!.name).filter((n) => !names.includes(n) && !body.remove);
              p.servers = [...names, ...skipped];
              if (p.grid) p.grid = p.grid.filter((t) => p.servers.includes(t.i));
            }
            if (needs) {
              if (Object.keys(needs).length) p.accounts = needs;
              else delete p.accounts;
            }
            if (description !== undefined) {
              if (description) p.description = description;
              else delete p.description;
            }
            if (rename && rename !== current.name) {
              c.profiles![rename] = p;
              delete c.profiles![current.name];
            }
          },
          { expect },
        ),
      );
    }
    const skip = body.skip === undefined ? undefined : namesIn(current.project!, serverIds(body.root, body.skip), `${current.name}`);
    if (picks || skip || (rename && rename !== current.name)) {
      configCall(() =>
        config.editLocal((c) => {
          c.overrides ??= {};
          const repo = (c.overrides[current.repo!] ??= {});
          const o: ProfileOverride = (repo[current.name] ??= {});
          if (picks) {
            if (Object.keys(picks).length) o.accounts = picks;
            else delete o.accounts;
          }
          if (skip) o.skip = skip;
          if (rename && rename !== current.name) {
            repo[rename] = o;
            delete repo[current.name];
          }
        }),
      );
    }
    reconcile();
    return profileRef(`${current.project}:${rename || current.name}`);
  }

  function deleteProfile(p: ProfileView): { deleted: string; file: string } {
    if (p.kind === "local") {
      configCall(() => config.editLocal((c) => void delete c.profiles?.[p.name]));
    } else {
      configCall(() => config.editRepo(p.root!, (c) => void delete c.profiles?.[p.name]));
      configCall(() => config.editLocal((c) => void delete c.overrides?.[p.repo!]?.[p.name]));
    }
    reconcile();
    return { deleted: p.name, file: p.file };
  }

  /**
   * Move one of your profiles into its project's servedev.json, so everyone on the repo gets it.
   * Servers that are only in your config.json are written to servedev.json too (credentials and
   * machine paths left out), or teammates couldn't start them. Account picks that name a person
   * stay yours.
   */
  function shareProfile(p: ProfileView, body: Record<string, any>): { profile: ProfileView; savedServers: string[]; notes: string[] } {
    if (p.kind !== "local") throw new HttpError(400, `${p.name} is already shared in ${p.project}`);
    const projects = [...new Set(p.servers.map((id) => resolved.servers.get(id)!.project))];
    const project = String(body.project ?? projects[0] ?? "");
    if (projects.length > 1) {
      throw new HttpError(400, `${p.name} has servers from ${projects.join(", ")}; a shared profile lives in one repo, so it can only have that repo's servers`);
    }
    const info = resolved.projects.get(project);
    if (!info) throw new HttpError(400, `pass the project to share ${p.name} in`);
    const name = String(body.name ?? p.name).trim();
    if (config.repo(info.root).profiles?.[name]) throw new HttpError(409, `${info.file} already has a profile called "${name}"`);
    const notes: string[] = [];
    const savedServers: string[] = [];
    for (const id of p.servers) {
      const def = resolved.servers.get(id)!;
      if (def.source.repo) continue;
      const s = manager.servers.get(id)!;
      const plan = planSave(s, repoEntry(def.root, def.name));
      configCall(() => config.editRepo(info.root, (c) => ((c.servers ??= {})[def.name] = mergedEntry(plan))));
      clearLocalManaged(def, plan.omittedSecrets);
      savedServers.push(id);
      if (plan.removed.length) notes.push(`${id}: left out ${plan.removed.join(", ")}`);
      if (plan.omittedSecrets.length) notes.push(`${id}: secret-looking variables stay in your config: ${plan.omittedSecrets.join(", ")}`);
      notes.push(...plan.warnings.map((w) => `${id}: ${w}`));
    }
    const { needs, mine } = splitPicks(p.accounts);
    const local = config.local.profiles?.[p.name];
    configCall(() =>
      config.editRepo(info.root, (c) => {
        c.profiles ??= {};
        c.profiles[name] = {
          ...(p.description ? { description: p.description } : {}),
          servers: p.servers.map((id) => resolved.servers.get(id)!.name),
          ...(Object.keys(needs).length ? { accounts: needs } : {}),
          ...(local?.grid?.length ? { grid: local.grid.filter((t) => p.servers.includes(t.i)).map((t) => ({ ...t, i: resolved.servers.get(t.i)!.name })) } : {}),
        };
      }),
    );
    configCall(() =>
      config.editLocal((c) => {
        delete c.profiles?.[p.name];
        if (Object.keys(mine).length) ((c.overrides ??= {})[info.repo] ??= {})[name] = { accounts: mine };
      }),
    );
    if (Object.keys(mine).length) notes.push(`your account picks (${Object.entries(mine).map(([k, v]) => `${k}: ${Object.values(v).join(", ")}`).join("; ")}) stay in your config`);
    reconcile();
    return { profile: profileRef(`${project}:${name}`), savedServers, notes };
  }

  /** A copy of any profile as one of yours, to change freely. */
  function duplicateProfile(p: ProfileView, body: Record<string, any>): ProfileView {
    let name = String(body.name ?? "").trim();
    if (!name) {
      name = p.kind === "shared" ? `${p.name} (mine)` : `${p.name} copy`;
      for (let i = 2; config.local.profiles?.[name]; i++) name = `${p.kind === "shared" ? `${p.name} (mine` : `${p.name} copy`} ${i}${p.kind === "shared" ? ")" : ""}`;
    }
    assertProfileName(name);
    if (config.local.profiles?.[name]) throw new HttpError(409, `you already have a profile called "${name}"`);
    const grid = resolved.grids.get(`profile:${p.id}`);
    configCall(() =>
      config.editLocal((c) => {
        c.profiles ??= {};
        c.profiles[name] = {
          ...(p.description ? { description: p.description } : {}),
          servers: [...p.servers],
          ...(Object.keys(p.accounts).length ? { accounts: p.accounts } : {}),
          ...(grid?.length ? { grid } : {}),
        };
      }),
    );
    reconcile();
    return profileRef(`local:${name}`);
  }

  /** After a server's definition moved into servedev.json, your config keeps only what it adds (e.g. secrets). */
  function clearLocalManaged(def: ServerDef, keepEnv: string[] = []) {
    config.editLocal((c) => {
      const mine = c.servers?.[def.project]?.[def.name] as Record<string, unknown> | undefined;
      if (!mine) return;
      for (const key of ["command", "setup", "cwd", "port", "hostname", "ready"]) delete mine[key];
      const env = mine.env as Record<string, string> | undefined;
      if (env) {
        const kept = Object.fromEntries(Object.entries(env).filter(([k]) => keepEnv.includes(k)));
        if (Object.keys(kept).length) mine.env = kept;
        else delete mine.env;
      }
    });
  }

  // Grids: "draft" (the unsaved grid) or "profile:<profile id>". Tiles are by server id.

  function gridScope(scope: string): { kind: "draft" } | { kind: "profile"; profile: ProfileView } {
    if (scope === "draft" || scope === "all") return { kind: "draft" };
    const m = scope.match(/^profile:(.+)$/);
    if (!m) throw new HttpError(400, `invalid layout scope "${scope}" (use draft or profile:<id>)`);
    return { kind: "profile", profile: profileRef(m[1]) };
  }

  function gridInfo(scope: string) {
    const g = gridScope(scope);
    const items = resolved.grids.get(g.kind === "draft" ? "draft" : `profile:${g.profile.id}`) ?? null;
    return { scope: g.kind === "draft" ? "draft" : `profile:${g.profile.id}`, items, ...(g.kind === "profile" ? { grid: g.profile.grid, kind: g.profile.kind } : {}) };
  }

  /**
   * Save a grid. Yours and the unsaved one go to config.json; a shared profile's is your own
   * arrangement (config.json), unless `target: "repo"` makes it the default everyone gets.
   */
  function setGrid(scope: string, items: GridTile[], target?: "repo") {
    const g = gridScope(scope);
    if (g.kind === "draft") {
      configCall(() => config.editLocal((c) => void (c.grid = items)));
    } else if (g.profile.kind === "local") {
      configCall(() =>
        config.editLocal((c) => {
          const p = c.profiles?.[g.profile.name];
          if (p) p.grid = items;
        }),
      );
    } else {
      const p = g.profile;
      const tiles = items.flatMap((t) => {
        const d = resolved.servers.get(t.i);
        return d && d.project === p.project ? [{ ...t, i: d.name }] : [];
      });
      if (target === "repo") {
        configCall(() =>
          config.editRepo(p.root!, (c) => {
            const shared = c.profiles?.[p.name];
            if (shared) shared.grid = tiles;
          }),
        );
        configCall(() => editOverride(p, (o) => void delete o.grid));
      } else configCall(() => editOverride(p, (o) => void (o.grid = tiles)));
    }
    reconcile();
  }

  /** Drop your arrangement of a shared profile's grid, going back to the repo's. */
  function resetGrid(scope: string) {
    const g = gridScope(scope);
    if (g.kind !== "profile" || g.profile.kind !== "shared") throw new HttpError(400, "only a shared profile's grid has a repo layout to go back to");
    configCall(() => editOverride(g.profile, (o) => void delete o.grid));
    reconcile();
  }

  // ---------- servedev setup (a new machine) ----------

  function setupPlan(body: Record<string, any>) {
    const map: Record<string, string> = body.map ?? {};
    const entries = Object.entries(config.local.projects ?? {});
    const needScan = entries.some(([, e]) => !fs.existsSync(e.path));
    const scan = needScan
      ? scanForRepos(defaultScanRoots(entries.map(([, e]) => e.path).filter((p) => fs.existsSync(p)), body.roots ?? []), Number(body.budgetMs ?? 4000))
      : { repos: [], folders: new Map() };
    const projects: ({ project: string; was: string; remote?: string } & Located)[] = entries.map(([label, e]) => ({
      project: label,
      was: e.path,
      remote: e.remote,
      ...locate(label, e, scan, map),
    }));
    // One folder, one project: a later match for a folder already taken is left for the user to map.
    const taken = new Map<string, string>();
    for (const p of projects) {
      if (!p.path) continue;
      const owner = taken.get(p.path);
      if (owner && p.status === "found") Object.assign(p, { status: "missing", path: undefined, reason: `its match, ${p.path}, is already ${owner}'s; pass --map ${p.project}=<path>` });
      else taken.set(p.path, p.project);
    }
    return { projects, scanned: needScan };
  }

  async function setup(body: Record<string, any>) {
    const plan = setupPlan(body);
    const moves = plan.projects.filter((p) => p.status === "found" && p.path);
    if (body.apply && moves.length) {
      configCall(() =>
        config.editLocal((c) => {
          for (const m of moves) {
            const e = c.projects?.[m.project];
            if (e) e.path = m.path!;
          }
        }),
      );
      reconcile();
    }
    // Accounts each profile's servers would need here.
    const accountChecks: { profile: string; error: string }[] = [];
    for (const p of profiles()) {
      if (!Object.keys(p.accounts).length) continue;
      try {
        await accounts.env(accounts.normalize(p.accounts));
      } catch (e) {
        accountChecks.push({ profile: p.id, error: (e as Error).message });
      }
    }
    return { ...plan, applied: !!body.apply && moves.length > 0, accounts: accountChecks, issues: resolved.issues, file: config.localFile };
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
      const on = body.pinned !== false;
      configCall(() =>
        config.editLocal((c) => {
          const set = new Set(c.pinned ?? []);
          if (on) set.add(s.id);
          else set.delete(s.id);
          c.pinned = [...set].sort();
        }),
      );
      reconcile();
      // Pinned servers start at login; make sure the login item exists.
      const autostart = s.pinned && !autostartStatus().installed ? installAutostart(selfCommand()) : autostartStatus();
      return { server: view(s), autostart };
    }
    if (p === "/api/hostname" && req.method === "POST") {
      const s = resolveRef(body.root, body.id ?? body.name, true);
      const hostname = body.hostname ? normalizeHostname(String(body.hostname)) : undefined;
      const owner = hostname && [...resolved.servers.values()].find((o) => o.hostname === hostname && o.id !== s.id);
      if (owner) throw new HttpError(409, `${hostname} is already used by ${owner.id}`);
      configCall(() => writeServer(s.project, s.root, s.name, { hostname: hostname ?? null }));
      reconcile();
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
    if (p === "/api/profiles" && req.method === "GET") return { profiles: profiles() };
    // Configuration: where it lives, and what's wrong with it.
    if (p === "/api/config/status") return configSummary();
    if (p === "/api/projects/add" && req.method === "POST") {
      const dir = path.resolve(String(body.root ?? "").replace(/^~(?=$|\/)/, os.homedir()));
      if (!fs.existsSync(dir)) throw new HttpError(404, `no folder at ${dir}`);
      const root = findRoot(dir);
      const project = configCall(() => config.ensureProject(root));
      reconcile();
      return {
        project,
        root,
        servers: [...resolved.servers.values()].filter((d) => d.project === project).map((d) => d.id),
        profiles: profiles().filter((x) => x.project === project).map((x) => x.id),
      };
    }
    if (p === "/api/setup" && req.method === "POST") return setup(body);
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
      const usedBy = r.restoredBuiltIn ? [] : profiles().filter((x) => (x.kind === "local" ? x.accounts : (x.mine ?? {}))[id]);
      for (const x of usedBy) updateProfile(x, { mergeAccounts: { [id]: null } });
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
      const profile = createProfile(body);
      if (body.layout !== undefined) manager.emit("layout", { scope: `profile:${profile.id}`, source: body.source ?? null });
      return { profile };
    }
    if (p === "/api/profiles/update" && req.method === "POST") {
      return { profile: updateProfile(profileRef(body.id ?? body.profile), body) };
    }
    if (p === "/api/profiles/resolve") return { id: profileRef(q.get("ref") ?? "").id };
    if (p === "/api/profiles/delete" && req.method === "POST") return deleteProfile(profileRef(body.id ?? body.profile));
    if (p === "/api/profiles/share" && req.method === "POST") return shareProfile(profileRef(body.id ?? body.profile), body);
    if (p === "/api/profiles/duplicate" && req.method === "POST") return { profile: duplicateProfile(profileRef(body.id ?? body.profile), body) };
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
      const current = repoEntry(s.root, s.name);
      const includeSecrets = req.method === "POST" ? !!body.includeSecrets : q.get("includeSecrets") === "1";
      const plan = planSave(s, current, { includeSecrets });
      if (req.method !== "POST") return { server: s.id, ...plan };
      if (plan.state === "defined") return { server: s.id, ...plan, written: false };
      if (plan.state === "differs" && !body.force) {
        throw new HttpError(409, `${plan.file} already defines "${s.name}" differently (${plan.changes.map((c) => c.key).join(", ")}). Replace it with force.`);
      }
      configCall(() => config.editRepo(s.root, (c) => ((c.servers ??= {})[s.name] = mergedEntry(plan))));
      // The definition is the repo's now; your config keeps only what was left out (secret variables).
      const def = resolved.servers.get(s.id);
      if (def) configCall(() => clearLocalManaged(def, plan.omittedSecrets));
      reconcile();
      return { server: s.id, ...plan, written: true };
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
      await removeServers([s.id], { fromRepo: !!body.fromRepo });
      return { removed: s.id };
    }
    // A tracked folder (project): servedev forgets it, with your config for it. Files on disk (servedev.json too) are untouched.
    if (p === "/api/projects/remove" && req.method === "POST") {
      const root = body.root ? path.resolve(String(body.root)) : config.rootOf(String(body.project ?? ""));
      const project = root && config.labelOf(root);
      if (!root || !project) throw new HttpError(404, `servedev isn't tracking ${body.root ?? body.project}`);
      const ids = [...new Set([...manager.list().filter((s) => s.root === root).map((s) => s.id), ...[...resolved.servers.values()].filter((d) => d.root === root).map((d) => d.id)])];
      for (const id of ids) await manager.remove(id);
      const drop = new Set(ids);
      const repo = resolved.projects.get(project)?.repo;
      configCall(() =>
        config.editLocal((c) => {
          delete c.projects?.[project];
          delete c.servers?.[project];
          c.pinned = c.pinned?.filter((id) => !drop.has(id));
          for (const p of Object.values(c.profiles ?? {})) {
            p.servers = p.servers.filter((id) => !drop.has(id));
            if (p.grid) p.grid = p.grid.filter((t) => !drop.has(t.i));
          }
          if (c.grid) c.grid = c.grid.filter((t) => !drop.has(t.i));
          // Your changes to its shared profiles stay if another worktree of the repo is still tracked.
          if (repo && ![...resolved.projects.values()].some((x) => x.repo === repo && x.label !== project)) delete c.overrides?.[repo];
        }),
      );
      reconcile();
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
      return { server: view(s), runs, retentionDays: config.setting("log_retention_days") };
    }
    if (p === "/api/settings") {
      if (req.method === "POST") {
        const key = body.key as SettingKey;
        if (!(key in SETTINGS)) throw new HttpError(400, `unknown setting "${key}" (have: ${Object.keys(SETTINGS).join(", ")})`);
        const value = Number(body.value);
        if (key === "log_retention_days" && !(value >= 1)) throw new HttpError(400, "log_retention_days must be a number of days, at least 1");
        if (key === "proxy_port" && !(Number.isInteger(value) && value > 0 && value < 65536)) throw new HttpError(400, "proxy_port must be a port number");
        configCall(() => config.editLocal((c) => void ((c.settings ??= {})[key] = value)));
        reconcile();
        if (key === "log_retention_days") manager.purgeOldLogs();
        if (key === "proxy_port") syncProxy(true);
      }
      const migration = manager.store.getMeta("env_migration");
      return { settings: settings(), envMigration: migration ? JSON.parse(migration) : undefined };
    }
    if (p === "/api/stream/events") {
      return sse(req, (send) => {
        send("snapshot", { build: UI_BUILD, servers: manager.list().map(view), configured: configured(), profiles: profiles(), config: configSummary() });
        const onProfiles = (list: ProfileView[]) => send("profiles", list);
        manager.on("profiles", onProfiles);
        const onConfig = (summary: unknown) => send("config", summary);
        manager.on("config", onConfig);
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
          manager.off("config", onConfig);
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
    if (p === "/api/layouts" && req.method === "GET") return gridInfo(q.get("scope") ?? "draft");
    if (p === "/api/layouts" && req.method === "POST") {
      const scope = String(body.scope ?? "");
      setGrid(scope, layoutItems(body.items), body.target === "repo" ? "repo" : undefined);
      // Open dashboards reload this grid; `source` lets the tab that saved it ignore its own change.
      const info = gridInfo(scope);
      manager.emit("layout", { scope: info.scope, source: body.source ?? null });
      return info;
    }
    if (p === "/api/layouts/reset" && req.method === "POST") {
      resetGrid(String(body.scope ?? ""));
      const info = gridInfo(String(body.scope));
      manager.emit("layout", { scope: info.scope, source: null });
      return info;
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
      // JSON Schemas for servedev.json and config.json (editor autocomplete, validation).
      if (url.pathname === "/schema/servedev.schema.json" || url.pathname === "/schema/config.schema.json") {
        return Response.json(url.pathname.includes("servedev.") ? repoSchema : localSchema);
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
