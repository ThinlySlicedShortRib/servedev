/**
 * Starting servers on another machine from the hub, including new ones: the server is defined on
 * that machine (its config.json / servedev.json), in a folder there, and owned by it. The hub only
 * turns the request into one that machine's own /api/start understands.
 */
import type { PublicServer } from "../manager";
import { RemoteApiError } from "./api";
import { RefError, resolveRemoteRef } from "./ids";

/** What a start request may carry to another machine (never the hub's paths or environment). */
const PASSED = ["command", "setup", "stop", "install", "hostname", "cwd", "vars", "replaceVars", "port", "ready", "timeout", "restart", "wait", "profile"] as const;

export interface RemoteStartRequest {
  /** Server name there, or its id there ("demo:api"). */
  name?: string;
  /** Folder on that machine to run it in: absolute or ~/...; needed for a server it doesn't know yet. */
  dir?: string;
  [key: string]: unknown;
}

/** The parts of a remote's /api/inspect the hub needs to start a server there. */
export interface RemoteFolder {
  dir: string;
  exists: boolean;
  root?: string;
}

export interface RemoteStartDeps {
  machine: string;
  /** That machine's servers as last seen. */
  servers: PublicServer[];
  /** GET /api/inspect?dir= on that machine. */
  inspect: (dir: string) => Promise<RemoteFolder>;
}

/** A path on another machine: absolute or under ~ there (relative ones would depend on its daemon's cwd). */
export function assertRemotePath(machine: string, p: string, what = "folder"): string {
  const v = p.trim();
  if (!v) throw new RefError(400, `pass the ${what} on ${machine}`);
  if (!v.startsWith("/") && v !== "~" && !v.startsWith("~/")) {
    throw new RefError(400, `"${v}" isn't a path on ${machine}: use an absolute path or one starting with ~/ (its home there)`);
  }
  return v;
}

/**
 * The body for that machine's /api/start. A known server is started by its id there (options
 * like a new command apply to it); with `dir`, the folder is looked up there first and the server
 * is created (or found) in that folder's project, the same as `servedev start <name> -- <cmd>` run
 * in that folder.
 */
export async function remoteStartBody(deps: RemoteStartDeps, req: RemoteStartRequest): Promise<Record<string, unknown>> {
  const opts: Record<string, unknown> = {};
  for (const k of PASSED) if (req[k] !== undefined) opts[k] = req[k];
  const name = typeof req.name === "string" ? req.name.trim() : "";
  const dir = typeof req.dir === "string" && req.dir.trim() ? assertRemotePath(deps.machine, req.dir) : undefined;

  if (typeof opts.cwd === "string" && opts.cwd.startsWith("~")) {
    // The remote resolves cwd with path.resolve, which doesn't know ~; its inspect does.
    opts.cwd = (await deps.inspect(assertRemotePath(deps.machine, opts.cwd, "working directory"))).dir;
  }

  if (dir && !name.includes(":")) {
    const folder = await deps.inspect(dir);
    if (!folder.exists || !folder.root) throw new RefError(404, `no folder at ${folder.dir} on ${deps.machine}`);
    return { ...opts, root: folder.root, clientCwd: folder.dir, ...(name ? { name } : {}) };
  }
  if (!name) {
    throw new RefError(400, `pass a server name, or the folder on ${deps.machine} to run a new one in (--dir, or dir for agents)`);
  }
  let server: PublicServer;
  try {
    server = resolveRemoteRef(deps.machine, name, deps.servers);
  } catch (e) {
    if (e instanceof RefError && e.status === 404 && !name.includes(":")) {
      throw new RefError(
        404,
        `${e.message}. To create it, pass the folder on ${deps.machine}: servedev start ${name} --on ${deps.machine} --dir <path there> [-- <command>]`,
      );
    }
    throw e;
  }
  // Its folder there stands in for "where the command was run", so a new command keeps its cwd.
  return { ...opts, id: server.id, clientCwd: server.cwd };
}

/** A remote's "not found: GET /api/dirs": its servedev predates the endpoint. */
export function isMissingEndpoint(e: unknown): boolean {
  return e instanceof RemoteApiError && e.status === 404 && /^not found: (GET|POST) \/api\//.test(e.message);
}

/** The error for a feature the machine's servedev is too old for. */
export function tooOld(machine: string, version: string | undefined, hubVersion: string, what: string): RefError {
  return new RefError(
    501,
    `${machine} runs servedev ${version ?? "an older version"}, which can't ${what}; update it (this machine runs ${hubVersion}).`,
  );
}
