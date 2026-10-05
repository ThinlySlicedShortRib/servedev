/**
 * A remote servedev's HTTP API, reached through a forwarded port. Its daemon only accepts its own
 * Host (127.0.0.1:<its port>), so requests carry that Host instead of the forward's; its check
 * stays as strict as it is for everyone else.
 */

export class RemoteApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Its servedev doesn't have this endpoint (it's older than the hub's). */
    public missingEndpoint = false,
  ) {
    super(message);
  }
}

/** Header naming the hub, so the machine knows which hubs are connected to it. */
export const HUB_HEADER = "x-servedev-hub";

/** A servedev's answer to an endpoint it doesn't have: "not found: POST /api/command". */
export function isNotFound(status: number, message: string): boolean {
  return status === 404 && /^not found: (GET|POST) \/api\//.test(message);
}

export interface RemoteApiOptions {
  /** The machine's name, for errors. */
  machine?: string;
  /** Its servedev version as last seen, for errors. */
  version?: () => string | undefined;
  /** This hub's name, sent with every request. */
  hub?: string;
}

export class RemoteApi {
  constructor(
    /** Local end of the forward. */
    readonly localPort: number,
    /** The remote daemon's port, for its Host check. */
    readonly remotePort: number,
    readonly token: string,
    readonly opts: RemoteApiOptions = {},
  ) {}

  private headers(json: boolean): Record<string, string> {
    return {
      host: `127.0.0.1:${this.remotePort}`,
      "x-servedev-token": this.token,
      ...(this.opts.hub ? { [HUB_HEADER]: this.opts.hub } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.localPort}${path}`;
  }

  async health(timeoutMs = 5000): Promise<{ version: string; pid: number } | undefined> {
    try {
      const res = await fetch(this.url("/api/health"), { headers: this.headers(false), signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? ((await res.json()) as { version: string; pid: number }) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * An error from the remote. One for an endpoint it doesn't have says its servedev is older and
   * how to update it, instead of a bare "not found".
   */
  private error(status: number, message: string): RemoteApiError {
    if (!isNotFound(status, message)) return new RemoteApiError(status, message);
    const what = message.replace(/^not found: /, "");
    const m = this.opts.machine;
    const version = this.opts.version?.();
    const text = m
      ? `${m} runs an older servedev${version ? ` (${version})` : ""} that can't do this yet (${what}); update it: servedev remote update ${m}`
      : `the other machine runs an older servedev that can't do this yet (${what}); update it`;
    return new RemoteApiError(501, text, true);
  }

  /** JSON request; the remote's errors come back with its status and message. */
  async call<T = any>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new RemoteApiError(502, (e as Error).message);
    }
    const data = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as any;
    if (!res.ok) throw this.error(res.status, data?.error ?? `HTTP ${res.status}`);
    return data as T;
  }

  /** An event stream (SSE), open until `signal` aborts or the remote ends it. */
  async stream(path: string, signal: AbortSignal): Promise<Response> {
    const res = await fetch(this.url(path), { headers: this.headers(false), signal });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as any;
      throw this.error(res.status, data?.error ?? `HTTP ${res.status}`);
    }
    return res;
  }
}
