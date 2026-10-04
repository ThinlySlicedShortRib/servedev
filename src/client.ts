import { spawn } from "node:child_process";
import fs from "node:fs";
import { DAEMON_LOG, DAEMON_URL, VERSION, ensureHome, getToken } from "./paths";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** argv prefix that re-invokes this program, both for `bun src/cli.ts` and compiled binaries. */
export function selfCommand(): string[] {
  const script = process.argv[1];
  const compiled = !script || script.startsWith("/$bunfs") || script === process.execPath;
  return compiled ? [process.execPath] : [process.execPath, script];
}

async function health(): Promise<{ version: string; pid: number; dashboard?: string } | undefined> {
  try {
    const res = await fetch(`${DAEMON_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? ((await res.json()) as { version: string; pid: number; dashboard?: string }) : undefined;
  } catch {
    return undefined;
  }
}

export async function daemonStatus() {
  return health();
}

let ensured = false;

export async function ensureDaemon(): Promise<void> {
  if (ensured) return;
  const h = await health();
  if (h && h.version === VERSION) {
    ensured = true;
    return;
  }
  if (h) {
    // Upgraded binary: replace the old daemon. Its servers keep running and get adopted.
    await stopDaemon();
  }
  ensureHome();
  getToken();
  const [cmd, ...args] = selfCommand();
  const log = fs.openSync(DAEMON_LOG, "a");
  const child = spawn(cmd, [...args, "daemon", "run"], { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    if (await health()) {
      ensured = true;
      return;
    }
  }
  throw new Error(`servedev daemon failed to start; see ${DAEMON_LOG}`);
}

export async function stopDaemon(): Promise<boolean> {
  const h = await health();
  if (!h) return false;
  await fetch(`${DAEMON_URL}/api/shutdown`, { method: "POST", headers: { "x-servedev-token": getToken() } }).catch(() => {});
  for (let i = 0; i < 50 && (await health()); i++) await Bun.sleep(100);
  return true;
}

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  await ensureDaemon();
  const res = await fetch(`${DAEMON_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-servedev-token": getToken(), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as any;
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}
