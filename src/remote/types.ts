import type { PublicServer } from "../manager";
import type { Forward } from "./forwards";
import type { ConnState } from "./state";
import type { ShellKind } from "./transport";

/** A machine in config.json's "machines". Everything but `ssh` is detected and cached by `remote add`. */
export interface MachineConfig {
  /** ssh destination: user@host or a Host alias from ~/.ssh/config. */
  ssh: string;
  /** posix (macOS/Linux) or wsl (Windows, servers in WSL). */
  kind?: ShellKind;
  /** WSL distro the servers run in. */
  distro?: string;
}

export type StepId = "ssh" | "os" | "servedev" | "token" | "api";

/** One line of the "Add machine" checklist. */
export interface SetupStep {
  id: StepId;
  label: string;
  status: "ok" | "warning" | "failed" | "skipped";
  detail?: string;
  /** What to do about a failure or warning. */
  hint?: string;
}

/** A server on another machine, as the hub shows it. */
export type RemoteServerView = PublicServer & {
  machine: string;
  /** Its id on that machine (without the "pc/" prefix). */
  remoteId: string;
  machineState: ConnState;
  /** The machine isn't connected: this is the last known state. */
  stale?: boolean;
  /** Its URL on that machine; `url` is the forwarded one here. */
  remoteUrl?: string;
  /** Hub hostname, e.g. api.pc.localhost; `customUrl` is its URL through the hub's proxy. */
  localHostname?: string;
  /** Its listening ports forwarded here. */
  forwards: Forward[];
};

export interface MachineSummary {
  name: string;
  ssh: string;
  kind?: ShellKind;
  distro?: string;
  /** e.g. "Ubuntu 26.04 LTS (WSL on Windows)". */
  os?: string;
  state: ConnState;
  /** Failed attempts since it was last up (reconnecting/offline). */
  attempt: number;
  nextRetryAt?: number;
  lastError?: string;
  hint?: string;
  connectedAt?: number;
  lastSeen?: number;
  /** servedev version on the machine, and here. */
  version?: string;
  hubVersion: string;
  versionMismatch: boolean;
  /** Other hubs connected to it too (they forward its ports as well); empty when its servedev doesn't say. */
  otherHubs: string[];
  /** The remote daemon's port there, and the local end of its tunnel here. */
  remotePort?: number;
  apiPort?: number;
  counts: { total: number; running: number; crashed: number };
  /** `outside`: commands of dev servers there that its servedev didn't start, on this port. */
  forwards: (Forward & { target: string; serverIds: string[]; outside: string[] })[];
  /** The last connection attempt's checklist. */
  steps?: SetupStep[];
}
