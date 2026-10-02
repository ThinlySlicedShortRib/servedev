/**
 * Which local ports forward to a machine's server ports. A forward keeps the remote port number
 * when it's free here (so URLs and HMR ports that apps print still work), else takes another.
 */
import net from "node:net";
import { canBind } from "../ports";

export interface Forward {
  remotePort: number;
  localPort: number;
}

/**
 * Loopback addresses a forward can target on the remote, in the order tried. Servers bind one or
 * the other (vite on macOS: ::1; python: 127.0.0.1), and WSL's relay to Windows serves each only
 * on the matching Windows address, so a forward that goes nowhere is retried on the other.
 */
export const TARGETS = ["127.0.0.1", "::1"] as const;
export type Target = (typeof TARGETS)[number];

/** Ports a machine's servers listen on that should be reachable from here. */
export function wantedPorts(servers: { status: string; ports: number[] }[], maxPerServer = 8): number[] {
  const out = new Set<number>();
  for (const s of servers) {
    if (s.status !== "running" && s.status !== "starting") continue;
    for (const p of s.ports.slice(0, maxPerServer)) out.add(p);
  }
  return [...out].sort((a, b) => a - b);
}

/** Forwards to add and to cancel to get from `current` to `wanted` remote ports. */
export function diffForwards(current: Forward[], wanted: number[]): { add: number[]; cancel: Forward[] } {
  const have = new Set(current.map((f) => f.remotePort));
  const want = new Set(wanted);
  return { add: wanted.filter((p) => !have.has(p)), cancel: current.filter((f) => !want.has(f.remotePort)) };
}

export interface PortProbe {
  isFree(port: number): Promise<boolean>;
  /** A port the OS says is free right now. */
  ephemeral(): Promise<number>;
  /**
   * Whether a forward leads somewhere. ssh accepts the local connection first and closes it when
   * the remote end can't connect, so a connection still open after `waitMs` is live. (Windows
   * takes about 2s to give up on a loopback port nothing listens on.)
   */
  reaches(localPort: number, waitMs: number): Promise<boolean>;
}

export const systemPorts: PortProbe = {
  isFree: (port) => canBind(port),
  ephemeral: () =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      });
    }),
  reaches: (port, waitMs) =>
    new Promise((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port });
      const done = (ok: boolean) => {
        clearTimeout(timer);
        sock.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => done(true), waitMs);
      // Data before our request (a greeting) also means it's live.
      sock.once("data", () => done(true));
      sock.once("close", () => done(false));
      sock.once("error", () => done(false));
    }),
};

/** The remote port's number if nothing here uses it (and no other forward claimed it), else a free one. */
export async function chooseLocalPort(remotePort: number, reserved: Set<number>, probe: PortProbe = systemPorts): Promise<number> {
  if (remotePort >= 1024 && !reserved.has(remotePort) && (await probe.isFree(remotePort))) return remotePort;
  for (let i = 0; i < 20; i++) {
    const p = await probe.ephemeral();
    if (!reserved.has(p)) return p;
  }
  throw new Error(`no free local port to forward ${remotePort} to`);
}
