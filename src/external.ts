/**
 * Dev servers running outside servedev: processes listening on a port from inside a project folder
 * that servedev didn't start. servedev can show them and take them over (stop, then start the same
 * command in the same folder under its management); it can't see their logs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Listener, Proc } from "./ports";
import { findRoot } from "./project";

export interface ExternalServer {
  /** Stable while it runs: "ext:<pid of the command that started it>". */
  id: string;
  /** The command that started the server (what take-over re-runs). */
  pid: number;
  pgid: number;
  command: string;
  cwd: string;
  root: string;
  ports: number[];
  /** Every process in the server's tree, i.e. what take-over stops. */
  pids: number[];
  startedAt?: number;
  /** Its folder was deleted (e.g. a removed git worktree): it can be stopped but not taken over. */
  orphaned?: boolean;
  /** Folder of the listening process, which can be deeper than `cwd` (e.g. apps/api under a monorepo). */
  serverCwd?: string;
}

/** Shells end the climb: a server started from an agent's or terminal's shell shouldn't take the shell with it. */
const SHELL = /^(-?(sh|bash|zsh|fish|dash|ksh|tcsh|csh)|login|tmux|screen|launchd)$/;

function programOf(command: string): string {
  return path.basename(command.split(/\s+/)[0] ?? "");
}

/**
 * Any shell, including `sh -c "..."` wrappers: agents' shell tools wrap commands in shells full of
 * their own setup, so the server's own program is what gets stopped and re-run.
 */
function isShell(p: Proc): boolean {
  return SHELL.test(programOf(p.command));
}

/**
 * The process that launched a listening process: climb parents in the same process group until
 * reaching a shell, launchd, or another group.
 */
export function launcherOf(pid: number, byPid: Map<number, Proc>): Proc | undefined {
  let cur = byPid.get(pid);
  while (cur) {
    const parent = byPid.get(cur.ppid);
    if (!parent || parent.pid <= 1 || parent.pgid !== cur.pgid || isShell(parent)) return cur;
    cur = parent;
  }
  return undefined;
}

export function subtree(rootPid: number, table: Proc[]): number[] {
  const children = new Map<number, number[]>();
  for (const p of table) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid)!.push(p.pid);
  }
  const out: number[] = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop()!;
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * For a folder that no longer exists: the nearest existing ancestor plus the next path segment,
 * e.g. ~/code/worktrees/feat-x for a deleted ~/code/worktrees/feat-x/apps/api.
 */
export function deletedRoot(dir: string): string {
  let cur = dir;
  while (!fs.existsSync(path.dirname(cur)) && path.dirname(cur) !== cur) cur = path.dirname(cur);
  return cur;
}

function looksLikeProject(dir: string): boolean {
  const root = findRoot(dir);
  return [dir, root].some((d) => fs.existsSync(path.join(d, "package.json")) || fs.existsSync(path.join(d, "servedev.json"))) ||
    fs.existsSync(path.join(root, ".git"));
}

/**
 * Pick out dev servers from the machine's listeners. `managed` holds every pid servedev manages;
 * `cwds` and `started` are looked up by the caller (lsof / ps) for the pids it asks about.
 */
export function detectExternal(opts: {
  table: Proc[];
  listeners: Listener[];
  managed: Set<number>;
  cwds: Map<number, string>;
  started?: Map<number, number>;
  home?: string;
  self?: number;
}): ExternalServer[] {
  const home = opts.home ?? os.homedir();
  const byPid = new Map(opts.table.map((p) => [p.pid, p]));
  const found = new Map<number, ExternalServer>();
  for (const l of opts.listeners) {
    if (opts.managed.has(l.pid) || l.pid === opts.self) continue;
    const launcher = launcherOf(l.pid, byPid);
    if (!launcher || opts.managed.has(launcher.pid)) continue;
    const existing = found.get(launcher.pid);
    if (existing) {
      if (!existing.ports.includes(l.port)) existing.ports.push(l.port);
      continue;
    }
    const cwd = opts.cwds.get(launcher.pid) ?? opts.cwds.get(l.pid);
    // Apps (Spotify, Docker, editors) listen too; dev servers run from inside a project in your home folder.
    if (!cwd || cwd === home || !cwd.startsWith(home + path.sep) || cwd.includes(`${path.sep}Library${path.sep}`)) continue;
    if (/^\/(Applications|System|Library|usr\/libexec)\//.test(launcher.command)) continue;
    const orphaned = !fs.existsSync(cwd);
    if (!orphaned && !looksLikeProject(cwd)) continue;
    found.set(launcher.pid, {
      id: `ext:${launcher.pid}`,
      pid: launcher.pid,
      pgid: launcher.pgid,
      command: launcher.command,
      cwd,
      serverCwd: opts.cwds.get(l.pid) ?? cwd,
      root: orphaned ? deletedRoot(cwd) : findRoot(cwd),
      ports: [l.port],
      pids: subtree(launcher.pid, opts.table),
      startedAt: opts.started?.get(launcher.pid),
      ...(orphaned ? { orphaned: true } : {}),
    });
  }
  return [...found.values()].map((e) => ({ ...e, ports: e.ports.sort((a, b) => a - b) }));
}

/**
 * A name for an outside server: the pnpm/npm workspace filter and script ("api", "api-db-studio"),
 * else the folder it listens from, else the program ("cloud-sql-proxy").
 */
export function suggestName(e: Pick<ExternalServer, "command" | "cwd" | "root" | "serverCwd">): string {
  const clean = (s: string) => s.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  const filter = /--filter[= ](\S+)(?:\s+(exec\b|run\s+)?([\w:.-]+))?/.exec(e.command);
  if (filter) {
    // `pnpm --filter x exec vite` runs a program, not a script; the package is the name.
    const script = filter[2]?.startsWith("exec") ? undefined : filter[3];
    return clean(script && !["dev", "start", "serve", "exec", "run", "--"].includes(script) ? `${filter[1]}-${script}` : filter[1]);
  }
  const dir = e.serverCwd ?? e.cwd;
  if (dir !== e.root) return clean(path.basename(dir));
  const program = path.basename(e.command.split(/\s+/)[0] ?? "");
  return ["node", "bun", "deno", "python", "python3", "ruby"].includes(program) ? "dev" : clean(program) || "dev";
}

/** Current working directories of processes, via one lsof call. */
export async function cwdsOf(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  const proc = Bun.spawn(["lsof", "-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) out.set(pid, line.slice(1));
  }
  return out;
}

/** Start times of processes, via ps. */
export async function startTimesOf(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!pids.length) return out;
  const proc = Bun.spawn(["ps", "-o", "pid=,lstart=", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C" } });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    const t = m && Date.parse(m[2]);
    if (m && t) out.set(Number(m[1]), t);
  }
  return out;
}
