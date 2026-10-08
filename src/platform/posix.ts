/**
 * macOS and Linux (and WSL): lsof (plus ss on Linux) for ports, ps for processes, `/bin/sh -c` in
 * process groups of their own, SIGTERM then SIGKILL, the login shell's environment, and a
 * LaunchAgent for login autostart (macOS only).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Unsupported, type AutostartContext, type AutostartStatus, type Listener, type Platform, type Proc } from "./types";

// ---------- ports ----------

async function run(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } catch {
    // not installed
    return "";
  }
}

/** All TCP ports in LISTEN state owned by the current user, via lsof (and ss on Linux). */
async function listeners(): Promise<Listener[]> {
  const [lsof, ss] = await Promise.all([
    run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pgcn"]),
    process.platform === "linux" ? run(["ss", "-ltnpH"]) : Promise.resolve(""),
  ]);
  const found = parseLsof(lsof);
  // Linux lsof leaves out processes whose name has a space and parentheses (Next 16's
  // "next-server (v16.3.8)"); ss lists them, so add what lsof missed.
  const seen = new Set(found.map((l) => `${l.pid}:${l.port}`));
  for (const l of parseSs(ss, pgidOf)) if (!seen.has(`${l.pid}:${l.port}`)) found.push(l);
  return found;
}

/** A process's group from /proc (Linux); its name can hold spaces and ")", so read after the last ")". */
function pgidOf(pid: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) || pid;
  } catch {
    return pid;
  }
}

/**
 * `ss -ltnpH` lines: `LISTEN 0 511 *:3000 *:* users:(("next-server (v1",pid=20994,fd=22))`.
 * Only your own processes show their pid, which is all servedev needs.
 */
export function parseSs(out: string, pgid: (pid: number) => number): Listener[] {
  const result: Listener[] = [];
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    const port = local ? Number(local.slice(local.lastIndexOf(":") + 1)) : 0;
    if (!port) continue;
    for (const m of line.matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g)) {
      const pid = Number(m[2]);
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ pid, pgid: pgid(pid), command: m[1], port });
    }
  }
  return result;
}

export function parseLsof(out: string): Listener[] {
  const result: Listener[] = [];
  const seen = new Set<string>();
  let pid = 0;
  let pgid = 0;
  let command = "";
  for (const line of out.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") pid = Number(value);
    else if (tag === "g") pgid = Number(value);
    else if (tag === "c") command = value;
    else if (tag === "n") {
      const port = Number(value.slice(value.lastIndexOf(":") + 1));
      const key = `${pid}:${port}`;
      if (port && !seen.has(key)) {
        seen.add(key);
        result.push({ pid, pgid, command, port });
      }
    }
  }
  return result;
}

// ---------- processes ----------

/** Every process on the machine, from ps. */
async function processTable(): Promise<Proc[]> {
  const proc = Bun.spawn(["ps", "-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return parsePs(out);
}

export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4].trim() });
  }
  return procs;
}

/** Current working directories of processes, via one lsof call. */
async function cwdsOf(pids: number[]): Promise<Map<number, string>> {
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
async function startTimesOf(pids: number[]): Promise<Map<number, number>> {
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

// ---------- signals ----------

const SIGNAL = { graceful: "SIGTERM", force: "SIGKILL" } as const;

function groupAlive(pgid: number | undefined): boolean {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroups(pgids: number[], how: "graceful" | "force") {
  for (const pgid of pgids) {
    try {
      process.kill(-pgid, SIGNAL[how]);
    } catch {}
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPids(pids: number[], how: "graceful" | "force") {
  for (const pid of pids) {
    try {
      process.kill(pid, SIGNAL[how]);
    } catch {}
  }
}

/** SIGTERM, up to 5s to exit, then SIGKILL and up to 2s more. */
async function terminate(alive: () => boolean, signal: (how: "graceful" | "force") => void) {
  signal("graceful");
  for (let i = 0; i < 50 && alive(); i++) await Bun.sleep(100);
  if (alive()) {
    signal("force");
    for (let i = 0; i < 20 && alive(); i++) await Bun.sleep(100);
  }
}

// ---------- environment ----------

export const ENV_MARK = "__servedev_env__";

/** Parse `env -0` output after the marker (rc files may print banners before it). */
export function parseEnvOutput(out: string): Record<string, string> {
  const at = out.indexOf(ENV_MARK);
  if (at < 0) return {};
  const env: Record<string, string> = {};
  for (const entry of out.slice(at + ENV_MARK.length).split("\0")) {
    const i = entry.indexOf("=");
    if (i > 0) env[entry.slice(0, i).replace(/^\n/, "")] = entry.slice(i + 1);
  }
  return env;
}

/**
 * The user's login shell started from a near-empty environment (so the daemon's own environment,
 * e.g. from whichever agent launched it, doesn't leak in).
 */
async function loginShellEnv(): Promise<Record<string, string>> {
  const shell = process.env.SHELL || "/bin/zsh";
  const seed: Record<string, string> = {
    HOME: os.homedir(),
    USER: os.userInfo().username,
    LOGNAME: os.userInfo().username,
    SHELL: shell,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    TERM: "xterm-256color",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  if (process.env.LANG) seed.LANG = process.env.LANG;
  const proc = Bun.spawn([shell, "-ilc", `printf '%s' '${ENV_MARK}'; env -0`], { env: seed, stdin: "ignore", stdout: "pipe", stderr: "ignore", cwd: os.homedir() });
  const timer = setTimeout(() => proc.kill(), 8000);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  await proc.exited;
  const env = parseEnvOutput(out);
  if (!env.PATH) throw new Error("no PATH from the login shell");
  return env;
}

// ---------- desktop ----------

async function pickFolder(start?: string): Promise<string | null> {
  let cmd: string[];
  if (process.platform === "darwin") {
    const from = start && fs.existsSync(start) ? ` default location (POSIX file ${JSON.stringify(start)})` : "";
    // `activate` brings osascript's own dialog to the front; no Automation permission needed.
    cmd = ["osascript", "-e", "activate", "-e", `POSIX path of (choose folder with prompt "Choose a folder to run a dev server in"${from})`];
  } else if (Bun.which("zenity")) {
    cmd = ["zenity", "--file-selection", "--directory", "--title=Choose a folder to run a dev server in", ...(start ? [`--filename=${start}/`] : [])];
  } else {
    throw new Unsupported("no native folder picker on this system; type the path instead");
  }
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code === 0) return out.trim().replace(/(.)\/$/, "$1") || null;
  if (proc.signalCode || /-128|cancel/i.test(err) || (cmd[0] === "zenity" && code === 1)) return null;
  throw new Error(`folder picker failed: ${err.trim() || `exit ${code}`}`);
}

// ---------- login autostart (macOS LaunchAgent) ----------

/*
 * A LaunchAgent that starts the daemon with --autostart at login, which then starts every pinned
 * server. It only launches the daemon (no KeepAlive), so the CLI can still stop and replace the
 * daemon, e.g. after an upgrade.
 */

export const LABEL = "dev.servedev.daemon";

/** Overridable so tests never touch the real ~/Library/LaunchAgents. */
export function agentFile(): string {
  const dir = process.env.SERVEDEV_LAUNCH_AGENTS_DIR ?? path.join(os.homedir(), "Library", "LaunchAgents");
  return path.join(dir, `${LABEL}.plist`);
}

function xml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function plist(program: string[], env: Record<string, string>, log: string): string {
  const args = program.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const vars = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Servers run in their own process groups; never let launchd reap them with the daemon. -->
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function autostartStatus(): AutostartStatus {
  const file = agentFile();
  return { supported: process.platform === "darwin", installed: fs.existsSync(file), file };
}

/** Writes the LaunchAgent; not loaded now, because a daemon is already running. */
function installAutostart(ctx: AutostartContext): AutostartStatus {
  if (process.platform !== "darwin") return autostartStatus();
  const env: Record<string, string> = {
    // launchd's default PATH is minimal; servers started from the dashboard need the user's.
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    SERVEDEV_HOME: ctx.home,
    SERVEDEV_PORT: String(ctx.port),
  };
  const file = agentFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist([...ctx.program, "daemon", "run", "--autostart"], env, ctx.log));
  return autostartStatus();
}

function uninstallAutostart(): AutostartStatus {
  fs.rmSync(agentFile(), { force: true });
  return autostartStatus();
}

// ---------- the platform ----------

export const posix: Platform = {
  name: "posix",
  listeners,
  processTable,
  cwdsOf,
  startTimesOf,
  spawnShell: (script, opts) => spawn("/bin/sh", ["-c", script], { cwd: opts.cwd, env: opts.env, detached: true, stdio: opts.stdio }),
  shellArgv: (command) => ["/bin/sh", "-c", command],
  groupAlive,
  signalGroups,
  stopGroups: (pgids) => terminate(() => pgids().some(groupAlive), (how) => signalGroups(pgids(), how)),
  stopPids: (pids) => {
    const alive = () => pids.filter(pidAlive);
    return terminate(() => alive().length > 0, (how) => signalPids(alive(), how));
  },
  loginShellEnv,
  defaultHome: () => path.join(os.homedir(), ".servedev"),
  pickFolder,
  openUrl: (url) => void Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" }),
  autostartStatus,
  installAutostart,
  uninstallAutostart,
};
