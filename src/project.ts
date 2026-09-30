import fs from "node:fs";
import path from "node:path";
import type { Selections } from "./accounts/registry";
import { detectPackageManager } from "./install";
import { parseJsonc } from "./jsonc";

export interface ReadySpec {
  /** "port" (default): ready once the process listens on a TCP port. "none": ready as soon as it spawns. */
  mode?: "port" | "none";
  /** Regex matched against log output. */
  log?: string;
  /** URL or path (e.g. "/health") that must answer with a status < 500. */
  url?: string;
}

export interface ServerConfig {
  command: string;
  /** Runs before the command on every start, e.g. "pnpm install". */
  setup?: string;
  /** Custom hostname served by the daemon's proxy, e.g. "keel.localhost". */
  hostname?: string;
  cwd?: string;
  port?: number | "auto";
  env?: Record<string, string>;
  ready?: ReadySpec | "none" | "port";
  timeout?: number;
  dependsOn?: string[];
}

/** A tile of a dashboard grid: which server, where, and how big, in grid units (12 columns). */
export interface GridTile {
  /** A server name in a repo's servedev.json; a server id ("project:name") in your own config. */
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mode?: "logs" | "preview";
}

/** A profile shared through the repo: everyone who clones it gets it. */
export interface SharedProfileConfig {
  description?: string;
  /** Server names in this servedev.json, in start order. */
  servers: string[];
  /** What the servers need, without anyone's identity: e.g. { gcloud: { project: "acme-dev" } }. */
  accounts?: Selections;
  /** The default grid; everyone can arrange their own on top. */
  grid?: GridTile[];
}

/** A repo's servedev.json (JSON with comments allowed). */
export interface ProjectConfig {
  $schema?: string;
  servers?: Record<string, ServerConfig>;
  profiles?: Record<string, SharedProfileConfig>;
}

export const CONFIG_FILE = "servedev.json";

/** Nearest ancestor containing servedev.json or .git; falls back to dir itself. */
export function findRoot(dir: string): string {
  let cur = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(cur, CONFIG_FILE)) || fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(dir);
    cur = parent;
  }
}

/** A project's servedev.json, read directly (the daemon keeps a watched copy in ConfigStore). */
export function loadConfig(root: string): ProjectConfig {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return {};
  const { data, error } = parseJsonc(fs.readFileSync(file, "utf8"));
  if (error) throw new Error(`could not parse ${file}: line ${error.line}, column ${error.column}: ${error.message}`);
  return data as ProjectConfig;
}

export function normalizeReady(r: ServerConfig["ready"]): ReadySpec | undefined {
  if (r === undefined) return undefined;
  return typeof r === "string" ? { mode: r } : r;
}

export interface Detected {
  command: string;
  /** Appended when a port is requested; uses the {port} placeholder. */
  portArgs?: string;
  kind: string;
}

/** Guess how to run the dev server in `dir`. */
export function detectCommand(dir: string, root: string): Detected | undefined {
  const pkgFile = path.join(dir, "package.json");
  if (fs.existsSync(pkgFile)) {
    let pkg: { scripts?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    } catch {}
    const script = ["dev", "start", "serve"].find((s) => pkg.scripts?.[s]);
    if (script) {
      const pm = detectPackageManager(dir, root);
      const body = pkg.scripts![script];
      // Frameworks that take --port; others are expected to read $PORT.
      const takesPortFlag = /\b(vite|next|astro|nuxt|nuxi|remix|svelte-kit|webpack(-dev-server| serve)|parcel|ng serve|react-router)\b/.test(body);
      return {
        command: `${pm} run ${script}`,
        portArgs: takesPortFlag ? (pm === "npm" ? " -- --port {port}" : " --port {port}") : undefined,
        kind: `package.json "${script}" script (${body})`,
      };
    }
  }
  if (fs.existsSync(path.join(dir, "manage.py"))) {
    return { command: "python manage.py runserver {port}", kind: "Django" };
  }
  if (fs.existsSync(path.join(dir, "bin/rails"))) {
    return { command: "bin/rails server -p {port}", kind: "Rails" };
  }
  return undefined;
}
