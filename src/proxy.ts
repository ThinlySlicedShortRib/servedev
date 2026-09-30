/**
 * Hostname proxy: http://keel.localhost -> the server's real port. Handles plain HTTP, streaming
 * responses and WebSockets (hot reload), and keeps the original Host header so apps see the URL
 * the browser uses.
 *
 * Normal users can bind port 80 on macOS only on the wildcard address, so the proxy listens on
 * all interfaces and rejects every request that doesn't come from this machine.
 */
import type { Server as BunServer, ServerWebSocket } from "bun";

export type Route =
  | { status: "ok"; port: number; serverId: string }
  | { status: "stopped"; serverId: string; hostname: string }
  | { status: "unknown"; hostnames: string[] };

interface WsData {
  target: string;
  headers: Record<string, string>;
  protocols: string[];
  upstream?: WebSocket;
  queue: (string | ArrayBuffer | Uint8Array)[];
}

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
export const FALLBACK_PORT = 7780;

export function isLoopback(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
}

export function hostOf(hostHeader: string): string {
  return hostHeader.replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
}

function page(status: number, title: string, body: string): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<body style="font:15px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${esc(title)}</h1>${body}` +
      `<p style="color:#777">servedev hostname proxy. Manage servers at <a href="http://127.0.0.1:7777">127.0.0.1:7777</a>.</p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export class HostProxy {
  server?: BunServer<WsData>;
  port?: number;
  error?: string;
  /** Which loopback address answered for a port; servers listen on 127.0.0.1, ::1, or both. */
  private addr = new Map<number, string>();

  constructor(private route: (host: string) => Route) {}

  get running() {
    return !!this.server;
  }

  /** Listen on `preferred`, or the fallback port if that's taken. */
  start(preferred: number) {
    if (this.server) return;
    const errors: string[] = [];
    for (const port of [...new Set([preferred, FALLBACK_PORT])]) {
      try {
        this.server = Bun.serve<WsData>({
          port,
          idleTimeout: 0,
          fetch: (req, srv) => this.fetch(req, srv),
          websocket: {
            open: (ws) => this.wsOpen(ws),
            message: (ws, msg) => {
              const up = ws.data.upstream;
              if (up?.readyState === WebSocket.OPEN) up.send(msg);
              else ws.data.queue.push(msg);
            },
            close: (ws) => ws.data.upstream?.close(),
          },
        });
        this.port = this.server.port;
        this.error = errors.length ? errors.join("; ") : undefined;
        return;
      } catch (e) {
        errors.push(`port ${port}: ${(e as Error).message}`);
      }
    }
    this.error = errors.join("; ");
  }

  stop() {
    this.server?.stop(true);
    this.server = undefined;
    this.port = undefined;
  }

  /** e.g. http://keel.localhost, or http://keel.localhost:7780 when not on port 80. */
  urlFor(hostname: string): string | undefined {
    if (!this.port) return undefined;
    return `http://${hostname}${this.port === 80 ? "" : `:${this.port}`}`;
  }

  private async fetch(req: Request, srv: BunServer<WsData>): Promise<Response | undefined> {
    const ip = srv.requestIP(req)?.address ?? "";
    if (!isLoopback(ip)) return new Response("servedev only serves requests from this machine\n", { status: 403 });

    const hostHeader = req.headers.get("host") ?? "";
    const host = hostOf(hostHeader);
    const r = this.route(host);
    if (r.status === "unknown") {
      const list = r.hostnames.map((h) => `<li><a href="${this.urlFor(h)}">${h}</a></li>`).join("");
      return page(404, `No dev server is called ${host || "(no host)"}`, list ? `<p>Known hostnames:</p><ul>${list}</ul>` : "<p>No servers have a hostname yet.</p>");
    }
    if (r.status === "stopped") {
      return page(502, `${r.hostname} is not running`, `<p>It belongs to <code>${r.serverId}</code>. Start it from the dashboard or with <code>servedev start</code>.</p>`);
    }

    const url = new URL(req.url);
    const path = url.pathname + url.search;

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      const headers: Record<string, string> = { host: hostHeader };
      const origin = req.headers.get("origin");
      if (origin) headers.origin = origin;
      const base = await this.base(r.port);
      const ok = srv.upgrade(req, {
        data: { target: `ws://${base}${path}`, headers, protocols, queue: [] },
        headers: protocols.length ? { "Sec-WebSocket-Protocol": protocols[0] } : undefined,
      });
      return ok ? undefined : new Response("WebSocket upgrade failed\n", { status: 400 });
    }

    const headers = new Headers(req.headers);
    for (const h of HOP_BY_HOP) headers.delete(h);
    headers.set("x-forwarded-host", hostHeader);
    headers.set("x-forwarded-proto", "http");
    headers.set("x-forwarded-for", ip);
    const init = { method: req.method, headers, body: req.body, redirect: "manual", decompress: false, duplex: "half" } as RequestInit;
    try {
      let res: Response;
      try {
        res = await fetch(`http://${await this.base(r.port)}${path}`, init);
      } catch (e) {
        // The server may listen on the other loopback address; retry once there.
        this.addr.delete(r.port);
        if (req.body) throw e;
        res = await fetch(`http://${await this.base(r.port)}${path}`, init);
      }
      const out = new Headers(res.headers);
      for (const h of HOP_BY_HOP) out.delete(h);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    } catch (e) {
      return page(502, `${host} isn't answering`, `<p>servedev couldn't reach port ${r.port}: ${(e as Error).message}</p>`);
    }
  }

  /** host:port that accepts connections for a local port, trying IPv4 then IPv6 loopback. */
  private async base(port: number): Promise<string> {
    const known = this.addr.get(port);
    if (known) return known;
    for (const candidate of [`127.0.0.1:${port}`, `[::1]:${port}`]) {
      const ok = await new Promise<boolean>((resolve) => {
        const [h, p] = candidate.startsWith("[") ? ["::1", port] : ["127.0.0.1", port];
        Bun.connect({
          hostname: h,
          port: p,
          socket: { open: (s) => (s.end(), resolve(true)), error: () => resolve(false), data() {}, close() {}, connectError: () => resolve(false) },
        }).catch(() => resolve(false));
      });
      if (ok) {
        this.addr.set(port, candidate);
        return candidate;
      }
    }
    return `127.0.0.1:${port}`;
  }

  private wsOpen(ws: ServerWebSocket<WsData>) {
    const d = ws.data;
    const up = new WebSocket(d.target, { headers: d.headers, protocols: d.protocols } as unknown as string[]);
    up.binaryType = "arraybuffer";
    up.onopen = () => {
      for (const m of d.queue) up.send(m);
      d.queue = [];
    };
    up.onmessage = (e) => ws.send(e.data as string | ArrayBuffer);
    up.onclose = () => ws.close();
    up.onerror = () => ws.close();
    d.upstream = up;
  }
}
