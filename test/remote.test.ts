import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigStore, resolveConfig, resolveMachines } from "../src/config";
import type { PublicServer } from "../src/manager";
import { chooseLocalPort, diffForwards, wantedPorts, type PortProbe } from "../src/remote/forwards";
import { RemoteHub, localUrl } from "../src/remote/hub";
import { assertMachineName, hostAliases, resolveRemoteRef, splitRef } from "../src/remote/ids";
import { Machine } from "../src/remote/machine";
import type { LongProc, RunResult, Spawner } from "../src/remote/process";
import { fileStore, type SecretStore } from "../src/remote/secrets";
import { Checklist, parseServedevProbe } from "../src/remote/setup";
import { parseSse } from "../src/remote/sse";
import { RECONNECT_ATTEMPTS, backoff, failed, initial, retryNow, succeeded } from "../src/remote/state";
import { SshLink, controlArgs, detect, explainSshError, forwardSpec, isWindowsEcho, masterArgs, parseProbe, posixQuote, wrapScript } from "../src/remote/transport";
import { bootTaskPowerShell, encodedPowerShell } from "../src/remote/boot";
import localSchema from "../schema/config.schema.json";

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sd-remote-"));
  dirs.push(d);
  return d;
}

/** The script inside a WSL command line, decoded. */
function decodeWsl(command: string): string {
  const b64 = /echo ([A-Za-z0-9+/=]+)\|base64 -d/.exec(command)?.[1];
  if (!b64) throw new Error(`not a wrapped WSL command: ${command}`);
  return Buffer.from(b64, "base64").toString("utf8");
}

// ---------- transport: command building ----------

test("posix scripts run in the user's login shell, quoted", () => {
  expect(posixQuote("servedev")).toBe("servedev");
  expect(posixQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
  expect(wrapScript("posix", "echo 'a b'; ls | wc -l")).toBe(`exec "$SHELL" -lc 'echo '\\''a b'\\''; ls | wc -l'`);
});

test("WSL scripts survive cmd.exe and wsl.exe: base64 inside one quoted argument, bash login shell", () => {
  const script = `echo "100% & done" | grep -q '^1' && cat <<'EOF' > ~/x\n^%PATH%! "q" \\ \nEOF`;
  const cmd = wrapScript("wsl", script);
  expect(cmd.startsWith(`wsl.exe -e bash -lc "source <(echo `)).toBe(true);
  expect(decodeWsl(cmd)).toBe(script);
  // Exactly two double quotes, around the argument, and nothing cmd.exe treats specially outside them.
  expect(cmd.match(/"/g)?.length).toBe(2);
  const outside = cmd.replace(/"[^"]*"/, "");
  expect(outside).not.toMatch(/[&|<>^%!()]/);
  // Inside the quotes: only base64 and the fixed wrapper (no % for cmd to expand).
  expect(cmd.slice(cmd.indexOf('"'))).not.toContain("%");
  expect(wrapScript("wsl", "true", "Ubuntu-24.04")).toStartWith("wsl.exe -d Ubuntu-24.04 -e bash -lc ");
  expect(() => wrapScript("wsl", "true", "Ubuntu; rm -rf /")).toThrow(/distro/);
});

test("ssh argv: one master per machine with keepalives; forwards to explicit loopback addresses", () => {
  const o = { target: "me@100.64.0.2", socket: "/h/machines/pc.sock" };
  const m = masterArgs(o);
  expect(m.slice(0, 5)).toEqual(["ssh", "-M", "-S", o.socket, "-N"]);
  for (const opt of ["BatchMode=yes", "ServerAliveInterval=15", "ExitOnForwardFailure=yes", "ControlPersist=no"]) expect(m).toContain(opt);
  expect(m.at(-1)).toBe(o.target);
  expect(forwardSpec(41000, 3000)).toBe("127.0.0.1:41000:127.0.0.1:3000");
  expect(forwardSpec(41000, 8081, "::1")).toBe("127.0.0.1:41000:[::1]:8081");
  expect(controlArgs(o, "forward", forwardSpec(1, 2))).toEqual(["ssh", "-S", o.socket, "-o", "BatchMode=yes", "-o", "LogLevel=ERROR", "-O", "forward", "-L", "127.0.0.1:1:127.0.0.1:2", o.target]);
});

test("ssh failures come with a fix", () => {
  expect(explainSshError("ariel@1.2.3.4: Permission denied (publickey).", "ariel@1.2.3.4").hint).toContain("authorized_keys");
  expect(explainSshError("ssh: connect to host 1.2.3.4 port 22: Connection timed out", "ssh://a@1.2.3.4:2").hint).toContain("is 1.2.3.4 on");
  expect(explainSshError("Host key verification failed.", "pc").hint).toContain("ssh pc");
  expect(explainSshError("ssh: Could not resolve hostname 1.2.3.4:22: Name or service not known", "a@1.2.3.4:22").hint).toContain("ssh://a@1.2.3.4:22");
  expect(explainSshError("weird", "pc").hint).toBeUndefined();
});

test("OS detection output", () => {
  expect(isWindowsEcho("Windows_NT\r\n")).toBe(true);
  expect(isWindowsEcho("%OS%\n")).toBe(false);
  expect(parseProbe("Linux\nUbuntu\nUbuntu 26.04 LTS\n")).toEqual({ uname: "Linux", distro: "Ubuntu", pretty: "Ubuntu 26.04 LTS" });
  expect(parseProbe("Darwin\n\n")).toEqual({ uname: "Darwin", distro: undefined, pretty: undefined });
});

// ---------- a fake remote: ssh and its servedev ----------

interface FakeOpts {
  windows?: boolean;
  servedev?: "missing" | "stopped" | "ok";
  token?: string;
  /** Port of the fake remote API; forwards "land" there. */
  apiPort?: number;
  denied?: boolean;
}

function fakeSsh(o: FakeOpts) {
  const calls: string[][] = [];
  let masterAlive = false;
  let killMaster = () => {};
  const forwards = new Set<string>();
  const long = (onKill?: () => void): LongProc & { end(): void } => {
    let resolve!: (c: number) => void;
    const exited = new Promise<number>((r) => (resolve = r));
    return { exited, stderr: () => "", kill: () => (onKill?.(), resolve(143)), end: () => resolve(0) };
  };
  const spawner: Spawner = {
    async run(argv): Promise<RunResult> {
      calls.push(argv);
      const op = argv.includes("-O") ? argv[argv.indexOf("-O") + 1] : undefined;
      if (op === "check") return { code: masterAlive ? 0 : 255, stdout: "", stderr: "" };
      if (op === "exit") return { code: masterAlive ? 0 : 255, stdout: "", stderr: "" };
      if (op === "forward") return forwards.add(argv[argv.indexOf("-L") + 1]), { code: 0, stdout: "", stderr: "" };
      if (op === "cancel") return forwards.delete(argv[argv.indexOf("-L") + 1]), { code: 0, stdout: "", stderr: "" };
      const command = argv.at(-1)!;
      if (command === "echo %OS%") return { code: 0, stdout: o.windows ? "Windows_NT\r\n" : "%OS%\n", stderr: "" };
      const script = command.startsWith("wsl.exe") ? decodeWsl(command) : command;
      if (script.includes("uname -s")) return { code: 0, stdout: o.windows ? "Linux\nUbuntu\nUbuntu 26.04 LTS\n" : "Darwin\n\n", stderr: "" };
      if (script.includes("@missing")) {
        if (o.servedev === "missing") return { code: 0, stdout: "@missing\n", stderr: "" };
        const status = o.servedev === "stopped" ? "daemon not running" : `daemon 0.2.0 running (pid 42) at http://127.0.0.1:7777; log: x`;
        return { code: 0, stdout: `welcome!\n@path /home/me/.local/bin/servedev\n@version 0.2.0\n@status ${status}\n@home /home/me/.servedev\n@token ${o.token ?? "tok"}\n`, stderr: "" };
      }
      return { code: 127, stdout: "", stderr: `unexpected: ${command}` };
    },
    spawn(argv) {
      calls.push(argv);
      if (argv.includes("-M")) {
        if (o.denied) {
          const p = long();
          p.end();
          return { ...p, stderr: () => "me@pc: Permission denied (publickey)." };
        }
        masterAlive = true;
        const p = long(() => (masterAlive = false));
        killMaster = () => {
          masterAlive = false;
          p.end();
        };
        return p;
      }
      return long();
    },
  };
  return { spawner, calls, forwards, killMaster: () => killMaster() };
}

/** A remote servedev API that insists on its own Host and token, like the real one. */
function fakeRemote(token = "tok", servers: Partial<PublicServer>[] = [{ id: "demo:api", name: "api", project: "demo", status: "running", ports: [3000], url: "http://localhost:3000" }]) {
  const hosts: string[] = [];
  const streams: ReadableStreamDefaultController[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(req) {
      hosts.push(req.headers.get("host") ?? "");
      if (req.headers.get("host") !== "127.0.0.1:7777") return new Response("forbidden host", { status: 403 });
      const p = new URL(req.url).pathname;
      if (p === "/api/health") return Response.json({ ok: true, version: "0.2.0", pid: 42 });
      if (req.headers.get("x-servedev-token") !== token) return Response.json({ error: "missing or invalid token" }, { status: 401 });
      if (p === "/api/servers") return Response.json({ servers });
      if (p === "/api/stream/events") {
        const stream = new ReadableStream({
          start(c) {
            streams.push(c);
            c.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({ servers })}\n\n`));
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  cleanups.push(() => srv.stop(true));
  const send = (event: string, data: unknown) => streams.forEach((c) => c.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)));
  return { port: srv.port!, hosts, send };
}

function memorySecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (m) => data.get(m), set: (m, t) => void data.set(m, t), delete: (m) => void data.delete(m) };
}

/** Ports: the API forward's "local port" is the fake remote (while it's free); other forwards get 50000+. */
function fakePorts(apiPort: number, reserved: Set<number>, opts: { busy?: number[] } = {}): PortProbe {
  let next = 50000;
  return {
    isFree: async (p) => !opts.busy?.includes(p),
    ephemeral: async () => (reserved.has(apiPort) ? next++ : apiPort),
    reaches: async () => true,
  };
}

function machine(name: string, o: FakeOpts & { secrets?: SecretStore; ports?: PortProbe } = {}) {
  const remote = fakeRemote(o.token ?? "tok");
  const ssh = fakeSsh({ servedev: "ok", ...o });
  const secrets = o.secrets ?? memorySecrets();
  const reserved = new Set<number>();
  const m = new Machine(name, { ssh: "me@pc" }, { dir: tmp(), secrets, hubVersion: "0.2.0", reserved, spawner: ssh.spawner, ports: o.ports ?? fakePorts(remote.port, reserved) });
  cleanups.push(() => m.dispose());
  return { m, ssh, remote, secrets };
}

test("connecting to a Windows PC: WSL detected, servedev found, token saved, API through the tunnel with its own Host", async () => {
  const { m, ssh, remote, secrets } = machine("pc", { windows: true });
  const steps = await m.connect();
  expect(steps.map((s) => [s.id, s.status])).toEqual([
    ["ssh", "ok"],
    ["os", "ok"],
    ["servedev", "ok"],
    ["token", "ok"],
    ["api", "ok"],
  ]);
  expect(m.status.state).toBe("connected");
  expect(m.config).toMatchObject({ kind: "wsl", distro: "Ubuntu" });
  expect(secrets.get("pc")).toBe("tok");
  expect(remote.hosts.every((h) => h === "127.0.0.1:7777")).toBe(true);
  expect([...m.servers.keys()]).toEqual(["demo:api"]);
  // Every command after detection went through wsl.exe; a session holds WSL up.
  const execs = ssh.calls.filter((a) => !a.includes("-O") && !a.includes("-M")).map((a) => a.at(-1)!);
  // (The detection probe itself goes to the default distro, before it's known.)
  expect(execs.slice(2).every((c) => c.startsWith("wsl.exe -d Ubuntu -e bash -lc"))).toBe(true);
  expect(execs.slice(1).some((c) => decodeWsl(c).includes("exec cat"))).toBe(true);
  // The running server's port gets forwarded, to the same number when it's free.
  await Bun.sleep(50);
  expect(ssh.forwards.has("127.0.0.1:3000:127.0.0.1:3000")).toBe(true);
  expect(m.forwards.get(3000)).toEqual({ localPort: 3000, target: "127.0.0.1" });
});

test("a different servedev version on the machine is reported, with both versions", async () => {
  const remote = fakeRemote();
  const ssh = fakeSsh({ servedev: "ok" });
  const reserved = new Set<number>();
  const m = new Machine("mac", { ssh: "me@mac" }, { dir: tmp(), secrets: memorySecrets(), hubVersion: "0.3.0", reserved, spawner: ssh.spawner, ports: fakePorts(remote.port, reserved) });
  cleanups.push(() => m.dispose());
  const steps = await m.connect();
  const step = steps.find((s) => s.id === "servedev")!;
  expect(step.status).toBe("warning");
  expect(step.detail).toBe("0.2.0 running on port 7777 (/home/me/.local/bin/servedev); this hub runs 0.3.0");
  expect(step.hint).toContain("versions differ");
  expect(m.status.state).toBe("connected");
});

test("missing servedev fails the checklist with a fix; nothing after it runs", async () => {
  const { m } = machine("pc", { windows: true, servedev: "missing" });
  const steps = await m.connect();
  expect(steps.map((s) => s.status)).toEqual(["ok", "ok", "failed", "skipped", "skipped"]);
  expect(steps[2].detail).toContain("isn't installed");
  expect(steps[2].hint).toContain("inside WSL");
  expect(m.status.state).toBe("offline");
});

test("ssh refused: the first step fails with ssh's reason and a hint", async () => {
  const { m } = machine("pc", { denied: true });
  const steps = await m.connect();
  expect(steps[0]).toMatchObject({ id: "ssh", status: "failed" });
  expect(steps[0].detail).toContain("Permission denied");
  expect(steps[0].hint).toContain("authorized_keys");
});

test("reconnecting with a saved token runs nothing on the machine; a changed token is read again", async () => {
  const secrets = memorySecrets();
  const { m, ssh } = machine("pc", { secrets, token: "new" });
  m.remotePort = 7777;
  secrets.set("pc", "new");
  let steps = await m.connect();
  expect(steps.find((s) => s.id === "token")?.detail).toBe("the saved token works");
  expect(ssh.calls.some((a) => a.at(-1)!.includes("@missing"))).toBe(false);

  // The machine's token changed: 401 with the saved one, so setup reads it again.
  const again = machine("pc2", { secrets, token: "fresh" });
  again.m.remotePort = 7777;
  secrets.set("pc2", "stale");
  steps = await again.m.connect();
  expect(steps.find((s) => s.id === "token")?.detail).toContain("changed");
  expect(secrets.get("pc2")).toBe("fresh");
  expect(again.m.status.state).toBe("connected");
});

test("live updates: server events from the machine update its servers; losing ssh starts reconnecting", async () => {
  const { m, ssh, remote } = machine("pc");
  await m.connect();
  await Bun.sleep(50);
  const seen: string[] = [];
  m.on("server", (id) => seen.push(id));
  remote.send("server", { id: "demo:web", name: "web", project: "demo", status: "starting", ports: [] });
  await Bun.sleep(50);
  expect(seen).toEqual(["demo:web"]);
  expect(m.servers.has("demo:web")).toBe(true);
  ssh.killMaster();
  await Bun.sleep(20);
  expect(m.status).toMatchObject({ state: "reconnecting", attempt: 1 });
  expect(m.status.lastError).toContain("SSH connection closed");
  // Last known servers stay.
  expect(m.servers.size).toBe(2);
  expect(() => m.liveApi()).toThrow(/reconnecting/);
});

test("forwards: a taken port gets another number; a server only on ::1 gets a forward there", async () => {
  const remote = fakeRemote("tok", [
    { id: "a:web", name: "web", project: "a", status: "running", ports: [3000] },
    { id: "a:v6", name: "v6", project: "a", status: "running", ports: [8081] },
  ]);
  const ssh = fakeSsh({ servedev: "ok" });
  const reserved = new Set<number>();
  const ports = fakePorts(remote.port, reserved, { busy: [3000] });
  const m = new Machine("pc", { ssh: "me@pc" }, { dir: tmp(), secrets: memorySecrets(), hubVersion: "0.2.0", reserved, spawner: ssh.spawner, ports });
  cleanups.push(() => m.dispose());
  // 8081 answers only through the [::1] forward (the second one opened for it).
  const opened: string[] = [];
  const run = ssh.spawner.run;
  ssh.spawner.run = async (argv) => {
    if (argv.includes("forward")) opened.push(argv[argv.indexOf("-L") + 1]);
    return run(argv);
  };
  ports.reaches = async (p) => {
    const spec = opened.find((s) => s.startsWith(`127.0.0.1:${p}:`)) ?? "";
    return !(spec.endsWith(":8081") && spec.includes(":127.0.0.1:"));
  };
  await m.connect();
  await Bun.sleep(50);
  expect(m.forwards.get(3000)?.localPort).not.toBe(3000);
  expect(m.forwards.get(3000)?.target).toBe("127.0.0.1");
  expect(m.forwards.get(8081)?.target).toBe("::1");
  // The other attempt for each port was cancelled.
  expect(ssh.forwards.size).toBe(3); // API + one per server
});

// ---------- ids and routing ----------

test("ids: the machine prefix routes a reference; names resolve when unique there", () => {
  expect(splitRef("pc/demo:api")).toEqual({ machine: "pc", ref: "demo:api" });
  expect(splitRef("pc/api")).toEqual({ machine: "pc", ref: "api" });
  expect(splitRef("demo:api")).toBeUndefined();
  expect(splitRef("api")).toBeUndefined();
  const servers = [
    { id: "demo:api", name: "api", project: "demo" },
    { id: "shop:api", name: "api", project: "shop" },
    { id: "demo:docs", name: "docs", project: "demo" },
  ];
  expect(resolveRemoteRef("pc", "demo:api", servers).id).toBe("demo:api");
  expect(resolveRemoteRef("pc", "docs", servers).id).toBe("demo:docs");
  expect(() => resolveRemoteRef("pc", "api", servers)).toThrow(/pc\/demo:api, pc\/shop:api/);
  expect(() => resolveRemoteRef("pc", "nope", servers)).toThrow(/no server "nope" on pc/);
  expect(() => assertMachineName("PC 1")).toThrow(/lowercase/);
  expect(() => assertMachineName("pc-2")).not.toThrow();
});

test("hub hostnames: <server>.<machine>.localhost, with the project when a name repeats", () => {
  const aliases = hostAliases("pc", [
    { id: "demo:api", name: "api", project: "demo" },
    { id: "shop:api", name: "api", project: "shop" },
    { id: "demo:My_Docs", name: "My_Docs", project: "demo" },
  ]);
  expect(aliases.get("demo:api")).toBe("api.demo.pc.localhost");
  expect(aliases.get("shop:api")).toBe("api.shop.pc.localhost");
  expect(aliases.get("demo:My_Docs")).toBe("my-docs.pc.localhost");
});

test("hub views: prefixed ids, the forwarded URL here, last-known when offline; responses rewritten", () => {
  const hub = new RemoteHub({ dir: tmp(), secrets: memorySecrets(), hubVersion: "0.2.0", urlFor: (h) => `http://${h}:7780`, spawner: fakeSsh({ denied: true }).spawner });
  cleanups.push(() => hub.dispose());
  hub.sync({ pc: { ssh: "me@pc" } });
  const m = hub.get("pc");
  const raw = { id: "demo:api", name: "api", project: "demo", status: "running", ports: [3000, 24678], url: "http://localhost:3000" } as PublicServer;
  m.servers.set(raw.id, raw);
  m.aliases = hostAliases("pc", [raw]);
  m.status = { state: "connected", attempt: 0 };
  m.forwards.set(3000, { localPort: 41000, target: "127.0.0.1" });
  const v = hub.view(m, raw);
  expect(v).toMatchObject({ id: "pc/demo:api", machine: "pc", remoteId: "demo:api", url: "http://127.0.0.1:41000", remoteUrl: "http://localhost:3000", customUrl: "http://api.pc.localhost:7780", forwards: [{ remotePort: 3000, localPort: 41000 }] });
  expect(v.stale).toBeUndefined();
  expect(hub.route("api.pc.localhost")).toEqual({ status: "ok", port: 41000, serverId: "pc/demo:api" });

  expect(hub.rewrite(m, { server: raw, removed: "demo:api", stopped: ["demo:api"], results: [{ id: "demo:api", ok: true }] })).toMatchObject({
    server: { id: "pc/demo:api" },
    removed: "pc/demo:api",
    stopped: ["pc/demo:api"],
    results: [{ id: "pc/demo:api" }],
  });
  const { local, remote } = hub.partition(["web", "pc/api", "pc/demo:api"]);
  expect(local).toEqual(["web"]);
  expect(remote.get(m)).toEqual(["demo:api", "demo:api"]);
  expect(() => hub.partition(["mac/api"])).toThrow(/no machine called "mac"/);

  m.status = { state: "offline", attempt: 6, lastSeen: Date.now() - 60_000 };
  const off = hub.view(m, raw);
  expect(off).toMatchObject({ stale: true, machineState: "offline", url: undefined, customUrl: undefined });
  expect(hub.route("api.pc.localhost")).toMatchObject({ status: "stopped", reason: expect.stringContaining("offline") });
  expect(() => hub.target("pc/api")).toThrow(/offline/);
});

test("localUrl points the remote URL at its forward", () => {
  expect(localUrl("http://localhost:3000", 3000, 41000)).toBe("http://127.0.0.1:41000");
  expect(localUrl("http://localhost:3000/app", 3000, 41000)).toBe("http://127.0.0.1:41000/app");
  expect(localUrl(undefined, 3000, 41000)).toBe("http://127.0.0.1:41000");
});

// ---------- forwards ----------

test("forwarding: active servers' ports, diffed against what's open", () => {
  const servers = [
    { status: "running", ports: [3000, 24678] },
    { status: "crashed", ports: [4000] },
    { status: "starting", ports: [3000, 5173] },
  ];
  expect(wantedPorts(servers)).toEqual([3000, 5173, 24678]);
  expect(diffForwards([{ remotePort: 3000, localPort: 3000 }, { remotePort: 4000, localPort: 4100 }], [3000, 5173])).toEqual({
    add: [5173],
    cancel: [{ remotePort: 4000, localPort: 4100 }],
  });
});

test("forwarding keeps the remote port number when it's free here", async () => {
  const probe = (busy: number[]): PortProbe => ({ isFree: async (p) => !busy.includes(p), ephemeral: async () => 49152, reaches: async () => true });
  expect(await chooseLocalPort(3000, new Set(), probe([]))).toBe(3000);
  expect(await chooseLocalPort(3000, new Set(), probe([3000]))).toBe(49152);
  expect(await chooseLocalPort(3000, new Set([3000]), probe([]))).toBe(49152);
  // Privileged ports aren't bindable here, so they never keep their number.
  expect(await chooseLocalPort(80, new Set(), probe([]))).toBe(49152);
});

// ---------- connection state ----------

test("state: reconnecting with backoff, offline after a few attempts, connected resets", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoff)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  let s = initial();
  // Never connected since start: the first failure is simply offline.
  expect(failed(s, 0, { message: "x" }).state).toBe("offline");
  s = succeeded(s, 1000);
  expect(s).toMatchObject({ state: "connected", attempt: 0, lastSeen: 1000 });
  s = failed(s, 5000, { message: "ssh closed" });
  expect(s).toMatchObject({ state: "reconnecting", attempt: 1, lastSeen: 5000, nextRetryAt: 6000, lastError: "ssh closed" });
  for (let i = 2; i <= RECONNECT_ATTEMPTS; i++) s = failed(s, 6000, { message: "timeout", hint: "is it on?" });
  expect(s).toMatchObject({ state: "reconnecting", attempt: RECONNECT_ATTEMPTS, lastSeen: 5000 });
  s = failed(s, 7000, { message: "timeout" });
  expect(s).toMatchObject({ state: "offline", attempt: RECONNECT_ATTEMPTS + 1, lastSeen: 5000 });
  expect(retryNow(s)).toMatchObject({ state: "reconnecting", nextRetryAt: undefined });
  // Seen before (cached from an earlier run): a failed first attempt is "reconnecting".
  expect(failed(initial(1000), 2000, { message: "x" }).state).toBe("reconnecting");
});

// ---------- setup ----------

test("checklist: a failed step skips the rest", async () => {
  const c = new Checklist();
  await c.step("ssh", async () => ({ detail: "ok" }));
  await c.step("os", async () => ({ detail: "Linux", warning: "odd" }));
  await c.step("servedev", async () => {
    throw Object.assign(new Error("not found"), { hint: "install it" });
  });
  expect(await c.step("token", async () => ({}))).toBe(false);
  expect(c.result()).toEqual([
    { id: "ssh", label: "SSH connection", status: "ok", detail: "ok", hint: undefined },
    { id: "os", label: "Operating system", status: "warning", detail: "Linux; odd", hint: undefined },
    { id: "servedev", label: "servedev installed and running", status: "failed", detail: "not found", hint: "install it" },
    { id: "token", label: "API token", status: "skipped" },
    { id: "api", label: "servedev API through the tunnel", status: "skipped" },
  ]);
});

test("servedev probe output", () => {
  expect(parseServedevProbe("motd\n@missing\n")).toEqual({ missing: true, running: false });
  const p = parseServedevProbe("@path /x/servedev\n@version 0.2.0\n@status daemon 0.2.0 running (pid 9) at http://127.0.0.1:7777; log: l\n@home /h\n@token abc\n");
  expect(p).toMatchObject({ missing: false, version: "0.2.0", running: true, port: 7777, token: "abc", home: "/h" });
  expect(parseServedevProbe("@version 0.2.0\n@status daemon not running\n@token \n")).toMatchObject({ running: false, port: undefined, token: undefined });
});

test("SSE parsing across chunk boundaries", () => {
  const events: { event: string; data: string }[] = [];
  let rest = parseSse('event: server\ndata: {"id":"a"}\n\nevent: rem', (e) => events.push(e));
  rest = parseSse(rest + 'ove\ndata: {"id":"b"}\n\n', (e) => events.push(e));
  expect(rest).toBe("");
  expect(events).toEqual([
    { event: "server", data: '{"id":"a"}' },
    { event: "remove", data: '{"id":"b"}' },
  ]);
});

// ---------- config, secrets, boot ----------

test("config: machines are read from config.json, bad entries reported", () => {
  const warnings: string[] = [];
  const m = resolveMachines({ pc: { ssh: " me@pc ", kind: "wsl", distro: "Ubuntu" }, "Bad Name": { ssh: "x" }, mac: {}, ok: { ssh: "a@b", distro: "bad distro" } }, (w) => warnings.push(w));
  expect(m).toEqual({ pc: { ssh: "me@pc", kind: "wsl", distro: "Ubuntu" } });
  expect(warnings.join("\n")).toContain(`machine "Bad Name"`);
  expect(warnings.join("\n")).toContain(`machine "mac" needs "ssh"`);
  expect(warnings.join("\n")).toContain(`distro`);

  const home = tmp();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ machines: { pc: { ssh: "me@pc" } } }));
  const store = new ConfigStore(path.join(home, "config.json"));
  expect(resolveConfig(store).machines).toEqual({ pc: { ssh: "me@pc" } });
  // Removing the last machine leaves no empty "machines" behind.
  store.editLocal((c) => void delete c.machines!.pc);
  expect(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).machines).toBeUndefined();
});

test("schema: machines need ssh and take only the detected facts", () => {
  const machines = (localSchema as any).properties.machines;
  expect(machines.additionalProperties.required).toEqual(["ssh"]);
  expect(Object.keys(machines.additionalProperties.properties).sort()).toEqual(["distro", "kind", "ssh"]);
  expect(new RegExp(machines.propertyNames.pattern).test("pc")).toBe(true);
  expect(new RegExp(machines.propertyNames.pattern).test("PC")).toBe(false);
});

test("tokens off macOS: a file only the user can read", () => {
  const dir = path.join(tmp(), "machines");
  const store = fileStore(dir);
  expect(store.get("pc")).toBeUndefined();
  store.set("pc", "secret");
  expect(store.get("pc")).toBe("secret");
  expect(fs.statSync(path.join(dir, "pc.token")).mode & 0o777).toBe(0o600);
  store.delete("pc");
  expect(store.get("pc")).toBeUndefined();
});

test("boot task: a logon task with no window and no time limit, sent as encoded PowerShell", () => {
  const ps = bootTaskPowerShell("Ubuntu", "/home/me/.servedev/wsl-boot.sh");
  expect(ps).toContain("-Execute 'conhost.exe' -Argument '--headless wsl.exe -d Ubuntu -e /bin/bash -l /home/me/.servedev/wsl-boot.sh'");
  expect(ps).toContain("-ExecutionTimeLimit 0");
  expect(ps).toContain("-AtLogOn");
  const cmd = encodedPowerShell(ps);
  expect(cmd).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  expect(Buffer.from(cmd.split(" ").pop()!, "base64").toString("utf16le")).toBe(ps);
});

test("detect: Windows lands in cmd.exe and is driven through WSL; others are posix", async () => {
  const win = fakeSsh({ windows: true });
  const link = new SshLink({ target: "me@pc", socket: path.join(tmp(), "s"), spawner: win.spawner });
  expect(await detect(link)).toEqual({ kind: "wsl", distro: "Ubuntu", os: "Ubuntu 26.04 LTS (WSL on Windows)" });
  const mac = fakeSsh({});
  expect(await detect(new SshLink({ target: "me@mac", socket: path.join(tmp(), "s"), spawner: mac.spawner }))).toEqual({ kind: "posix", os: "macOS" });
  expect(mac.calls.at(-1)!.at(-1)).toStartWith(`exec "$SHELL" -lc`);
});
