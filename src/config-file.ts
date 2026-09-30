import fs from "node:fs";
import path from "node:path";

import { looksSecret } from "./env";
import type { Server } from "./manager";
import { CONFIG_FILE, normalizeReady, type ProjectConfig, type ServerConfig } from "./project";
import { portableCommand } from "./sanitize";

/**
 * Writing servers into their repo's servedev.json, so their setup travels with the code (a
 * teammate clones and runs `servedev up`; a new machine needs nothing else).
 */

/** Keys servedev manages for a server; others (timeout, dependsOn, anything newer) are left alone. */
const MANAGED = ["command", "setup", "cwd", "port", "hostname", "ready", "env"] as const;

export type ConfigState = "defined" | "differs" | "missing";

export interface ConfigChange {
  key: string;
  before?: unknown;
  after?: unknown;
}

export interface ConfigPlan {
  file: string;
  exists: boolean;
  state: ConfigState;
  /** What would be written for this server. */
  entry: ServerConfig;
  /** The entry there now, if any. */
  current?: ServerConfig;
  changes: ConfigChange[];
  /** Secret-looking variables left out (put them in .env instead, or pass includeSecrets). */
  omittedSecrets: string[];
  /** Credentials taken out of the command, e.g. "--token (a credential)". */
  removed: string[];
  /** Machine-specific paths made portable, e.g. "node /opt/homebrew/bin/pnpm → pnpm". */
  rewritten: string[];
  /** Left as is but may not work on another machine. */
  warnings: string[];
}

const cache = new Map<string, { mtime: number; config: ProjectConfig }>();

/** servedev.json of a project, re-read only when it changed; {} when missing or unreadable. */
export function readConfigCached(root: string): ProjectConfig {
  const file = path.join(root, CONFIG_FILE);
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return {};
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.config;
  let config: ProjectConfig = {};
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  cache.set(file, { mtime, config });
  return config;
}

/** The servedev.json entry that reproduces a server. */
export function serverToConfig(
  s: Pick<Server, "command" | "setup" | "root" | "cwd" | "portSpec" | "hostname" | "ready" | "env">,
  opts: { includeSecrets?: boolean; baseEnv?: Record<string, string>; which?: (bin: string) => string | null } = {},
): { entry: ServerConfig; omittedSecrets: string[]; removed: string[]; rewritten: string[]; warnings: string[] } {
  // Never write credentials from the command line, and don't pin paths that only exist here.
  const ctx = { root: s.root, cwd: s.cwd, which: opts.which };
  const command = portableCommand(s.command, ctx);
  const setup = s.setup ? portableCommand(s.setup, ctx) : undefined;
  const entry: ServerConfig = { command: command.command };
  if (setup?.command) entry.setup = setup.command;
  const rel = path.relative(s.root, s.cwd);
  if (rel && rel !== ".") entry.cwd = rel;
  if (s.portSpec !== undefined) entry.port = s.portSpec;
  if (s.hostname) entry.hostname = s.hostname;
  const ready = s.ready ?? {};
  if (ready.log || ready.url) entry.ready = { ...(ready.log ? { log: ready.log } : {}), ...(ready.url ? { url: ready.url } : {}) };
  else if (ready.mode === "none") entry.ready = "none";
  const omittedSecrets: string[] = [];
  const env: Record<string, string> = { ...opts.baseEnv };
  for (const [k, v] of Object.entries(s.env ?? {})) {
    if (looksSecret(k) && !opts.includeSecrets) omittedSecrets.push(k);
    else env[k] = v;
  }
  if (Object.keys(env).length) entry.env = env;
  return {
    entry,
    omittedSecrets: omittedSecrets.sort(),
    removed: [...command.removed, ...(setup?.removed ?? [])],
    rewritten: [...command.rewritten, ...(setup?.rewritten ?? [])],
    warnings: [...command.warnings, ...(setup?.warnings ?? [])],
  };
}

function canonical(key: string, v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  if (key === "cwd") {
    const n = path.normalize(String(v));
    return n === "." ? undefined : n.replace(/\/$/, "");
  }
  if (key === "ready") {
    const r = normalizeReady(v as ServerConfig["ready"]);
    if (!r || (!r.log && !r.url && r.mode !== "none")) return undefined;
    return r.log || r.url ? { log: r.log, url: r.url } : { mode: "none" };
  }
  if (key === "env") return Object.keys(v as object).length ? Object.fromEntries(Object.entries(v as object).sort()) : undefined;
  return v;
}

const same = (key: string, a: unknown, b: unknown) => JSON.stringify(canonical(key, a)) === JSON.stringify(canonical(key, b));

export function diffEntries(current: ServerConfig | undefined, entry: ServerConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const key of MANAGED) {
    const before = current?.[key];
    const after = entry[key];
    if (!same(key, before, after)) changes.push({ key, before: canonical(key, before), after: canonical(key, after) });
  }
  return changes;
}

/** How a server compares to its repo's servedev.json, and what saving it would change. */
export function planSave(s: Server, opts: { includeSecrets?: boolean } = {}): ConfigPlan {
  const file = path.join(s.root, CONFIG_FILE);
  const config = readConfigCached(s.root);
  const current = config.servers?.[s.name];
  // servedev.json's own env is applied underneath the server's variables at every start; keep it.
  const { entry, omittedSecrets, removed, rewritten, warnings } = serverToConfig(s, { ...opts, baseEnv: current?.env });
  const changes = diffEntries(current, entry);
  return {
    file,
    exists: fs.existsSync(file),
    state: !current ? "missing" : changes.length ? "differs" : "defined",
    entry,
    current,
    changes,
    omittedSecrets,
    removed,
    rewritten,
    warnings,
  };
}

/** Just the state, for server views (cheap: the file is cached). */
export function configState(s: Server): ConfigState {
  const current = readConfigCached(s.root).servers?.[s.name];
  if (!current) return "missing";
  // Secret-looking variables are left out of servedev.json on purpose, so they don't count as drift.
  return diffEntries(current, serverToConfig(s, { baseEnv: current.env }).entry).length ? "differs" : "defined";
}

export class ConfigConflict extends Error {}

/**
 * Change a project's servedev.json in place: `edit` gets the parsed file (or {} for a new one) and
 * mutates it. Keys servedev doesn't know, other servers and the file's indentation survive.
 * Refuses to touch a file that isn't valid JSON. Returns the file's path.
 */
export function editConfigFile(root: string, edit: (config: Record<string, any>) => void): string {
  const file = path.join(root, CONFIG_FILE);
  let raw = "";
  let data: Record<string, any> = {};
  if (fs.existsSync(file)) {
    raw = fs.readFileSync(file, "utf8");
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`can't update ${file}: it isn't valid JSON (${(e as Error).message})`);
    }
  }
  edit(data);
  const indent = raw.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
  fs.writeFileSync(file, JSON.stringify(data, null, indent) + "\n");
  cache.delete(file);
  return file;
}

/**
 * Write a server's entry into servedev.json, keeping other servers, other keys and the file's
 * indentation. Replacing an entry that differs needs `force`.
 */
export function saveToConfig(s: Server, opts: { force?: boolean; includeSecrets?: boolean } = {}): ConfigPlan & { written: boolean } {
  const plan = planSave(s, opts);
  if (plan.state === "defined") return { ...plan, written: false };
  if (plan.state === "differs" && !opts.force) {
    throw new ConfigConflict(
      `${plan.file} already defines "${s.name}" differently (${plan.changes.map((c) => c.key).join(", ")}). Replace it with force.`,
    );
  }
  editConfigFile(s.root, (data) => {
    data.servers ??= {};
    const kept = Object.fromEntries(Object.entries(data.servers[s.name] ?? {}).filter(([k]) => !(MANAGED as readonly string[]).includes(k)));
    data.servers[s.name] = { ...plan.entry, ...kept };
  });
  return { ...plan, written: true };
}
