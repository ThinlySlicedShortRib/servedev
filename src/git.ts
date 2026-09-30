import fs from "node:fs";
import path from "node:path";

/** The .git directory for a folder: the nearest .git above it, following a worktree's "gitdir:" file. */
function gitDir(dir: string): string | undefined {
  let cur = path.resolve(dir);
  while (true) {
    const dotGit = path.join(cur, ".git");
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) return dotGit;
      const target = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
      return target ? path.resolve(cur, target) : undefined;
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * The branch checked out in a folder, read from git's HEAD file (no git process, and it also works
 * before the first commit). A detached checkout gives "detached@<short sha>".
 */
export function gitBranch(dir: string): string | undefined {
  const g = gitDir(dir);
  if (!g) return undefined;
  let head: string;
  try {
    head = fs.readFileSync(path.join(g, "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  if (ref) return ref;
  return /^[0-9a-f]{7,}$/.test(head) ? `detached@${head.slice(0, 7)}` : undefined;
}

/** "git@github.com:Acme/App.git", "https://github.com/acme/app" → "github.com/acme/app". */
export function normalizeRemote(url: string): string {
  let u = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = u.match(/^(?:[^@\s/]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const parsed = new URL(u);
      u = `${parsed.hostname}${parsed.pathname}`;
    } catch {}
  }
  return u.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
}

function remoteFromConfig(configFile: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(configFile, "utf8");
  } catch {
    return undefined;
  }
  const remotes: Record<string, string> = {};
  let current: string | undefined;
  for (const line of text.split("\n")) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/);
    if (section) current = section[1];
    else if (/^\s*\[/.test(line)) current = undefined;
    const url = current && line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (url && current) remotes[current] ??= url[1];
  }
  const url = remotes.origin ?? Object.values(remotes)[0];
  return url ? normalizeRemote(url) : undefined;
}

export interface GitInfo {
  /** The checkout's top folder (a worktree's own folder for a worktree). */
  toplevel: string;
  /** Normalized remote ("github.com/acme/app"), shared by every worktree of the repo. */
  remote?: string;
  worktree: boolean;
}

/** The git checkout containing `dir`, read from files (no git process). */
export function gitInfo(dir: string): GitInfo | undefined {
  let cur = path.resolve(dir);
  while (true) {
    const dotgit = path.join(cur, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotgit);
    } catch {}
    if (stat?.isDirectory()) return { toplevel: cur, remote: remoteFromConfig(path.join(dotgit, "config")), worktree: false };
    if (stat?.isFile()) {
      // A worktree (or submodule): ".git" names its git dir; the remotes live in the common dir.
      const gitdir = fs.readFileSync(dotgit, "utf8").match(/gitdir:\s*(.+)/)?.[1]?.trim();
      if (!gitdir) return { toplevel: cur, worktree: true };
      const abs = path.resolve(cur, gitdir);
      let common = abs;
      try {
        common = path.resolve(abs, fs.readFileSync(path.join(abs, "commondir"), "utf8").trim());
      } catch {}
      return { toplevel: cur, remote: remoteFromConfig(path.join(common, "config")), worktree: true };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * The same repo on any machine and in any worktree: its remote (plus the folder inside the repo,
 * for a project that isn't the repo's top), or "folder:<name>" without a remote.
 */
export function repoIdentity(root: string): string {
  const git = gitInfo(root);
  if (!git?.remote) return `folder:${path.basename(root)}`;
  const sub = path.relative(git.toplevel, root);
  return sub ? `${git.remote}#${sub}` : git.remote;
}
