import net from "node:net";
import { platform, type Listener, type Proc } from "./platform";

export type { Listener, Proc };
// The posix parsers, where they've always been importable from.
export { parseLsof, parsePs, parseSs } from "./platform/posix";

/** All TCP ports in LISTEN state owned by the current user. */
export function listeners(): Promise<Listener[]> {
  return platform.listeners();
}

export function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

export async function findFreePort(exclude: Set<number>, start = 3000, end = 3999): Promise<number> {
  const taken = new Set((await listeners()).map((l) => l.port));
  for (let port = start; port <= end; port++) {
    if (exclude.has(port) || taken.has(port)) continue;
    if (await canBind(port)) return port;
  }
  throw new Error(`no free port between ${start} and ${end}`);
}

export function tcpOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "localhost" });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Every process on the machine. */
export function processTable(): Promise<Proc[]> {
  return platform.processTable();
}

/**
 * Process groups belonging to a server: the ones it already has, plus any group created by a
 * descendant of its first process. Tools like turbo start each task in a new group, so the
 * group servedev created doesn't cover everything.
 */
export function discoverGroups(rootPid: number, known: number[], table: Proc[]): number[] {
  const groups = new Set(known.length ? known : [rootPid]);
  const children = new Map<number, Proc[]>();
  for (const p of table) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid)!.push(p);
  }
  // Start from the root and from every live member of a known group (a middle process may have
  // exited, reparenting its children to launchd).
  const queue = table.filter((p) => p.pid === rootPid || groups.has(p.pgid)).map((p) => p.pid);
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of children.get(pid) ?? []) {
      groups.add(c.pgid);
      queue.push(c.pid);
    }
  }
  return [...groups];
}
