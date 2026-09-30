import type { Database } from "bun:sqlite";
import path from "node:path";

import type { Selections } from "./accounts/registry";
import { LOCAL_SCHEMA, LOCAL_VERSION, type LocalConfig, type LocalProfileConfig } from "./config";
import { gitBranch, gitInfo } from "./git";
import type { GridTile, ProjectConfig, ReadySpec, ServerConfig } from "./project";

/**
 * Servedev used to keep servers, profiles, grids, pins and settings in SQLite. They move, once,
 * into ~/.servedev/config.json; SQLite keeps runs and logs. Anything already in config.json (e.g.
 * copied from another machine) wins over the database.
 */

type Row = Record<string, any>;

export interface MigrationReport {
  projects: number;
  servers: { id: string; kept: "full" | "changes" | "nothing"; fields: string[] }[];
  profiles: string[];
  grids: string[];
  pinned: string[];
  settings: string[];
  /** Old numeric profile ids -> new ids, so open dashboards keep their selected profile. */
  profileIds: Record<string, string>;
  notes: string[];
}

const hasTable = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

function readyEntry(r: ReadySpec | undefined): ServerConfig["ready"] | undefined {
  if (!r) return undefined;
  if (r.log || r.url) return { ...(r.log ? { log: r.log } : {}), ...(r.url ? { url: r.url } : {}) };
  return r.mode === "none" ? "none" : undefined;
}

/**
 * What config.json should hold after the move. `readRepo` gives a project's servedev.json, so a
 * server defined there only keeps what the database added on top (servedev.json won before, too:
 * its command, folder, setup, port, ready check and hostname were used when it had them).
 */
export function buildMigration(db: Database, existing: LocalConfig, readRepo: (root: string) => ProjectConfig): { config: LocalConfig; report: MigrationReport } {
  const config: LocalConfig = JSON.parse(JSON.stringify(existing ?? {}));
  config.$schema ??= LOCAL_SCHEMA;
  config.version ??= LOCAL_VERSION;
  const report: MigrationReport = { projects: 0, servers: [], profiles: [], grids: [], pinned: [], settings: [], profileIds: {}, notes: [] };

  const rows = hasTable(db, "servers") ? (db.query("SELECT * FROM servers ORDER BY id").all() as Row[]) : [];

  // Projects: the same names the database used, so server ids don't change.
  config.projects ??= {};
  for (const r of rows) {
    const taken = Object.entries(config.projects).find(([label, p]) => label === r.project || p.path === r.root);
    if (taken) continue;
    const git = gitInfo(r.root);
    const branch = git?.worktree ? gitBranch(r.root) : undefined;
    config.projects[r.project] = { path: r.root, ...(git?.remote ? { remote: git.remote } : {}), ...(branch ? { worktree: branch } : {}) };
    report.projects++;
  }
  const labelOf = (root: string) => Object.entries(config.projects!).find(([, p]) => p.path === root)?.[0];

  // Servers.
  config.servers ??= {};
  const pinned = new Set(config.pinned ?? []);
  for (const r of rows) {
    const label = labelOf(r.root) ?? r.project;
    const id = `${label}:${r.name}`;
    if (r.pinned && !pinned.has(id)) {
      pinned.add(id);
      report.pinned.push(id);
    }
    const mine = (config.servers[label] ??= {});
    if (mine[r.name]) {
      report.servers.push({ id, kept: "nothing", fields: [] });
      continue;
    }
    const env: Record<string, string> = JSON.parse(r.env || "{}");
    const ready = readyEntry(JSON.parse(r.ready || "{}"));
    const port = r.port_spec == null ? undefined : JSON.parse(r.port_spec);
    const repo = readRepo(r.root).servers?.[r.name];
    const entry: Partial<ServerConfig> = {};
    if (repo) {
      // Only what the database added to servedev.json's definition.
      if (r.setup && repo.setup === undefined) entry.setup = r.setup;
      if (r.hostname && repo.hostname === undefined) entry.hostname = r.hostname;
      if (port !== undefined && repo.port === undefined) entry.port = port;
      if (ready && repo.ready === undefined) entry.ready = ready;
    } else {
      entry.command = r.command;
      if (r.setup) entry.setup = r.setup;
      const rel = path.relative(r.root, r.cwd);
      if (rel && rel !== ".") entry.cwd = rel;
      if (port !== undefined) entry.port = port;
      if (ready) entry.ready = ready;
      if (r.hostname) entry.hostname = r.hostname;
    }
    if (Object.keys(env).length) entry.env = env;
    if (Object.keys(entry).length) mine[r.name] = entry;
    report.servers.push({ id, kept: repo ? (Object.keys(entry).length ? "changes" : "nothing") : "full", fields: Object.keys(entry) });
  }
  if (pinned.size) config.pinned = [...pinned].sort();

  // Profiles, with their grids.
  const layouts = new Map<string, GridTile[]>();
  if (hasTable(db, "layouts")) {
    for (const l of db.query("SELECT scope, items FROM layouts").all() as Row[]) {
      try {
        layouts.set(l.scope, JSON.parse(l.items));
      } catch {}
    }
  }
  const tiles = (items: GridTile[] | undefined) =>
    (items ?? []).map(({ i, x, y, w, h, mode }) => ({ i, x, y, w, h, ...(mode === "preview" ? { mode } : {}) }));
  if (hasTable(db, "profiles")) {
    config.profiles ??= {};
    const members = db.query("SELECT server_id FROM profile_servers WHERE profile_id = ? ORDER BY position");
    for (const p of db.query("SELECT * FROM profiles ORDER BY name").all() as Row[]) {
      report.profileIds[String(p.id)] = `local:${p.name}`;
      if (config.profiles[p.name]) {
        report.notes.push(`profile "${p.name}" was already in config.json; kept that one`);
        continue;
      }
      const profile: LocalProfileConfig = { servers: (members.all(p.id) as Row[]).map((m) => m.server_id) };
      const accounts: Selections = JSON.parse(p.accounts || "{}");
      if (Object.keys(accounts).length) profile.accounts = accounts;
      const grid = layouts.get(`profile:${p.id}`);
      if (grid?.length) {
        profile.grid = tiles(grid);
        report.grids.push(p.name);
      }
      config.profiles[p.name] = profile;
      report.profiles.push(p.name);
    }
  }
  const draft = layouts.get("draft");
  if (draft?.length && !config.grid?.length) {
    config.grid = tiles(draft);
    report.grids.push("unsaved grid");
  }

  // Settings.
  if (hasTable(db, "settings")) {
    for (const s of db.query("SELECT key, value FROM settings WHERE key NOT LIKE 'meta:%'").all() as Row[]) {
      if (s.key !== "log_retention_days" && s.key !== "proxy_port") continue;
      config.settings ??= {};
      if (config.settings[s.key as "proxy_port"] === undefined && Number.isFinite(Number(s.value))) {
        config.settings[s.key as "proxy_port"] = Number(s.value);
        report.settings.push(`${s.key} = ${s.value}`);
      }
    }
  }
  return { config, report };
}

/** After the move: the database no longer holds configuration. */
export function dropConfigTables(db: Database) {
  db.exec(`DROP TABLE IF EXISTS profile_servers;
           DROP TABLE IF EXISTS profiles;
           DROP TABLE IF EXISTS layouts;
           DELETE FROM settings WHERE key NOT LIKE 'meta:%';`);
}

export function describeMigration(r: MigrationReport): string[] {
  const full = r.servers.filter((s) => s.kept === "full").length;
  const changes = r.servers.filter((s) => s.kept === "changes");
  return [
    `config moved to config.json: ${r.projects} project${r.projects === 1 ? "" : "s"}, ${full} server${full === 1 ? "" : "s"} of your own` +
      (changes.length ? `, your changes to ${changes.length} from servedev.json (${changes.map((s) => `${s.id}: ${s.fields.join(", ")}`).join("; ")})` : "") +
      `, ${r.profiles.length} profile${r.profiles.length === 1 ? "" : "s"}${r.grids.length ? `, grids of ${r.grids.join(", ")}` : ""}` +
      (r.pinned.length ? `, pins: ${r.pinned.join(", ")}` : "") +
      (r.settings.length ? `, settings: ${r.settings.join(", ")}` : ""),
    ...r.notes,
  ];
}

