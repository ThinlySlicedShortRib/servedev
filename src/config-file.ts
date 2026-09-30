import fs from "node:fs";
import path from "node:path";

import { looksSecret } from "./env";
import type { Server } from "./manager";
import { CONFIG_FILE, normalizeReady, type ReadySpec, type ServerConfig } from "./project";
import { portableCommand } from "./sanitize";

/**
 * Writing servers into their repo's servedev.json, so their setup travels with the code (a
 * teammate clones and runs `servedev up`; a new machine needs nothing else). The writing itself
 * goes through ConfigStore (config.ts); these are the pure parts: what an entry looks like, and
 * how it compares with what's in the file.
 */

/** Keys servedev manages for a server; others (timeout, dependsOn, anything newer) are left alone. */
export const MANAGED = ["command", "setup", "cwd", "port", "hostname", "ready", "env"] as const;

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

/** A ReadySpec as servedev.json writes it: { log, url }, "none", or nothing for the default. */
export function readyToConfig(ready: ReadySpec | undefined): ServerConfig["ready"] | undefined {
  const r = ready ?? {};
  if (r.log || r.url) return { ...(r.log ? { log: r.log } : {}), ...(r.url ? { url: r.url } : {}) };
  return r.mode === "none" ? "none" : undefined;
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
  const ready = readyToConfig(s.ready);
  if (ready) entry.ready = ready;
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

export const sameValue = (key: string, a: unknown, b: unknown) => JSON.stringify(canonical(key, a)) === JSON.stringify(canonical(key, b));

export function diffEntries(current: ServerConfig | undefined, entry: ServerConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const key of MANAGED) {
    const before = current?.[key];
    const after = entry[key];
    if (!sameValue(key, before, after)) changes.push({ key, before: canonical(key, before), after: canonical(key, after) });
  }
  return changes;
}

/**
 * How a server compares to its repo's servedev.json (`current` is its entry there, if any), and
 * what saving it would change.
 */
export function planSave(s: Server, current: ServerConfig | undefined, opts: { includeSecrets?: boolean } = {}): ConfigPlan {
  const file = path.join(s.root, CONFIG_FILE);
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

/** Just the state, for server views. */
export function configState(s: Server, current: ServerConfig | undefined): ConfigState {
  if (!current) return "missing";
  // Secret-looking variables are left out of servedev.json on purpose, so they don't count as drift.
  return diffEntries(current, serverToConfig(s, { baseEnv: current.env }).entry).length ? "differs" : "defined";
}

/** The entry to write for a server: the plan's, keeping keys servedev doesn't manage (timeout, dependsOn). */
export function mergedEntry(plan: ConfigPlan): ServerConfig {
  const kept = Object.fromEntries(Object.entries(plan.current ?? {}).filter(([k]) => !(MANAGED as readonly string[]).includes(k)));
  return { ...plan.entry, ...kept };
}
