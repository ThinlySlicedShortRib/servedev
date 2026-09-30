import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { frameVerdict, normalizeHostname } from "../src/daemon";
import { HostProxy, hostOf, isLoopback, type Route } from "../src/proxy";

test("normalizeHostname accepts hostnames and URLs, rejects the rest", () => {
  expect(normalizeHostname("keel.localhost")).toBe("keel.localhost");
  expect(normalizeHostname(" http://Keel.Localhost:3000/login ")).toBe("keel.localhost");
  expect(normalizeHostname("api.keel.localhost.")).toBe("api.keel.localhost");
  for (const bad of ["localhost", "keel", "ke el.localhost", "-x.localhost", ""]) expect(() => normalizeHostname(bad)).toThrow();
});

test("hostOf and isLoopback", () => {
  expect(hostOf("Keel.localhost:80")).toBe("keel.localhost");
  expect(isLoopback("::1") && isLoopback("127.0.0.1") && isLoopback("::ffff:127.0.0.1")).toBe(true);
  expect(isLoopback("192.168.1.20")).toBe(false);
});

test("proxy forwards HTTP, keeps Host and gzip, streams, and relays WebSockets", async () => {
  const upstream = Bun.serve<{ proto: string | null }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")) {
        const proto = req.headers.get("sec-websocket-protocol");
        return srv.upgrade(req, { data: { proto }, headers: proto ? { "Sec-WebSocket-Protocol": proto } : undefined }) ? undefined : new Response("", { status: 400 });
      }
      if (url.pathname === "/gz") return new Response(gzipSync("zipped"), { headers: { "content-encoding": "gzip" } });
      if (url.pathname === "/redirect") return new Response(null, { status: 307, headers: { location: "/login" } });
      if (url.pathname === "/stream") {
        return new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(new TextEncoder().encode("a"));
              await Bun.sleep(50);
              c.enqueue(new TextEncoder().encode("b"));
              c.close();
            },
          }),
        );
      }
      return new Response(`${req.method} ${url.pathname}${url.search} host=${req.headers.get("host")} fwd=${req.headers.get("x-forwarded-host")}`);
    },
    websocket: {
      open: (ws) => void ws.send(`hello proto=${ws.data.proto}`),
      message: (ws, m) => void ws.send(`echo ${m}`),
    },
  });
  const routes: Record<string, Route> = {
    "web.localhost": { status: "ok", port: upstream.port!, serverId: "p:web" },
    "down.localhost": { status: "stopped", serverId: "p:down", hostname: "down.localhost" },
  };
  const proxy = new HostProxy((h) => routes[h] ?? { status: "unknown", hostnames: ["web.localhost"] });
  proxy.start(0);
  const base = `http://127.0.0.1:${proxy.port}`;
  const get = (path: string, host: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { host, ...(init.headers as object) }, redirect: "manual", decompress: false } as RequestInit);

  expect(await (await get("/a?b=1", "web.localhost:80")).text()).toBe("GET /a?b=1 host=web.localhost:80 fwd=web.localhost:80");
  expect(await (await get("/echo", "web.localhost", { method: "POST", body: "x" })).text()).toStartWith("POST /echo");
  const gz = await get("/gz", "web.localhost");
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe("zipped");
  const redirect = await get("/redirect", "web.localhost");
  expect([redirect.status, redirect.headers.get("location")]).toEqual([307, "/login"]);
  expect(await (await get("/stream", "web.localhost")).text()).toBe("ab");
  expect((await get("/", "nope.localhost")).status).toBe(404);
  expect((await get("/", "down.localhost")).status).toBe(502);

  const messages: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/hmr`, { headers: { host: "web.localhost" }, protocols: ["vite-hmr"] } as unknown as string[]);
  await new Promise<void>((resolve, reject) => {
    ws.onmessage = (e) => {
      messages.push(String(e.data));
      if (messages.length === 1) ws.send("ping");
      else resolve();
    };
    ws.onerror = () => reject(new Error("websocket error"));
    setTimeout(() => reject(new Error("websocket timeout")), 3000);
  });
  expect(messages).toEqual(["hello proto=vite-hmr", "echo ping"]);
  expect(ws.protocol).toBe("vite-hmr");
  ws.close();
  proxy.stop();
  upstream.stop(true);
});

test("frameVerdict reads X-Frame-Options and CSP frame-ancestors", () => {
  const dash = "http://127.0.0.1:7777";
  const v = (h: Record<string, string>) => frameVerdict(new Headers(h), dash);
  expect(v({})).toEqual({ frameable: true });
  expect(v({ "x-frame-options": "DENY" })).toEqual({ frameable: false, reason: "X-Frame-Options: DENY" });
  expect(v({ "x-frame-options": "sameorigin" }).frameable).toBe(false);
  expect(v({ "content-security-policy": "default-src 'self'; frame-ancestors 'self'" }).frameable).toBe(false);
  expect(v({ "content-security-policy": "frame-ancestors *" }).frameable).toBe(true);
  expect(v({ "content-security-policy": "frame-ancestors http://127.0.0.1:7777" }).frameable).toBe(true);
  expect(v({ "content-security-policy": "script-src 'self'" }).frameable).toBe(true);
});
