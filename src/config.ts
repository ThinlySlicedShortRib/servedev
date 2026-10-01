import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Selections } from "./accounts/registry";
import { gitBranch, gitDir, gitInfo, repoIdentity } from "./git";
import { applyChanges, deepEqual, hashText, parseJsonc, writeAtomic, type ParseIssue } from "./jsonc";
import { CONFIG_FILE, normalizeReady, type GridTile, type ProjectConfig, type ReadySpec, type ServerConfig, type SharedProfileConfig } from "./project";
import { maskSecrets } from "./sanitize";

/**
 * Configuration lives in JSON files; SQLite only keeps what happens (runs, logs, pids).
 *
 *   <repo>/servedev.json      shared through git: servers, profiles, default grids, account needs
 *   ~/.servedev/config.json   yours: where projects are, your own servers and profiles, your
 *                             changes to shared servers and profiles, pins, grids, settings
 *
 * Both are read by one loader and merged: repo < yours. Every server and profile knows which
 * file it came from, and an edit is written back to that file. Files are watched, so edits in an
 * editor, a `git pull` or a branch switch show up by themselves.
 */

export const SCHEMA_BASE = "https://raw.githubusercontent.com/servedev/servedev/main/schema";
export const REPO_SCHEMA = `${SCHEMA_BASE}/servedev.schema.json`;
export const LOCAL_SCHEMA = `${SCHEMA_BASE}/config.schema.json`;
export const LOCAL_VERSION = 1;

export const SETTINGS = {
  log_retention_days: { default: 7, describe: "Delete logs of runs that stopped more than this many days ago." },
  proxy_port: {
    default: 80,
    describe: "Port for custom hostnames like keel.localhost. 80 gives URLs without a port; falls back to 7780 when 80 is taken.",
  },
} as const;
export type SettingKey = keyof typeof SETTINGS;

/** A local profile: any servers, from any project or worktree. */
export interface LocalProfileConfig {
  description?: string;
  /** Server ids ("project:name") in start order. */
  servers: string[];
  /** Your account picks for its servers, e.g. { gcloud: { account: "me@x.com" } }. */
  accounts?: Selections;
  grid?: GridTile[];
}

/** Your changes to a shared profile; they apply in every worktree of the repo. */
export interface ProfileOverride {
  /** Your account picks, on top of what the repo says the servers need. */
  accounts?: Selections;
  /** Your arrangement of its grid (tiles by server name). */
  grid?: GridTile[];
  /** Server names you don't start with it. */
  skip?: string[];
}

export interface ProjectEntry {
  path: string;
  /** Normalized git remote, so `servedev setup` can find the repo on another machine. */
  remote?: string;
  /** For a git worktree: the branch it was created for (another machine needs the same worktree). */
  worktree?: string;
}

/** ~/.servedev/config.json */
export interface LocalConfig {
  $schema?: string;
  version?: number;
  settings?: Partial<Record<SettingKey, number>>;
  /** Project name -> where it is. Names prefix server ids ("capcon-apps:api"). */
  projects?: Record<string, ProjectEntry>;
  /** Project -> server name -> a server of your own, or your changes to one from servedev.json. */
  servers?: Record<string, Record<string, Partial<ServerConfig>>>;
  profiles?: Record<string, LocalProfileConfig>;
  /** Repo (git remote, or folder:<name>) -> shared profile name -> your changes to it. */
  overrides?: Record<string, Record<string, ProfileOverride>>;
  /** Server ids that stay on top of the list and start at login. */
  pinned?: string[];
  /** The unsaved custom grid (tiles by server id). */
  grid?: GridTile[];
}

export interface ConfigIssue {
  level: "error" | "warning";
  file: string;
  line?: number;
  column?: number;
  message: string;
}

export class ConfigConflict extends Error {}

interface Doc<T> {
  file: string;
  exists: boolean;
  text: string;
  hash: string;
  mtimeMs: number;
  size: number;
  /** The last version that parsed; a broken edit never takes servers away. */
  data: T;
  error?: ParseIssue;
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function readDoc<T>(file: string, fallback: T, previous?: Doc<T>): Doc<T> {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { file, exists: false, text: "", hash: "", mtimeMs: 0, size: 0, data: fallback };
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { file, exists: true, text: "", hash: "", mtimeMs: st.mtimeMs, size: st.size, data: previous?.data ?? fallback, error: { line: 1, column: 1, message: (e as Error).message } };
  }
  const hash = hashText(text);
  if (previous && previous.hash === hash && !previous.error) return { ...previous, mtimeMs: st.mtimeMs, size: st.size };
  const { data, error } = parseJsonc(text);
  const base = { file, exists: true, text, hash, mtimeMs: st.mtimeMs, size: st.size };
  if (error) return { ...base, data: previous?.data ?? fallback, error };
  if (!isObject(data)) return { ...base, data: previous?.data ?? fallback, error: { line: 1, column: 1, message: "expected an object ({ ... })" } };
  return { ...base, data: data as T };
}

/** Drop empty containers left behind by an edit, so the file doesn't collect "{}"s. */
function pruneLocal(c: LocalConfig) {
  for (const [project, servers] of Object.entries(c.servers ?? {})) {
    for (const [name, entry] of Object.entries(servers)) if (!entry || !Object.keys(entry).length) delete servers[name];
    if (!Object.keys(servers).length) delete c.servers![project];
  }
  for (const [repo, profiles] of Object.entries(c.overrides ?? {})) {
    for (const [name, o] of Object.entries(profiles)) {
      if (o.skip && !o.skip.length) delete o.skip;
      if (o.accounts && !Object.keys(o.accounts).length) delete o.accounts;
      if (!Object.keys(o).length) delete profiles[name];
    }
    if (!Object.keys(profiles).length) delete c.overrides![repo];
  }
  for (const key of ["servers", "overrides", "profiles", "projects", "settings"] as const) {
    if (isObject(c[key]) && !Object.keys(c[key]!).length) delete c[key];
  }
  if (c.pinned && !c.pinned.length) delete c.pinned;
  if (c.grid && !c.grid.length) delete c.grid;
}

function pruneRepo(c: ProjectConfig) {
  for (const key of ["servers", "profiles"] as const) if (isObject(c[key]) && !Object.keys(c[key]!).length) delete c[key];
}

export class ConfigStore extends EventEmitter {
  private localDoc: Doc<LocalConfig>;
  private repoDocs = new Map<string, Doc<ProjectConfig>>();
  private watchers = new Map<string, fs.FSWatcher>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private statusOf = new Map<string, boolean>();
  /** mtimes of each repo's git HEAD and index: a checkout or commit changes the branch or what's uncommitted. */
  private gitStamps = new Map<string, { head: number; index: number }>();

  constructor(readonly localFile: string) {
    super();
    this.localDoc = readDoc<LocalConfig>(localFile, {});
    for (const root of this.roots()) this.repoDoc(root);
  }

  get local(): LocalConfig {
    return this.localDoc.data;
  }

  /** Version of a config file (its content hash), for writes that must not clobber a newer edit. */
  version(file: string): string {
    if (file === this.localFile) return this.localDoc.hash;
    return [...this.repoDocs.values()].find((d) => d.file === file)?.hash ?? "";
  }

  setting(key: SettingKey): number {
    const v = this.local.settings?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : SETTINGS[key].default;
  }

  /** Folders of known projects. */
  roots(): string[] {
    return [...new Set(Object.values(this.local.projects ?? {}).flatMap((p) => (p && typeof p.path === "string" ? [p.path] : [])))];
  }

  labelOf(root: string): string | undefined {
    return Object.entries(this.local.projects ?? {}).find(([, p]) => p?.path === root)?.[0];
  }

  rootOf(label: string): string | undefined {
    return this.local.projects?.[label]?.path;
  }

  private repoDoc(root: string): Doc<ProjectConfig> {
    let d = this.repoDocs.get(root);
    if (!d) {
      d = readDoc<ProjectConfig>(path.join(root, CONFIG_FILE), {});
      this.repoDocs.set(root, d);
    }
    return d;
  }

  /** A project's servedev.json (the last version that parsed; {} when there's none). */
  repo(root: string): ProjectConfig {
    return this.repoDoc(root).data;
  }

  /** Every file that feeds the config, with its state. */
  files(): { file: string; kind: "local" | "repo"; root?: string; exists: boolean; version: string; error?: ParseIssue }[] {
    const doc = (d: Doc<unknown>, kind: "local" | "repo", root?: string) => ({ file: d.file, kind, root, exists: d.exists, version: d.hash, error: d.error });
    return [doc(this.localDoc, "local"), ...this.roots().map((r) => doc(this.repoDoc(r), "repo", r))];
  }

  /** servedev.json has changes git hasn't committed (checked in the background). */
  uncommitted(root: string): boolean {
    return this.statusOf.get(root) ?? false;
  }

  private checkGit(root: string) {
    if (!gitInfo(root)) return;
    const proc = Bun.spawn(["git", "-C", root, "status", "--porcelain", "--", CONFIG_FILE], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    void new Response(proc.stdout)
      .text()
      .then((out) => {
        const dirty = out.trim().length > 0;
        if (this.statusOf.get(root) !== dirty) {
          this.statusOf.set(root, dirty);
          this.emit("status", root);
        }
      })
      .catch(() => {});
  }

  /**
   * Re-read files that changed on disk. Returns the files whose content changed (and emits
   * "change" with them); a file rewritten with the same content counts as unchanged.
   */
  refresh(): string[] {
    const changed: string[] = [];
    const check = <T>(d: Doc<T>, fallback: T): Doc<T> => {
      let mtimeMs = 0;
      let size = -1;
      try {
        const st = fs.statSync(d.file);
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {}
      const exists = size >= 0;
      if (exists === d.exists && mtimeMs === d.mtimeMs && (size === d.size || !exists)) return d;
      const next = readDoc(d.file, fallback, d);
      if (next.hash !== d.hash || next.exists !== d.exists || !!next.error !== !!d.error) changed.push(d.file);
      return next;
    };
    const before = this.roots().join("\n");
    this.localDoc = check(this.localDoc, {});
    const roots = this.roots();
    for (const root of roots) {
      const d = this.repoDocs.get(root);
      if (!d) {
        const fresh = this.repoDoc(root);
        if (fresh.exists) changed.push(fresh.file);
        this.checkGit(root);
      } else {
        const next = check(d, {});
        this.repoDocs.set(root, next);
        if (next !== d && changed.includes(next.file)) this.checkGit(root);
      }
    }
    for (const root of [...this.repoDocs.keys()]) if (!roots.includes(root)) this.repoDocs.delete(root);
    let branchMoved = false;
    for (const root of roots) {
      const dir = gitDir(root);
      if (!dir) continue;
      const mtime = (f: string) => {
        try {
          return fs.statSync(path.join(dir, f)).mtimeMs;
        } catch {
          return 0;
        }
      };
      const now = { head: mtime("HEAD"), index: mtime("index") };
      const was = this.gitStamps.get(root);
      this.gitStamps.set(root, now);
      if (!was) continue;
      if (now.index !== was.index || now.head !== was.head) this.checkGit(root);
      if (now.head !== was.head) branchMoved = true;
    }
    if (roots.join("\n") !== before) this.syncWatchers();
    // A branch switch changes profiles' branch tags even when servedev.json stays the same.
    if (changed.length || branchMoved) this.emit("change", changed);
    return changed;
  }

  // ---------- writes ----------

  private write<T extends object>(
    doc: Doc<T>,
    edit: (c: T) => void,
    opts: { expect?: string; create: () => T; prune: (c: T) => void; mode?: number },
  ): Doc<T> {
    // Always edit what's on disk now, not what was read a while ago.
    const fresh = readDoc<T>(doc.file, doc.data, doc);
    if (fresh.error) {
      throw new Error(`can't update ${doc.file}: it has a syntax error at line ${fresh.error.line}, column ${fresh.error.column} (${fresh.error.message}); fix it first`);
    }
    if (opts.expect !== undefined && opts.expect !== fresh.hash) {
      throw new ConfigConflict(`${doc.file} was changed by someone else since you loaded it; reload and try again`);
    }
    const before = fresh.exists ? clone(fresh.data) : undefined;
    const next = fresh.exists ? clone(fresh.data) : opts.create();
    edit(next);
    opts.prune(next);
    if (fresh.exists && deepEqual(before, next)) return fresh;
    writeAtomic(doc.file, applyChanges(fresh.text, before, next), opts.mode);
    return readDoc<T>(doc.file, next);
  }

  /** Change ~/.servedev/config.json; comments and formatting elsewhere in it are kept. */
  editLocal(edit: (c: LocalConfig) => void, opts: { expect?: string } = {}): LocalConfig {
    const beforeRoots = this.roots().join("\n");
    this.localDoc = this.write(this.localDoc, edit, {
      ...opts,
      create: () => ({ $schema: LOCAL_SCHEMA, version: LOCAL_VERSION }),
      prune: pruneLocal,
      mode: 0o600,
    });
    for (const root of this.roots()) this.repoDoc(root);
    if (this.roots().join("\n") !== beforeRoots) this.syncWatchers();
    this.emit("change", [this.localFile]);
    return this.local;
  }

  /** Change a project's servedev.json (creating it if needed). */
  editRepo(root: string, edit: (c: ProjectConfig) => void, opts: { expect?: string } = {}): ProjectConfig {
    const doc = this.write(this.repoDoc(root), edit, { ...opts, create: () => ({ $schema: REPO_SCHEMA }), prune: pruneRepo });
    this.repoDocs.set(root, doc);
    this.checkGit(root);
    this.emit("change", [doc.file]);
    return doc.data;
  }

  /**
   * The project name for a folder, registering it when it's new. Names are the folder's name,
   * made unique with a short hash when two folders share one.
   */
  ensureProject(root: string): string {
    const known = this.labelOf(root);
    if (known) return known;
    let label = path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "root";
    // "local:" prefixes your own profiles' ids.
    if (label === "local") label = "local-project";
    if (this.local.projects?.[label]) label = `${label}-${crypto.createHash("sha1").update(root).digest("hex").slice(0, 4)}`;
    const git = gitInfo(root);
    const branch = git?.worktree ? gitBranch(root) : undefined;
    this.editLocal((c) => {
      c.projects ??= {};
      c.projects[label] = { path: root, ...(git?.remote ? { remote: git.remote } : {}), ...(branch ? { worktree: branch } : {}) };
    });
    return label;
  }

  // ---------- watching ----------

  /** Watch the config files' folders (a git checkout replaces files, so files themselves aren't watched). */
  watch(pollMs = 2000) {
    this.syncWatchers();
    for (const root of this.roots()) this.checkGit(root);
    this.pollTimer ??= setInterval(() => this.refresh(), pollMs);
  }

  unwatch() {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private syncWatchers() {
    if (!this.pollTimer && !this.watchers.size && !this.listenerCount("change")) return;
    const wanted = new Map<string, string>([[path.dirname(this.localFile), path.basename(this.localFile)]]);
    for (const root of this.roots()) wanted.set(root, CONFIG_FILE);
    for (const [dir, w] of this.watchers) {
      if (!wanted.has(dir)) {
        w.close();
        this.watchers.delete(dir);
      }
    }
    for (const [dir, name] of wanted) {
      if (this.watchers.has(dir) || !fs.existsSync(dir)) continue;
      try {
        const w = fs.watch(dir, (_event, filename) => {
          if (filename && filename !== name) return;
          clearTimeout(this.debounce);
          this.debounce = setTimeout(() => this.refresh(), 80);
        });
        w.on("error", () => {
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch {}
    }
  }
}

// ---------- resolving: files -> servers, profiles, grids ----------

export interface ProjectInfo {
  label: string;
  root: string;
  /** Repo identity (remote, or folder:<name>): shared profiles' overrides are keyed by it. */
  repo: string;
  remote?: string;
  exists: boolean;
  branch?: string;
  /** Its servedev.json. */
  file: string;
  hasFile: boolean;
}

/** A server as configured: servedev.json merged with your changes. */
export interface ServerDef {
  id: string;
  project: string;
  name: string;
  root: string;
  command: string;
  setup?: string;
  /** Absolute. */
  cwd: string;
  /** Your variables for it (from config.json). */
  env: Record<string, string>;
  /** The repo's variables, applied underneath yours. */
  repoEnv?: Record<string, string>;
  portSpec?: number | "auto";
  ready: ReadySpec;
  hostname?: string;
  timeout?: number;
  dependsOn?: string[];
  pinned: boolean;
  /** Where it's defined: in the repo, in your config, or both (your changes on top). */
  source: { repo: boolean; local: boolean };
}

export interface ProfileView {
  /** "local:<name>" for yours, "<project>:<name>" for one shared in a repo (one per worktree). */
  id: string;
  name: string;
  kind: "local" | "shared";
  description?: string;
  /** Server ids it starts, in order (skipped and missing ones left out). */
  servers: string[];
  /** Server ids you skip (shared profiles). */
  skipped: string[];
  /** Every defined server it lists, skipped ones included, in its order. */
  members: string[];
  /** References to servers that aren't defined (anymore). */
  missing: string[];
  /** What its servers get: the repo's needs with your picks on top. */
  accounts: Selections;
  /** Shared: what servedev.json says the servers need. */
  needs?: Selections;
  /** Shared: your picks. */
  mine?: Selections;
  /** Shared: where it comes from. */
  project?: string;
  root?: string;
  branch?: string;
  repo?: string;
  file: string;
  /** servedev.json has changes git hasn't committed. */
  uncommitted?: boolean;
  /** Version of the file it lives in, for conflict-safe edits. */
  version: string;
  grid: { source: "repo" | "override" | "local" | null; hasRepoDefault: boolean; hasOverride: boolean };
}

export interface Resolved {
  projects: Map<string, ProjectInfo>;
  servers: Map<string, ServerDef>;
  profiles: ProfileView[];
  /** Grid tiles by scope ("draft", "profile:<id>"), tiles by server id. */
  grids: Map<string, GridTile[]>;
  issues: ConfigIssue[];
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const NAME = /^[\w.-]+$/;

/** A local value where one is set (null clears the repo's), else the repo's. */
function pick<K extends keyof ServerConfig>(local: Partial<ServerConfig> | undefined, repo: ServerConfig | undefined, key: K): ServerConfig[K] | undefined {
  if (local && key in local) return (local[key] ?? undefined) as ServerConfig[K] | undefined;
  return repo?.[key];
}

/** Account picks merged field by field: `over` wins where it has a value. */
export function mergeSelections(base: Selections = {}, over: Selections = {}): Selections {
  const out: Selections = {};
  for (const id of new Set([...Object.keys(base), ...Object.keys(over)])) {
    const merged: Record<string, string> = {};
    for (const src of [base[id] ?? {}, over[id] ?? {}]) {
      for (const [k, v] of Object.entries(src)) if (typeof v === "string" && v !== "") merged[k] = v;
    }
    const clean = merged;
    if (Object.keys(clean).length) out[id] = clean;
  }
  return out;
}

function validTiles(raw: unknown): GridTile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) =>
    isObject(t) && typeof t.i === "string" && [t.x, t.y, t.w, t.h].every((n) => Number.isInteger(n) && n >= 0)
      ? [{ i: t.i, x: t.x, y: t.y, w: t.w, h: t.h, ...(t.mode === "preview" ? { mode: "preview" as const } : {}) }]
      : [],
  );
}

function stringList(raw: unknown): string[] | undefined {
  return Array.isArray(raw) && raw.every((x) => typeof x === "string") ? raw : undefined;
}

export function resolveConfig(store: ConfigStore): Resolved {
  const local = store.local;
  const issues: ConfigIssue[] = [];
  for (const f of store.files()) {
    if (f.error) issues.push({ level: "error", file: f.file, line: f.error.line, column: f.error.column, message: `${f.error.message} (using the last version that worked)` });
  }
  const warn = (file: string, message: string) => issues.push({ level: "warning", file, message });

  // Projects.
  const projects = new Map<string, ProjectInfo>();
  for (const [label, p] of Object.entries(local.projects ?? {})) {
    if (!p || typeof p.path !== "string") {
      warn(store.localFile, `projects.${label} needs a "path"`);
      continue;
    }
    const exists = fs.existsSync(p.path);
    const file = path.join(p.path, CONFIG_FILE);
    projects.set(label, {
      label,
      root: p.path,
      repo: exists ? repoIdentity(p.path) : p.remote ?? `folder:${path.basename(p.path)}`,
      remote: exists ? (gitInfo(p.path)?.remote ?? p.remote) : p.remote,
      exists,
      branch: exists ? gitBranch(p.path) : undefined,
      file,
      hasFile: exists && fs.existsSync(file),
    });
  }

  // Servers.
  const pinned = new Set(stringList(local.pinned) ?? []);
  const servers = new Map<string, ServerDef>();
  for (const info of projects.values()) {
    if (!info.exists) continue;
    const repo = store.repo(info.root);
    const repoServers = isObject(repo.servers) ? repo.servers : {};
    const mine = isObject(local.servers?.[info.label]) ? local.servers![info.label] : {};
    for (const name of new Set([...Object.keys(repoServers), ...Object.keys(mine)])) {
      const r = isObject(repoServers[name]) ? (repoServers[name] as ServerConfig) : undefined;
      const l = isObject(mine[name]) ? (mine[name] as Partial<ServerConfig>) : undefined;
      const file = l ? store.localFile : info.file;
      if (!NAME.test(name)) {
        warn(file, `server "${name}" in ${info.label}: names can only use letters, digits, . _ -`);
        continue;
      }
      const command = pick(l, r, "command");
      if (typeof command !== "string" || !command.trim()) {
        warn(
          file,
          !r && l
            ? `your settings for "${name}" in ${info.label} have nothing to apply to: ${CONFIG_FILE} here doesn't define it (another branch?) and they don't include a "command"`
            : `server "${name}" in ${info.label} has no "command"`,
        );
        continue;
      }
      const cwd = pick(l, r, "cwd");
      const port = pick(l, r, "port");
      const env = isObject(l?.env) ? Object.fromEntries(Object.entries(l!.env!).filter(([, v]) => typeof v === "string")) : {};
      const id = `${info.label}:${name}`;
      if (l && maskSecrets(command) !== command) {
        warn(store.localFile, `${id}'s command has a credential in it; keep config.json to yourself (don't commit or sync it) or move the credential to an .env file`);
      }
      servers.set(id, {
        id,
        project: info.label,
        name,
        root: info.root,
        command,
        setup: pick(l, r, "setup") || undefined,
        cwd: path.resolve(info.root, typeof cwd === "string" ? cwd : "."),
        env,
        repoEnv: isObject(r?.env) ? r!.env : undefined,
        portSpec: port === "auto" || (typeof port === "number" && port > 0) ? port : undefined,
        ready: normalizeReady(pick(l, r, "ready")) ?? {},
        hostname: pick(l, r, "hostname") || undefined,
        timeout: pick(l, r, "timeout"),
        dependsOn: pick(l, r, "dependsOn"),
        pinned: pinned.has(id),
        source: { repo: !!r, local: !!l && Object.keys(l).length > 0 },
      });
    }
  }

  // Profiles.
  const profiles: ProfileView[] = [];
  const grids = new Map<string, GridTile[]>();
  const draft = validTiles(local.grid).filter((t) => servers.has(t.i));
  if (draft.length) grids.set("draft", draft);

  for (const info of projects.values()) {
    if (!info.exists) continue;
    const repo = store.repo(info.root);
    for (const [name, raw] of Object.entries(isObject(repo.profiles) ? repo.profiles : {})) {
      const pc = raw as SharedProfileConfig;
      const names = stringList(pc?.servers);
      if (!names) {
        warn(info.file, `profile "${name}" needs "servers": a list of server names`);
        continue;
      }
      const override: ProfileOverride = isObject(local.overrides?.[info.repo]?.[name]) ? local.overrides![info.repo][name] : {};
      const skip = new Set(stringList(override.skip) ?? []);
      const idOf = (n: string) => `${info.label}:${n}`;
      const missing = names.filter((n) => !servers.has(idOf(n)));
      if (missing.length) warn(info.file, `profile "${name}" lists ${missing.map((m) => `"${m}"`).join(", ")}, which ${missing.length === 1 ? "isn't a server" : "aren't servers"} in ${info.label}`);
      const needs = isObject(pc.accounts) ? (pc.accounts as Selections) : {};
      for (const [provider, sel] of Object.entries(needs)) {
        for (const [field, v] of Object.entries(sel ?? {})) {
          if (typeof v === "string" && EMAIL.test(v)) {
            warn(info.file, `profile "${name}": accounts.${provider}.${field} looks like someone's email; servedev.json is shared, so pick personal accounts in your own settings instead`);
          }
        }
      }
      const mine = isObject(override.accounts) ? (override.accounts as Selections) : {};
      const id = `${info.label}:${name}`;
      const ids = names.filter((n) => servers.has(idOf(n))).map(idOf);
      const repoGrid = validTiles(pc.grid);
      const myGrid = override.grid ? validTiles(override.grid) : undefined;
      // Servers you skip don't get a tile either.
      const tiles = (myGrid ?? repoGrid).filter((t) => servers.has(idOf(t.i)) && !skip.has(t.i)).map((t) => ({ ...t, i: idOf(t.i) }));
      if (tiles.length || myGrid) grids.set(`profile:${id}`, tiles);
      profiles.push({
        id,
        name,
        kind: "shared",
        description: typeof pc.description === "string" ? pc.description : undefined,
        servers: ids.filter((x) => !skip.has(x.slice(info.label.length + 1))),
        skipped: ids.filter((x) => skip.has(x.slice(info.label.length + 1))),
        members: ids,
        missing: missing.map(idOf),
        accounts: mergeSelections(needs, mine),
        needs,
        mine,
        project: info.label,
        root: info.root,
        branch: info.branch,
        repo: info.repo,
        file: info.file,
        uncommitted: store.uncommitted(info.root),
        version: store.version(info.file),
        grid: { source: myGrid ? "override" : repoGrid.length ? "repo" : null, hasRepoDefault: repoGrid.length > 0, hasOverride: !!myGrid },
      });
    }
  }

  const byName = new Map<string, string[]>();
  for (const s of servers.values()) byName.set(s.name, [...(byName.get(s.name) ?? []), s.id]);
  for (const [name, raw] of Object.entries(isObject(local.profiles) ? local.profiles : {})) {
    const refs = stringList((raw as LocalProfileConfig)?.servers);
    if (!refs) {
      warn(store.localFile, `profile "${name}" needs "servers": a list of server ids like "project:name"`);
      continue;
    }
    const ids: string[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      const id = servers.has(ref) ? ref : byName.get(ref)?.length === 1 ? byName.get(ref)![0] : undefined;
      if (id) {
        if (!ids.includes(id)) ids.push(id);
      } else missing.push(ref);
    }
    const lp = raw as LocalProfileConfig;
    const id = `local:${name}`;
    const tiles = validTiles(lp.grid).filter((t) => servers.has(t.i));
    if (lp.grid) grids.set(`profile:${id}`, tiles);
    profiles.push({
      id,
      name,
      kind: "local",
      description: typeof lp.description === "string" ? lp.description : undefined,
      servers: ids,
      skipped: [],
      members: ids,
      missing,
      accounts: mergeSelections({}, isObject(lp.accounts) ? (lp.accounts as Selections) : {}),
      file: store.localFile,
      version: store.version(store.localFile),
      grid: { source: lp.grid ? "local" : null, hasRepoDefault: false, hasOverride: false },
    });
  }
  profiles.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "local" ? -1 : 1) || a.name.localeCompare(b.name) || (a.project ?? "").localeCompare(b.project ?? ""));

  return { projects, servers, profiles, grids, issues };
}
