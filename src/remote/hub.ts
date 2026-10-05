/**
 * The hub side of remote machines: one Machine per entry in config.json's "machines", their
 * servers as views with "pc/" ids, hostnames for the proxy, and routing of server references to
 * the machine that owns them.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { ACTIVE, type PublicServer } from "../manager";
import type { Route } from "../proxy";
import { RemoteApiError, type RemoteApi } from "./api";
import { RefError, assertMachineName, remoteId, resolveRemoteRef, splitRef } from "./ids";
import { Machine, type MachineDeps } from "./machine";
import { assertRemotePath, isMissingEndpoint, remoteStartBody, tooOld } from "./create";
import type { MachineConfig, MachineSummary, RemoteServerView, SetupStep } from "./types";
import type { UpdateReport } from "./update";
import type { ProfileView } from "../config";
import { remoteProfileView, sharedOn, type MachineLookup } from "./profiles";

export interface HubDeps extends Omit<MachineDeps, "reserved"> {
  /** URL of a hostname through the hub's proxy (undefined while the proxy isn't running). */
  urlFor: (hostname: string) => string | undefined;
}

/** A reference to a server on a connected machine. */
export interface RemoteTarget {
  machine: Machine;
  api: RemoteApi;
  server: PublicServer;
}

export class RemoteHub extends EventEmitter {
  readonly machines = new Map<string, Machine>();
  private reserved = new Set<number>();
  /** Being added: not in config.json yet, so sync() mustn't drop them. */
  private adding = new Set<string>();

  constructor(private deps: HubDeps) {
    super();
    fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
  }

  /** Match the machines in config.json: connect new ones, drop removed ones, redo changed ones. */
  sync(configs: Record<string, MachineConfig>) {
    for (const [name, m] of this.machines) {
      if (this.adding.has(name)) continue;
      const c = configs[name];
      if (!c) this.drop(name);
      else if (c.ssh !== m.config.ssh || (c.distro && c.distro !== m.config.distro)) {
        this.drop(name);
        this.create(name, c).connect();
      } else m.config = { ...m.config, ...c };
    }
    for (const [name, c] of Object.entries(configs)) if (!this.machines.has(name)) this.create(name, c).connect();
  }

  private create(name: string, config: MachineConfig): Machine {
    const m = new Machine(name, config, { ...this.deps, reserved: this.reserved });
    this.machines.set(name, m);
    m.on("server", (id: string) => {
      const raw = m.servers.get(id);
      if (raw) this.emit("server", this.view(m, raw));
    });
    m.on("remove", (id: string) => this.emit("remove", { id: remoteId(name, id) }));
    // Connection state and forwards change every server's view (stale, url).
    const all = () => {
      this.emit("machine", this.summary(m));
      for (const raw of m.servers.values()) this.emit("server", this.view(m, raw));
    };
    m.on("status", all);
    m.on("forwards", all);
    // Its shared profiles, and whether profiles' members there can be reached, follow its state.
    m.on("status", () => this.emit("profiles"));
    m.on("profiles", () => this.emit("profiles"));
    m.on("detected", (facts) => this.emit("detected", name, facts));
    m.on("warning", (msg: string) => console.log(`remote ${name}: ${msg}`));
    return m;
  }

  private drop(name: string, purge = false) {
    const m = this.machines.get(name);
    if (!m) return;
    const ids = [...m.servers.keys()];
    if (purge) m.purge();
    else m.dispose();
    this.machines.delete(name);
    for (const id of ids) this.emit("remove", { id: remoteId(name, id) });
    this.emit("machine-removed", { name });
    this.emit("profiles");
  }

  /**
   * Add a machine: connect and run the checklist. On success it stays connected and the caller
   * saves it to config.json; on failure nothing is kept.
   */
  async add(name: string, config: MachineConfig): Promise<{ ok: boolean; steps: SetupStep[]; machine?: Machine }> {
    assertMachineName(name);
    const existing = this.machines.get(name);
    if (existing && existing.config.ssh !== config.ssh) throw new RefError(409, `there's already a machine called ${name} (${existing.config.ssh}); remove it first or pick another name`);
    if (existing) {
      const steps = await existing.reconnect();
      return { ok: existing.connected, steps, machine: existing };
    }
    this.adding.add(name);
    try {
      const m = this.create(name, config);
      const steps = await m.connect();
      if (!m.connected) {
        this.drop(name, true);
        return { ok: false, steps };
      }
      return { ok: true, steps, machine: m };
    } finally {
      this.adding.delete(name);
    }
  }

  /** Disconnect and forget a machine's token and cached servers. */
  remove(name: string) {
    this.get(name);
    this.drop(name, true);
  }

  /** Update servedev on a machine and restart its daemon; then it's reconnected and checked. */
  async update(name: string): Promise<UpdateReport & { steps: SetupStep[]; machine: MachineSummary }> {
    const m = this.get(name);
    const { report, steps } = await m.update();
    return { ...report, steps, machine: this.summary(m) };
  }

  get(name: string): Machine {
    const m = this.machines.get(name);
    if (!m) throw new RefError(404, `no machine called "${name}"${this.machines.size ? ` (have: ${[...this.machines.keys()].join(", ")})` : "; add one with servedev remote add <name> <user@host>"}`);
    return m;
  }

  dispose() {
    for (const m of this.machines.values()) m.dispose();
    this.machines.clear();
  }

  // ---------- views ----------

  view(m: Machine, raw: PublicServer): RemoteServerView {
    const connected = m.connected;
    const forwards = raw.ports.flatMap((remotePort) => {
      const f = m.forwards.get(remotePort);
      return f ? [{ remotePort, localPort: f.localPort }] : [];
    });
    const primary = raw.url ? Number(new URL(raw.url).port) || raw.ports[0] : raw.ports[0];
    const local = connected && primary ? m.forwards.get(primary)?.localPort : undefined;
    const alias = m.aliases.get(raw.id);
    return {
      ...raw,
      id: remoteId(m.name, raw.id),
      machine: m.name,
      remoteId: raw.id,
      machineState: m.status.state,
      stale: connected ? undefined : true,
      remoteUrl: raw.url,
      url: local ? localUrl(raw.url, primary!, local) : undefined,
      localHostname: alias,
      customUrl: local && alias ? this.deps.urlFor(alias) : undefined,
      forwards,
    };
  }

  views(): RemoteServerView[] {
    return [...this.machines.values()].flatMap((m) => [...m.servers.values()].map((s) => this.view(m, s)));
  }

  /** Every server view again (e.g. the proxy moved, so hub URLs changed). */
  emitAll() {
    for (const s of this.views()) this.emit("server", s);
  }

  summary(m: Machine): MachineSummary {
    const servers = [...m.servers.values()];
    const forwards = [...m.forwards].map(([remotePort, f]) => ({
      remotePort,
      localPort: f.localPort,
      target: f.target,
      serverIds: servers.filter((s) => s.ports.includes(remotePort)).map((s) => remoteId(m.name, s.id)),
      outside: m.outside.filter((o) => o.ports.includes(remotePort)).map((o) => o.command),
    }));
    return {
      name: m.name,
      ssh: m.config.ssh,
      kind: m.config.kind,
      distro: m.config.distro,
      os: m.os,
      ...m.status,
      version: m.version,
      hubVersion: this.deps.hubVersion,
      versionMismatch: !!m.version && m.version !== this.deps.hubVersion,
      otherHubs: m.otherHubs,
      remotePort: m.remotePort,
      apiPort: m.apiPort,
      counts: {
        total: servers.length,
        running: servers.filter((s) => s.status === "running").length,
        crashed: servers.filter((s) => s.status === "crashed").length,
      },
      forwards,
      steps: m.steps,
    };
  }

  /** Profiles shared in repos on other machines, in hub terms ("pc/<project>:<name>"). */
  profiles(): ProfileView[] {
    return [...this.machines.values()].flatMap((m) => sharedOn(m.profiles).map((p) => remoteProfileView(m.name, m.connected, p)));
  }

  /** What's known about a machine's servers, for checking your profiles' refs to them. */
  lookup(name: string): MachineLookup | undefined {
    const m = this.machines.get(name);
    return m && { name: m.name, connected: m.connected, servers: [...m.servers.values()] };
  }

  summaries(): MachineSummary[] {
    return [...this.machines.values()].map((m) => this.summary(m));
  }

  // ---------- references ----------

  isRemote(ref: unknown): boolean {
    return typeof ref === "string" && !!splitRef(ref);
  }

  /** The machine and server a "pc/..." reference names; undefined for local references. */
  find(ref: unknown): { machine: Machine; server: PublicServer } | undefined {
    const split = typeof ref === "string" ? splitRef(ref) : undefined;
    if (!split) return undefined;
    const machine = this.get(split.machine);
    return { machine, server: resolveRemoteRef(machine.name, split.ref, [...machine.servers.values()]) };
  }

  /** Like find, for acting on the server: its machine must be connected. */
  target(ref: unknown): RemoteTarget | undefined {
    const found = this.find(ref);
    if (!found) return undefined;
    return { ...found, api: found.machine.liveApi() };
  }

  /** Split references into local ones and, per machine, remote ids. */
  partition(refs: unknown[]): { local: unknown[]; remote: Map<Machine, string[]> } {
    const local: unknown[] = [];
    const remote = new Map<Machine, string[]>();
    for (const ref of refs) {
      const found = this.find(ref);
      if (!found) local.push(ref);
      else remote.set(found.machine, [...(remote.get(found.machine) ?? []), found.server.id]);
    }
    return { local, remote };
  }

  /**
   * Turn a remote response into hub terms: server views get "pc/" ids and local URLs, plain ids
   * get the prefix.
   */
  rewrite<T>(m: Machine, data: T): T {
    if (!data || typeof data !== "object") return data;
    const out: Record<string, any> = { ...(data as Record<string, any>) };
    const asView = (s: any) => (s && typeof s === "object" && typeof s.id === "string" && Array.isArray(s.ports) ? this.view(m, s as PublicServer) : s);
    const prefix = (id: unknown) => (typeof id === "string" ? remoteId(m.name, id) : id);
    if (out.server) out.server = asView(out.server);
    if (Array.isArray(out.servers)) out.servers = out.servers.map(asView);
    if (typeof out.removed === "string") out.removed = prefix(out.removed);
    for (const key of ["stopped", "starting"]) if (Array.isArray(out[key])) out[key] = out[key].map(prefix);
    // Bulk start results carry the URL there; point it here when the port is forwarded already.
    const here = (url: unknown) => {
      if (typeof url !== "string") return url;
      const port = Number(URL.canParse(url) ? new URL(url).port : 0);
      const f = port ? m.forwards.get(port) : undefined;
      return f ? localUrl(url, port, f.localPort) : url;
    };
    if (Array.isArray(out.results)) out.results = out.results.map((r: any) => (r && typeof r === "object" ? { ...r, id: prefix(r.id), ...("url" in r ? { url: here(r.url) } : {}) } : r));
    return out as T;
  }

  // ---------- new servers on a machine ----------

  /**
   * /api/start for another machine: a "pc/..." id or name, or `machine` with a name and/or the
   * folder there (`dir`) to create a server in. Answers in hub terms; undefined for a local start.
   */
  async start(body: Record<string, any>): Promise<object | undefined> {
    const ref = body.id ?? body.name;
    const split = typeof ref === "string" ? splitRef(ref) : undefined;
    const named = typeof body.machine === "string" && body.machine ? body.machine : undefined;
    if (!split && !named) return undefined;
    if (split && named && split.machine !== named) throw new RefError(400, `${ref} is on ${split.machine}, not ${named}`);
    const m = this.get(split?.machine ?? named!);
    const api = m.liveApi();
    const startBody = await remoteStartBody(
      { machine: m.name, servers: [...m.servers.values()], inspect: (dir) => api.call("GET", `/api/inspect?${new URLSearchParams({ dir })}`) },
      { ...body, name: split ? split.ref : body.name },
    );
    // Long enough for an install before the server is ready (the remote applies its own timeout).
    const waitSec = typeof body.timeout === "number" ? body.timeout : body.install || body.setup ? 300 : 60;
    const data = await api.call<{ server?: PublicServer }>("POST", "/api/start", startBody, (waitSec + 60) * 1000);
    // Answer with its URL here once its port is forwarded.
    if (data?.server) await m.observe(data.server);
    return this.rewrite(m, data);
  }

  /**
   * A folder on a machine, as the "new server" dialog needs it, plus where a server there opens
   * here: urlTemplate with {host} for its hub hostname (web.pc.localhost); absent without the proxy.
   */
  async inspect(machine: string, dir: string): Promise<Record<string, unknown>> {
    const m = this.get(machine);
    const path = assertRemotePath(m.name, dir);
    const data = await m.liveApi().call<Record<string, unknown>>("GET", `/api/inspect?${new URLSearchParams({ dir: path })}`);
    return { ...data, machine: m.name, urlTemplate: this.deps.urlFor("{host}") };
  }

  /** A machine's /api/dirs; an older servedev there gets a clear "update it" instead of a 404. */
  async dirs(machine: string, params: { path?: string | null; hidden?: string | null; limit?: string | null }): Promise<Record<string, unknown>> {
    const m = this.get(machine);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) q.set(k, v);
    try {
      return { ...(await m.liveApi().call<Record<string, unknown>>("GET", `/api/dirs?${q}`)), machine: m.name };
    } catch (e) {
      if (isMissingEndpoint(e)) throw tooOld(m.name, m.version, this.deps.hubVersion, "list its folders (type the path instead)");
      if (e instanceof RemoteApiError && e.status < 500) throw new RemoteApiError(e.status, `${e.message} on ${m.name}`);
      throw e;
    }
  }

  // ---------- hostname proxy ----------

  /** Route for a hub hostname like api.pc.localhost. */
  route(host: string): Route | undefined {
    for (const m of this.machines.values()) {
      for (const [id, alias] of m.aliases) {
        if (alias !== host) continue;
        const s = m.servers.get(id);
        const v = s && this.view(m, s);
        const port = v?.url ? Number(new URL(v.url).port) : undefined;
        if (!m.connected) {
          return { status: "stopped", serverId: remoteId(m.name, id), hostname: host, reason: `${m.name} is ${m.status.state}${m.status.lastError ? ` (${m.status.lastError})` : ""}; servedev keeps trying to reconnect.` };
        }
        if (!v || !port || !ACTIVE.includes(v.status)) return { status: "stopped", serverId: remoteId(m.name, id), hostname: host };
        return { status: "ok", port, serverId: v.id };
      }
    }
    return undefined;
  }

  /** Hub hostnames of active, forwarded servers. */
  routes(): { hostname: string; id: string }[] {
    return this.views().flatMap((v) => (v.localHostname && v.url && ACTIVE.includes(v.status) ? [{ hostname: v.localHostname, id: v.id }] : []));
  }

  hostnames(): string[] {
    return [...this.machines.values()].flatMap((m) => [...m.aliases.values()]);
  }
}

/** The remote URL pointed at its forward: http://localhost:3000/x -> http://127.0.0.1:41234/x. */
export function localUrl(remote: string | undefined, remotePort: number, localPort: number): string {
  if (!remote) return `http://127.0.0.1:${localPort}`;
  try {
    const u = new URL(remote);
    if (Number(u.port) !== remotePort) return `http://127.0.0.1:${localPort}`;
    u.hostname = "127.0.0.1";
    u.port = String(localPort);
    return u.toString().replace(/\/$/, "");
  } catch {
    return `http://127.0.0.1:${localPort}`;
  }
}
