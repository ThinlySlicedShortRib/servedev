/**
 * Everything servedev does that depends on the operating system it runs on: finding ports and
 * processes, starting and stopping servers, the login environment, where its files live, and
 * starting at login. `posix.ts` covers macOS and Linux (and WSL); `windows.ts` is native Windows.
 *
 * This is about the machine this process runs on. Commands built for *another* machine (src/remote)
 * depend on that machine's OS and don't go through here.
 */
import type { ChildProcess } from "node:child_process";

/** A process listening on a TCP port. */
export interface Listener {
  pid: number;
  /** Its process group (on Windows, whatever groups a server's processes; see Platform). */
  pgid: number;
  command: string;
  port: number;
}

/** A row of the process table. */
export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

export interface AutostartStatus {
  supported: boolean;
  installed: boolean;
  /** Where the login item lives (a LaunchAgent plist on macOS). */
  file: string;
}

/** What a login item needs to start this daemon the way it runs now. */
export interface AutostartContext {
  /** argv prefix that runs servedev (see selfCommand). */
  program: string[];
  /** SERVEDEV_HOME */
  home: string;
  /** SERVEDEV_PORT */
  port: number;
  /** Where the daemon's output goes. */
  log: string;
}

/** The OS couldn't do this at all (no picker installed, …), as opposed to it failing. */
export class Unsupported extends Error {}

export interface Platform {
  readonly name: "posix" | "windows";

  // ---------- ports and processes ----------

  /** All TCP ports in LISTEN state owned by the current user, with their owning process and group. */
  listeners(): Promise<Listener[]>;
  /** Every process on the machine. */
  processTable(): Promise<Proc[]>;
  /** Current working directories of these processes (missing when unknown). */
  cwdsOf(pids: number[]): Promise<Map<number, string>>;
  /** Start times (ms since the epoch) of these processes (missing when unknown). */
  startTimesOf(pids: number[]): Promise<Map<number, number>>;

  // ---------- starting and stopping ----------

  /**
   * Start a shell command in a group of its own (so it and everything it starts can be stopped
   * together; the group id is the child's pid), output to `stdio`. Like servers, setup steps and
   * stop commands.
   */
  spawnShell(script: string, opts: { cwd: string; env: Record<string, string>; stdio: ["ignore", number | "ignore", number | "ignore"] }): ChildProcess;
  /** argv that runs a one-off shell command and waits for it (account providers' commands). */
  shellArgv(command: string): string[];
  /** Any process of this group still exists. */
  groupAlive(pgid: number | undefined): boolean;
  /** Ask the groups' processes to exit ("graceful"), or end them now ("force"). Never throws. */
  signalGroups(pgids: number[], how: "graceful" | "force"): void;
  /**
   * Stop process groups: graceful first, forced if they're still there after a while. `pgids` is
   * read again on every check, so groups found while stopping are included.
   */
  stopGroups(pgids: () => number[]): Promise<void>;
  /** The same for single processes (an outside server's own tree, not its whole group, which may hold a shell). */
  stopPids(pids: number[]): Promise<void>;

  // ---------- environment and files ----------

  /**
   * What a new terminal would have: the user's login shell's environment, captured from a
   * near-empty one. Unfiltered; throws when it can't be read.
   */
  loginShellEnv(): Promise<Record<string, string>>;
  /** Default SERVEDEV_HOME. */
  defaultHome(): string;

  // ---------- desktop ----------

  /** Native folder picker. Resolves to null when cancelled; throws Unsupported when there's none. */
  pickFolder(start?: string): Promise<string | null>;
  /** Open a URL in the default browser (fire and forget). */
  openUrl(url: string): void;

  // ---------- login autostart ----------

  autostartStatus(): AutostartStatus;
  /** Install the login item. It takes effect at the next login. */
  installAutostart(ctx: AutostartContext): AutostartStatus;
  uninstallAutostart(): AutostartStatus;
}
