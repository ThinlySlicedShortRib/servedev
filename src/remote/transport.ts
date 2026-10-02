/**
 * Reaching another machine: one SSH connection (a ControlMaster) per machine, commands run over
 * it, and port forwards added and removed on it while it's up.
 *
 * Two kinds of remote shell:
 *   posix  macOS or Linux: commands run in the user's login shell.
 *   wsl    Windows whose servers run in WSL: SSH lands in cmd.exe, so every command goes through
 *          wsl.exe into a bash login shell (PATH with ~/.local/bin). Forwards target 127.0.0.1,
 *          never localhost: Windows resolves localhost to ::1, which WSL's port relay doesn't serve.
 */
import fs from "node:fs";
import { bunSpawner, type LongProc, type RunResult, type Spawner } from "./process";

export type ShellKind = "posix" | "wsl";

export interface Transport {
  readonly kind: ShellKind;
  /** Run a shell script on the remote (bash/sh syntax on both kinds). */
  run(script: string, opts?: { timeoutMs?: number }): Promise<RunResult>;
  /** A remote command that runs until we kill it or the connection drops. */
  hold(script: string): LongProc;
  forward(localPort: number, remotePort: number, target?: string): Promise<void>;
  cancel(localPort: number, remotePort: number, target?: string): Promise<void>;
  /** Whether the SSH connection is still up. */
  alive(): Promise<boolean>;
  close(): void;
}

/** Quote for a POSIX shell: 'it'\''s'. */
export function posixQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command line SSH sends for a script. For WSL it passes through cmd.exe and wsl.exe's own
 * argument parsing, neither of which has a reliable escape for quotes, so the script travels as
 * base64 (only [A-Za-z0-9+/=], which no layer touches) inside one double-quoted argument.
 */
export function wrapScript(kind: ShellKind, script: string, distro?: string): string {
  if (kind === "posix") return `exec "$SHELL" -lc ${posixQuote(script)}`;
  if (distro !== undefined && !/^[\w.-]+$/.test(distro)) throw new Error(`invalid WSL distro name "${distro}"`);
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return `wsl.exe ${distro ? `-d ${distro} ` : ""}-e bash -lc "source <(echo ${b64}|base64 -d)"`;
}

/** -L spec: always 127.0.0.1 here; there, an explicit loopback address (never "localhost"). */
export function forwardSpec(localPort: number, remotePort: number, target = "127.0.0.1"): string {
  return `127.0.0.1:${localPort}:${target.includes(":") ? `[${target}]` : target}:${remotePort}`;
}

export interface SshOptions {
  /** ssh destination: user@host, or a Host from ~/.ssh/config. */
  target: string;
  /** ControlMaster socket path. */
  socket: string;
  spawner?: Spawner;
}

/** Common options: never prompt (no one is there to answer), stay quiet unless something fails. */
const QUIET = ["-o", "BatchMode=yes", "-o", "LogLevel=ERROR"];

export function masterArgs(o: { target: string; socket: string }): string[] {
  return [
    "ssh",
    "-M",
    "-S",
    o.socket,
    "-N",
    ...QUIET,
    "-o",
    "ControlPersist=no",
    "-o",
    "ConnectTimeout=10",
    // Dead links are noticed within ~45s even when nothing is being sent.
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ExitOnForwardFailure=yes",
    o.target,
  ];
}

export function execArgs(o: { target: string; socket: string }, command: string): string[] {
  return ["ssh", "-S", o.socket, "-o", "ControlMaster=no", ...QUIET, o.target, command];
}

export function controlArgs(o: { target: string; socket: string }, op: "check" | "exit" | "forward" | "cancel", spec?: string): string[] {
  return ["ssh", "-S", o.socket, ...QUIET, "-O", op, ...(spec ? ["-L", spec] : []), o.target];
}

/** Why ssh failed, and what to do about it, from its stderr. */
export function explainSshError(stderr: string, target: string): { message: string; hint?: string } {
  const text = stderr.trim().split("\n").filter(Boolean).pop() ?? "ssh exited";
  const host = target.replace(/^ssh:\/\//, "").replace(/^.*@/, "").replace(/:\d+$/, "");
  if (/permission denied/i.test(stderr)) {
    return {
      message: text,
      hint:
        `ssh ${target} needs a key it can use without a prompt. Add your public key on that machine ` +
        `(Windows admin accounts: C:\\ProgramData\\ssh\\administrators_authorized_keys; otherwise ~/.ssh/authorized_keys), then check with: ssh -o BatchMode=yes ${target} echo ok`,
    };
  }
  if (/host key verification failed/i.test(stderr)) return { message: text, hint: `connect once by hand to accept its host key: ssh ${target}` };
  if (/could not resolve|name or service not known|nodename nor servname/i.test(stderr)) return { message: text, hint: `${host} doesn't resolve; check the address (Tailscale: tailscale status)` };
  if (/timed out|no route to host|network is unreachable|connection refused/i.test(stderr)) {
    return { message: text, hint: `is ${host} on, awake and reachable (Tailscale running on both), with an SSH server listening?` };
  }
  return { message: text };
}

/** The SSH connection itself: master process, commands over it, forwards on it. */
export class SshLink {
  readonly target: string;
  readonly socket: string;
  private spawner: Spawner;
  private master?: LongProc;

  constructor(o: SshOptions) {
    this.target = o.target;
    this.socket = o.socket;
    this.spawner = o.spawner ?? bunSpawner;
  }

  /** Start the master and wait until it accepts commands. Rejects with ssh's error. */
  async open(timeoutMs = 20_000): Promise<void> {
    // A master left behind by a daemon that crashed would hold its forwards' ports; end it. A dead
    // socket file would make ssh skip multiplexing silently, so it goes too.
    if (fs.existsSync(this.socket)) await this.spawner.run(controlArgs(this, "exit"), { timeoutMs: 5000 }).catch(() => {});
    fs.rmSync(this.socket, { force: true });
    const master = this.spawner.spawn(masterArgs(this));
    this.master = master;
    let exited: number | undefined;
    void master.exited.then((c) => (exited = c));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await Bun.sleep(150);
      if (exited !== undefined) throw new SshError(explainSshError(master.stderr() || `ssh exited with code ${exited}`, this.target));
      if (await this.alive()) return;
    }
    master.kill();
    throw new SshError(explainSshError(`connecting to ${this.target} timed out`, this.target));
  }

  /** Resolves when the master goes away (network drop, remote reboot, killed). */
  get closed(): Promise<number> {
    return this.master?.exited ?? Promise.resolve(0);
  }

  masterError(): string {
    return this.master?.stderr().trim() ?? "";
  }

  exec(command: string, opts?: { timeoutMs?: number }): Promise<RunResult> {
    return this.spawner.run(execArgs(this, command), { timeoutMs: opts?.timeoutMs ?? 60_000 });
  }

  spawn(command: string): LongProc {
    return this.spawner.spawn(execArgs(this, command));
  }

  async alive(): Promise<boolean> {
    if (!this.master) return false;
    return (await this.spawner.run(controlArgs(this, "check"), { timeoutMs: 5000 })).code === 0;
  }

  async forward(localPort: number, remotePort: number, target?: string) {
    const r = await this.spawner.run(controlArgs(this, "forward", forwardSpec(localPort, remotePort, target)), { timeoutMs: 10_000 });
    if (r.code !== 0) throw new Error(`forwarding port ${localPort} to ${remotePort} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  async cancel(localPort: number, remotePort: number, target?: string) {
    await this.spawner.run(controlArgs(this, "cancel", forwardSpec(localPort, remotePort, target)), { timeoutMs: 10_000 });
  }

  /** Ends the master, and with it every forward and session on it. Synchronous, so it works on exit. */
  close() {
    if (!this.master) return;
    this.master.kill();
    this.master = undefined;
    fs.rmSync(this.socket, { force: true });
  }
}

export class SshError extends Error {
  hint?: string;
  constructor(e: { message: string; hint?: string }) {
    super(e.message);
    this.hint = e.hint;
  }
}

export function createTransport(link: SshLink, kind: ShellKind, distro?: string): Transport {
  return {
    kind,
    run: (script, opts) => link.exec(wrapScript(kind, script, distro), opts),
    hold: (script) => link.spawn(wrapScript(kind, script, distro)),
    forward: (l, r, t) => link.forward(l, r, t),
    cancel: (l, r, t) => link.cancel(l, r, t),
    alive: () => link.alive(),
    close: () => link.close(),
  };
}

export interface Detected {
  kind: ShellKind;
  /** WSL distro (e.g. Ubuntu), so later commands go to the same one even if the default changes. */
  distro?: string;
  /** e.g. "Ubuntu 26.04 LTS (WSL on Windows)", "macOS (Darwin)". */
  os: string;
}

/** What `echo %OS%` prints: Windows_NT from cmd.exe; a POSIX shell echoes it back unchanged. */
export function isWindowsEcho(stdout: string): boolean {
  return stdout.trim() === "Windows_NT";
}

const PROBE = `printf '%s\\n' "$(uname -s)" "\${WSL_DISTRO_NAME:-}"; (. /etc/os-release 2>/dev/null && printf '%s\\n' "$PRETTY_NAME")`;

/** Parses PROBE's output: uname, WSL distro (may be empty), pretty OS name (Linux only). */
export function parseProbe(stdout: string): { uname: string; distro?: string; pretty?: string } {
  const [uname = "", distro = "", pretty = ""] = stdout.split("\n").map((l) => l.trim());
  return { uname, distro: distro || undefined, pretty: pretty || undefined };
}

/** Which shell a machine has, and for Windows, which WSL distro its servers run in. */
export async function detect(link: SshLink, distro?: string): Promise<Detected> {
  const echo = await link.exec("echo %OS%", { timeoutMs: 20_000 });
  if (echo.code !== 0 && !echo.stdout.trim()) throw new SshError(explainSshError(echo.stderr, link.target));
  if (isWindowsEcho(echo.stdout)) {
    const r = await link.exec(wrapScript("wsl", PROBE, distro), { timeoutMs: 60_000 });
    const p = parseProbe(r.stdout);
    if (r.code !== 0 || p.uname !== "Linux") {
      const why = (r.stderr || r.stdout).replace(/\0/g, "").trim();
      throw new SshError({
        message: `this is a Windows machine, but WSL didn't answer${why ? `: ${why.split("\n").pop()}` : ""}`,
        hint: "servedev runs inside WSL on Windows. Install it (wsl --install -d Ubuntu), then install servedev inside the distro.",
      });
    }
    return { kind: "wsl", distro: distro ?? p.distro, os: `${p.pretty ?? "Linux"} (WSL on Windows)` };
  }
  const r = await link.exec(wrapScript("posix", PROBE), { timeoutMs: 20_000 });
  const p = parseProbe(r.stdout);
  if (r.code !== 0 || !p.uname) throw new SshError({ message: `couldn't tell what system this is: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}` });
  return { kind: "posix", os: p.uname === "Darwin" ? "macOS" : (p.pretty ?? p.uname) };
}
