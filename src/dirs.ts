/**
 * Folder browsing for the "new server" dialog where there's no native picker: another machine's
 * servedev (through a hub), or a browser on a machine without one. Lists subfolders only, never
 * files or their contents, with a few markers that say which ones look like projects.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class DirError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What a folder holds that matters when picking one to run a server in. */
export interface DirMarkers {
  /** package.json */
  package?: boolean;
  /** servedev.json */
  servedev?: boolean;
  /** .git (a repo, or a worktree's .git file) */
  git?: boolean;
}

export interface DirEntry extends DirMarkers {
  name: string;
  path: string;
  /** A symlink to a folder. */
  link?: boolean;
}

export interface DirListing extends DirMarkers {
  /** The folder listed: absolute, normalized, with ~ expanded. */
  path: string;
  /** Its parent; absent at the filesystem root. */
  parent?: string;
  /** The home folder on this machine (where ~ points). */
  home: string;
  dirs: DirEntry[];
  /** Folders left out because they're hidden (names starting with "." and node_modules). */
  hidden: number;
  /** More subfolders than `limit`; the first `limit` (sorted) are listed. */
  truncated?: boolean;
}

/** Hidden unless asked for: dot-folders, and node_modules (never a place to start a server). */
export function isHiddenDir(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/**
 * The absolute folder a path names on this machine. "~" and "~/x" are the home folder; a relative
 * path is taken from home too (the daemon's own working directory means nothing to the user).
 * "..", "." and repeated slashes are normalized, so the answer always says where it really is.
 */
export function resolveDirPath(raw: string | undefined | null, home = os.homedir()): string {
  const p = (raw ?? "").trim();
  if (p.includes("\0")) throw new DirError(400, "the path contains a NUL character");
  if (!p || p === "~") return home;
  if (/^~[^/]/.test(p)) throw new DirError(400, `${p.split("/")[0]}: only ~ (your own home) is supported; give the full path instead`);
  const expanded = p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
  return path.resolve(home, expanded);
}

async function markers(dir: string): Promise<DirMarkers> {
  const has = (name: string) =>
    fs.promises.access(path.join(dir, name)).then(
      () => true,
      () => false,
    );
  const [pkg, servedev, git] = await Promise.all([has("package.json"), has("servedev.json"), has(".git")]);
  return { ...(pkg ? { package: true } : {}), ...(servedev ? { servedev: true } : {}), ...(git ? { git: true } : {}) };
}

export interface ListOptions {
  /** Include hidden folders (see isHiddenDir). */
  hidden?: boolean;
  /** At most this many subfolders (default 500). */
  limit?: number;
  home?: string;
}

/** The subfolders of a folder, sorted by name (case-insensitive), with project markers. */
export async function listDirs(raw: string | undefined | null, opts: ListOptions = {}): Promise<DirListing> {
  const home = opts.home ?? os.homedir();
  const dir = resolveDirPath(raw, home);
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(dir);
  } catch (e) {
    throw fsError(e, dir);
  }
  if (!st.isDirectory()) throw new DirError(400, `${dir} is a file, not a folder`);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    throw fsError(e, dir);
  }
  let hidden = 0;
  const candidates: { name: string; link: boolean }[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    candidates.push({ name: e.name, link: e.isSymbolicLink() });
  }
  // Symlinks count only when they lead to a folder.
  const resolved = await Promise.all(
    candidates.map(async (c) => {
      if (!c.link) return c;
      const ok = await fs.promises.stat(path.join(dir, c.name)).then(
        (s) => s.isDirectory(),
        () => false,
      );
      return ok ? c : undefined;
    }),
  );
  const visible: { name: string; link: boolean }[] = [];
  for (const c of resolved) {
    if (!c) continue;
    if (!opts.hidden && isHiddenDir(c.name)) hidden++;
    else visible.push(c);
  }
  visible.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  const shown = visible.slice(0, limit);
  const [own, ...each] = await Promise.all([markers(dir), ...shown.map((c) => markers(path.join(dir, c.name)))]);
  const parent = path.dirname(dir);
  return {
    path: dir,
    ...(parent !== dir ? { parent } : {}),
    home,
    ...own,
    dirs: shown.map((c, i) => ({ name: c.name, path: path.join(dir, c.name), ...(c.link ? { link: true } : {}), ...each[i] })),
    hidden,
    ...(visible.length > limit ? { truncated: true } : {}),
  };
}

function fsError(e: unknown, dir: string): DirError {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return new DirError(404, `no folder at ${dir}`);
  if (code === "ENOTDIR") return new DirError(400, `${dir} isn't a folder`);
  if (code === "EACCES" || code === "EPERM") return new DirError(403, `no permission to read ${dir}`);
  return new DirError(500, `can't read ${dir}: ${(e as Error).message}`);
}
