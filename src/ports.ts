import net from "node:net";

export interface Listener {
  pid: number;
  pgid: number;
  command: string;
  port: number;
}

/** All TCP ports in LISTEN state owned by the current user, via lsof. */
export async function listeners(): Promise<Listener[]> {
  const proc = Bun.spawn(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pgcn"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return parseLsof(out);
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

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/** Every process on the machine, from ps. */
export async function processTable(): Promise<Proc[]> {
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
