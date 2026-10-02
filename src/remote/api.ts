/**
 * A remote servedev's HTTP API, reached through a forwarded port. Its daemon only accepts its own
 * Host (127.0.0.1:<its port>), so requests carry that Host instead of the forward's; its check
 * stays as strict as it is for everyone else.
 */

export class RemoteApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class RemoteApi {
  constructor(
    /** Local end of the forward. */
    readonly localPort: number,
    /** The remote daemon's port, for its Host check. */
    readonly remotePort: number,
    readonly token: string,
  ) {}

  private headers(json: boolean): Record<string, string> {
    return { host: `127.0.0.1:${this.remotePort}`, "x-servedev-token": this.token, ...(json ? { "content-type": "application/json" } : {}) };
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
    if (!res.ok) throw new RemoteApiError(res.status, data?.error ?? `HTTP ${res.status}`);
    return data as T;
  }

  /** An event stream (SSE), open until `signal` aborts or the remote ends it. */
  async stream(path: string, signal: AbortSignal): Promise<Response> {
    const res = await fetch(this.url(path), { headers: this.headers(false), signal });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as any;
      throw new RemoteApiError(res.status, data?.error ?? `HTTP ${res.status}`);
    }
    return res;
  }
}
