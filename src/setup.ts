import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProjectEntry } from "./config";
import { gitInfo, normalizeRemote } from "./git";

/**
 * `servedev setup`: on a new machine (config.json copied over, e.g. from a dotfiles repo), find
 * where each project's repo is cloned here, by its git remote, and fix the paths.
 */

interface Candidate {
  path: string;
  remote?: string;
  worktree: boolean;
}

export interface Scan {
  repos: Candidate[];
  /** Folder name -> paths, for projects that aren't git repos. */
  folders: Map<string, string[]>;
}

const SKIP = new Set(["node_modules", "Library", "Applications", "Pictures", "Music", "Movies", "Public", "vendor", "dist", "build", "target", "tmp"]);

/** Git checkouts under likely folders, breadth first, with depth and time limits so a big home folder can't stall it. */
export function scanForRepos(roots: { dir: string; depth: number }[], budgetMs = 3000): Scan {
  const deadline = Date.now() + budgetMs;
  const repos: Candidate[] = [];
  const folders = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const { dir, depth } of roots) {
    const queue: [string, number][] = [[dir, 0]];
    while (queue.length && Date.now() < deadline) {
      const [cur, d] = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      folders.set(path.basename(cur), [...(folders.get(path.basename(cur)) ?? []), cur]);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((e) => e.name === ".git")) {
        const git = gitInfo(cur);
        if (git && git.toplevel === cur) repos.push({ path: cur, remote: git.remote, worktree: git.worktree });
      }
      if (d >= depth) continue;
      for (const e of entries) {
        if (!e.isDirectory() || (e.name.startsWith(".") && e.name !== ".worktrees") || SKIP.has(e.name)) continue;
        queue.push([path.join(cur, e.name), d + 1]);
      }
    }
  }
  return { repos, folders };
}

/** Where to look: next to projects that are already here, the usual code folders, and home. */
export function defaultScanRoots(known: string[], extra: string[] = []): { dir: string; depth: number }[] {
  const home = os.homedir();
  const dirs = new Map<string, number>();
  for (const d of extra) dirs.set(path.resolve(d.replace(/^~(?=$|\/)/, home)), 4);
  for (const root of known) {
    const top = gitInfo(root)?.toplevel ?? root;
    dirs.set(path.dirname(top), 2);
  }
  for (const d of ["code", "src", "dev", "projects", "Developer", "Documents/GitHub", "repos", "work", "git"]) dirs.set(path.join(home, d), 3);
  dirs.set(home, 2);
  return [...dirs.entries()].filter(([d]) => fs.existsSync(d)).map(([dir, depth]) => ({ dir, depth }));
}

export interface Located {
  status: "ok" | "found" | "missing";
  path?: string;
  how?: "map" | "remote" | "worktree" | "folder";
  reason?: string;
}

/**
 * Where a project is on this machine. `map` (remote, project name or folder name -> path) wins;
 * then the repo's remote (a worktree needs a checkout with the same folder name); then, for
 * projects without a remote, a folder with the same name.
 */
export function locate(label: string, entry: ProjectEntry, scan: Scan, map: Record<string, string> = {}): Located {
  if (fs.existsSync(entry.path)) return { status: "ok", path: entry.path };
  const folder = path.basename(entry.path);
  const mapped = map[label] ?? (entry.remote ? (map[entry.remote] ?? map[normalizeRemote(entry.remote)]) : undefined) ?? map[folder];
  if (mapped) {
    const p = path.resolve(mapped.replace(/^~(?=$|\/)/, os.homedir()));
    return fs.existsSync(p) ? { status: "found", path: p, how: "map" } : { status: "missing", reason: `mapped to ${p}, which doesn't exist` };
  }
  if (entry.remote) {
    const same = scan.repos.filter((r) => r.remote === entry.remote);
    const named = same.find((r) => path.basename(r.path) === folder);
    if (named) return { status: "found", path: named.path, how: named.worktree ? "worktree" : "remote" };
    // A worktree needs its own checkout; only a main checkout can be matched by remote alone.
    if (entry.worktree) {
      return {
        status: "missing",
        reason: `it was a worktree of ${entry.remote} for branch ${entry.worktree}${same.length ? `; create it with: git -C ${same.find((r) => !r.worktree)?.path ?? same[0].path} worktree add <path>/${folder} ${entry.worktree}` : `, and ${entry.remote} isn't cloned here`}`,
      };
    }
    const main = same.find((r) => !r.worktree);
    if (main) return { status: "found", path: main.path, how: "remote" };
    return { status: "missing", reason: `${entry.remote}${same.length ? ` is cloned here, but not as ${folder}` : " isn't cloned here (or not where servedev looked)"}` };
  }
  const byName = (scan.folders.get(folder) ?? []).filter((p) => fs.existsSync(p));
  const best = byName.find((p) => fs.existsSync(path.join(p, "servedev.json")) || fs.existsSync(path.join(p, "package.json"))) ?? byName[0];
  return best ? { status: "found", path: best, how: "folder" } : { status: "missing", reason: `no folder called ${folder} found` };
}
