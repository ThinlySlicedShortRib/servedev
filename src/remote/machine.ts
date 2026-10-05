/**
 * One remote machine: its SSH connection, the tunnel to its servedev API, its servers as last
 * seen, and forwards for their ports. The machine stays the only source of truth for its servers;
 * this only relays and remembers the last state it saw, so an offline machine still shows them.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ProfileView } from "../config";
import type { PublicServer } from "../manager";
import { RemoteApi, RemoteApiError } from "./api";
import { TARGETS, chooseLocalPort, diffForwards, systemPorts, wantedPorts, type PortProbe, type Target } from "./forwards";
import { hostAliases } from "./ids";
import type { LongProc, Spawner } from "./process";
import type { SecretStore } from "./secrets";
import { otherHubs, otherHubsWarning } from "./hubs";
import { Checklist, SERVEDEV_PROBE, StepError, missingHint, parseServedevProbe } from "./setup";
import { readSse } from "./sse";
import { failed, initial, retryNow, succeeded, type ConnStatus } from "./state";
import { SshLink, createTransport, detect, type Detected, type Transport } from "./transport";
import type { MachineConfig, SetupStep } from "./types";
import { updateServedev, type UpdateReport } from "./update";

export interface MachineDeps {
  /** Holds control sockets, cached state and (off macOS) tokens. */
  dir: string;
  secrets: SecretStore;
  hubVersion: string;
  /** This hub's name, sent to the machine so it knows which hubs are connected. */
  hubName?: string;
  /** Local ports taken by any machine's forwards. */
  reserved: Set<number>;
  spawner?: Spawner;
  ports?: PortProbe;
  now?: () => number;
}

/** What's worth remembering across hub restarts (not config: it changes all the time). */
interface Cache {
  lastSeen?: number;
  os?: string;
  version?: string;
  remotePort?: number;
  servers?: PublicServer[];
  profiles?: ProfileView[];
}

const HEALTH_EVERY = 15_000;
/** How often to look for dev servers started there outside servedev, whose ports get forwarded too. */
const OUTSIDE_EVERY = 5_000;

export class Machine extends EventEmitter {
  status: ConnStatus;
  /** Remote id -> the server as its machine last reported it. */
  readonly servers = new Map<string, PublicServer>();
  /** Its profiles as it last reported them (its own ids). */
  profiles: ProfileView[] = [];
  /** Remote port -> its forward here, and the loopback address it reaches there. */
  readonly forwards = new Map<number, { localPort: number; target: Target }>();
  /** Dev servers running there that its servedev didn't start (from a terminal, an agent): their ports are forwarded too. */
  outside: { command: string; ports: number[] }[] = [];
  /** Other hubs connected to it too, as it reports them (an older servedev reports none). */
  otherHubs: string[] = [];
  /** An update is restarting its daemon: losing it then isn't a lost connection. */
  private updating = false;
  /** Server id -> hub hostname (api.pc.localhost). */
  aliases = new Map<string, string>();
  steps?: SetupStep[];
  os?: string;
  version?: string;
  remotePort?: number;
  apiPort?: number;

  private link?: SshLink;
  private transport?: Transport;
  private api?: RemoteApi;
  private hold?: LongProc;
  private events?: AbortController;
  private healthTimer?: ReturnType<typeof setInterval>;
  private outsideTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** Bumped on every connect and teardown, so callbacks from an old connection do nothing. */
  private generation = 0;
  private attempting?: Promise<SetupStep[]>;
  private syncing?: Promise<void>;
  private resync = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly now: () => number;

  constructor(
    readonly name: string,
    public config: MachineConfig,
    private deps: MachineDeps,
  ) {
    super();
    this.now = deps.now ?? Date.now;
    const cache = this.readCache();
    this.os = cache.os;
    this.version = cache.version;
    this.remotePort = cache.remotePort;
    for (const s of cache.servers ?? []) this.servers.set(s.id, s);
    this.profiles = Array.isArray(cache.profiles) ? cache.profiles : [];
    this.aliases = hostAliases(name, [...this.servers.values()]);
    this.status = initial(cache.lastSeen);
  }

  get connected(): boolean {
    return this.status.state === "connected";
  }

  /** The API, or a clear error when the machine isn't connected. */
  liveApi(): RemoteApi {
    if (this.connected && this.api) return this.api;
    const seen = this.status.lastSeen ? `last seen ${Math.round((this.now() - this.status.lastSeen) / 1000)}s ago` : "not connected since servedev started";
    const why = this.status.lastError ? `: ${this.status.lastError}` : "";
    throw new RemoteApiError(503, `${this.name} is ${this.status.state} (${seen})${why}. Its servers show their last known state. Retry with: servedev remote reconnect ${this.name}`);
  }

  /** Commands on the machine, for things like the boot task; only while connected. */
  liveTransport(): Transport {
    this.liveApi();
    return this.transport!;
  }

  /** A command for Windows itself (cmd.exe), not WSL; only on a connected wsl machine. */
  runWindows(command: string) {
    this.liveApi();
    if (this.config.kind !== "wsl" || !this.link) throw new RemoteApiError(400, `${this.name} isn't a Windows machine`);
    return this.link.exec(command, { timeoutMs: 60_000 });
  }

  // ---------- connecting ----------

  /** Connect now (or join the attempt in progress). Resolves with the checklist. */
  connect(): Promise<SetupStep[]> {
    if (this.disposed) return Promise.resolve([]);
    clearTimeout(this.retryTimer);
    this.attempting ??= this.attempt().finally(() => (this.attempting = undefined));
    return this.attempting;
  }

  /** Drop the connection (if any) and connect again right away. */
  reconnect(): Promise<SetupStep[]> {
    if (this.attempting) return this.attempting;
    this.teardown();
    this.status = retryNow(this.status);
    this.changed();
    return this.connect();
  }

  private async attempt(): Promise<SetupStep[]> {
    this.teardown();
    const gen = this.generation;
    const list = new Checklist();
    const link = new SshLink({ target: this.config.ssh, socket: this.socketPath(), spawner: this.deps.spawner });
    this.link = link;
    let detected: Detected | undefined;
    let transport: Transport | undefined;
    let api: RemoteApi | undefined;
    let servers: PublicServer[] = [];
    let hubs: string[] = [];

    await list.step("ssh", async () => {
      await link.open();
      return { detail: `connected to ${this.config.ssh}` };
    });
    await list.step("os", async () => {
      detected = await detect(link, this.config.distro);
      transport = createTransport(link, detected.kind, detected.distro);
      return { detail: detected.os };
    });

    // Reconnecting: if the daemon answers with the token we have, there's nothing to run there.
    const stored = this.deps.secrets.get(this.name);
    let quick: { version: string } | undefined;
    if (list.ok && stored && this.remotePort) {
      quick = await this.openApi(link, this.remotePort, stored)
        .then((r) => {
          api = r.api;
          servers = r.servers;
          return r.health;
        })
        .catch(() => undefined);
    }
    let probe: ReturnType<typeof parseServedevProbe> | undefined;
    await list.step("servedev", async () => {
      if (quick) {
        this.version = quick.version;
        return this.versionOutcome(`${quick.version}, answering on port ${this.remotePort}`);
      }
      const r = await transport!.run(SERVEDEV_PROBE, { timeoutMs: 90_000 });
      probe = parseServedevProbe(r.stdout);
      if (probe.missing) throw new StepError(`servedev isn't installed on ${this.name}, or isn't on its login shell's PATH`, missingHint(detected?.kind, this.name));
      if (!probe.running) {
        const why = probe.status || (r.stderr.trim().split("\n").pop() ?? `exit ${r.code}`);
        throw new StepError(`servedev ${probe.version ?? ""} is installed but its daemon isn't running (${why})`.replace("  ", " "), `see ${probe.home ?? "~/.servedev"}/daemon.log on ${this.name}`);
      }
      this.version = probe.version;
      this.remotePort = probe.port;
      return this.versionOutcome(`${probe.version} running on port ${probe.port} (${probe.path})`);
    });
    await list.step("token", async () => {
      if (quick) return { detail: "the saved token works" };
      if (!probe!.token) throw new StepError(`couldn't read servedev's token on ${this.name}`, `it should be in ${probe!.home ?? "~/.servedev"}/token there`);
      if (probe!.token === stored) return { detail: "unchanged" };
      this.deps.secrets.set(this.name, probe!.token);
      return { detail: stored ? "it changed on the machine; saved the new one" : "saved (not in config.json)" };
    });
    await list.step("api", async () => {
      if (!api) {
        const r = await this.openApi(link, this.remotePort!, this.deps.secrets.get(this.name)!);
        api = r.api;
        servers = r.servers;
      }
      hubs = await api.call<{ hubs: unknown }>("GET", "/api/hubs", undefined, 10_000).then((r) => otherHubs(r.hubs, this.deps.hubName), () => []);
      const warning = otherHubsWarning(this.name, hubs);
      return {
        detail: `127.0.0.1:${api.localPort} here → port ${api.remotePort} on ${this.name}`,
        warning,
        hint: warning && `only one hub at a time keeps port numbers the same as on ${this.name}; remove it on the other one (servedev remote rm ${this.name}) if you don't need both`,
      };
    });

    this.steps = list.result();
    if (gen !== this.generation || this.disposed) {
      link.close();
      return this.steps;
    }
    if (!list.ok) {
      const f = list.failure!;
      this.teardown();
      this.lose({ message: `${f.label}: ${f.detail}`, hint: f.hint });
      return this.steps;
    }

    this.transport = transport;
    this.api = api;
    this.apiPort = api!.localPort;
    if (detected) this.os = detected.os;
    if (detected && (detected.kind !== this.config.kind || detected.distro !== this.config.distro)) {
      this.config = { ...this.config, kind: detected.kind, distro: detected.distro };
      this.emit("detected", { kind: detected.kind, distro: detected.distro });
    }
    this.status = succeeded(this.status, this.now());
    this.otherHubs = hubs;
    this.replaceServers(servers);
    this.watch(gen, link, transport!, api!);
    this.changed();
    this.syncForwards();
    return this.steps;
  }

  private versionOutcome(detail: string) {
    if (this.version && this.version !== this.deps.hubVersion) {
      return { detail, warning: `this hub runs ${this.deps.hubVersion}`, hint: `versions differ; update servedev here or on ${this.name} so both run the same one` };
    }
    return { detail };
  }

  /** Forward a local port to the remote daemon and check it answers, with this token. */
  private async openApi(link: SshLink, remotePort: number, token: string) {
    const local = await chooseLocalPort(0, this.deps.reserved, this.deps.ports ?? systemPorts);
    await link.forward(local, remotePort);
    this.deps.reserved.add(local);
    const api = new RemoteApi(local, remotePort, token, { machine: this.name, version: () => this.version, hub: this.deps.hubName });
    try {
      const health = await api.health(10_000);
      if (!health) throw new StepError(`nothing answers on port ${remotePort} on ${this.name}`, `is servedev's daemon running there? (servedev daemon status)`);
      let list: { servers: PublicServer[] };
      try {
        list = await api.call<{ servers: PublicServer[] }>("GET", "/api/servers", undefined, 20_000);
      } catch (e) {
        if (e instanceof RemoteApiError && e.status === 401) throw new StepError(`${this.name}'s servedev rejected the token`, `servedev remote reconnect ${this.name} reads it again`);
        throw e;
      }
      return { api, health, servers: list.servers };
    } catch (e) {
      await link.cancel(local, remotePort).catch(() => {});
      this.deps.reserved.delete(local);
      throw e;
    }
  }

  /** While connected: notice the link, the WSL session or the daemon going away. */
  private watch(gen: number, link: SshLink, transport: Transport, api: RemoteApi) {
    void link.closed.then(() => this.lost(gen, `the SSH connection closed${link.masterError() ? `: ${link.masterError()}` : ""}`));
    if (transport.kind === "wsl") {
      // WSL shuts its VM down (killing every server) once no Windows process is attached to it.
      // This session keeps it up while we're connected, and ends if WSL restarts.
      const hold = transport.hold("exec cat >/dev/null");
      const since = this.now();
      this.hold = hold;
      void hold.exited.then(() => {
        // Killed with its connection (teardown): nothing to report.
        if (gen !== this.generation) return;
        // Ending right away means it can't run at all; reconnecting would just loop.
        if (this.now() - since < 10_000) return void this.emit("warning", `couldn't hold a WSL session open: ${hold.stderr().trim() || "it exited"}`);
        this.lost(gen, "the WSL session ended (WSL shut down or restarted?)");
      });
    }
    const events = new AbortController();
    this.events = events;
    void (async () => {
      try {
        await readSse(await api.stream("/api/stream/events", events.signal), (e) => this.onEvent(e.event, e.data));
      } catch {}
      this.lost(gen, `servedev on ${this.name} stopped answering`);
    })();
    let misses = 0;
    this.healthTimer = setInterval(async () => {
      if (gen !== this.generation) return;
      if (await api.health()) {
        misses = 0;
        this.status = { ...this.status, lastSeen: this.now() };
        this.saveSoon();
      } else if (++misses >= 2) this.lost(gen, `servedev on ${this.name} stopped answering`);
    }, HEALTH_EVERY);
    const lookOutside = async () => {
      const r = await api.call<{ servers: { command: string; ports: number[] }[] }>("GET", "/api/external", undefined, 10_000).catch(() => undefined);
      if (!r || gen !== this.generation) return;
      const outside = r.servers.map((s) => ({ command: s.command, ports: s.ports }));
      if (JSON.stringify(outside) === JSON.stringify(this.outside)) return;
      this.outside = outside;
      this.syncForwards();
    };
    void lookOutside();
    this.outsideTimer = setInterval(lookOutside, OUTSIDE_EVERY);
  }

  private onEvent(event: string, data: string) {
    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "snapshot" && Array.isArray(payload.servers)) {
      this.replaceServers(payload.servers);
      if (Array.isArray(payload.profiles)) this.replaceProfiles(payload.profiles);
      if (Array.isArray(payload.hubs)) this.setHubs(payload.hubs);
    } else if (event === "profiles" && Array.isArray(payload)) this.replaceProfiles(payload);
    else if (event === "hubs") this.setHubs(payload);
    else if (event === "server" && payload?.id) {
      this.servers.set(payload.id, payload);
      this.serversChanged([payload.id]);
    } else if (event === "remove" && payload?.id && this.servers.delete(payload.id)) {
      this.emit("remove", payload.id);
      this.serversChanged([]);
    }
  }

  /**
   * A server state from a relayed response (fresher than the event that will follow it). Resolves
   * once its ports are forwarded, so the response can carry the local URL.
   */
  async observe(raw: PublicServer, timeoutMs = 5000): Promise<void> {
    if (!raw?.id || !Array.isArray(raw.ports)) return;
    this.servers.set(raw.id, raw);
    this.serversChanged([raw.id]);
    await Promise.race([this.syncing, Bun.sleep(timeoutMs)]);
  }

  private replaceServers(list: PublicServer[]) {
    const next = new Set(list.map((s) => s.id));
    for (const id of [...this.servers.keys()]) {
      if (!next.has(id)) {
        this.servers.delete(id);
        this.emit("remove", id);
      }
    }
    for (const s of list) this.servers.set(s.id, s);
    this.serversChanged(list.map((s) => s.id));
  }

  private replaceProfiles(list: ProfileView[]) {
    if (JSON.stringify(list) === JSON.stringify(this.profiles)) return;
    this.profiles = list;
    this.emit("profiles");
    this.saveSoon();
  }

  private setHubs(list: unknown) {
    const hubs = otherHubs(list, this.deps.hubName);
    if (JSON.stringify(hubs) === JSON.stringify(this.otherHubs)) return;
    this.otherHubs = hubs;
    this.changed();
  }

  /**
   * Update servedev there and restart its daemon (see update.ts), then reconnect, so the checklist
   * runs again against the new one. Refusals throw before anything changes there.
   */
  async update(): Promise<{ report: UpdateReport; steps: SetupStep[] }> {
    const transport = this.liveTransport();
    if (this.updating) throw new RemoteApiError(409, `${this.name} is being updated already`);
    // Its daemon restarting ends the event stream and fails health checks; that's expected.
    this.updating = true;
    let report: UpdateReport;
    try {
      report = await updateServedev(transport, this.name, this.deps.hubVersion);
    } finally {
      this.updating = false;
    }
    const steps = await this.reconnect();
    return { report, steps };
  }

  private serversChanged(ids: string[]) {
    this.aliases = hostAliases(this.name, [...this.servers.values()]);
    for (const id of ids) this.emit("server", id);
    this.syncForwards();
    this.saveSoon();
  }

  private lost(gen: number, reason: string) {
    if (gen !== this.generation || !this.connected || this.updating) return;
    this.teardown();
    this.lose({ message: reason });
  }

  /** Record a failure and schedule the next attempt. */
  private lose(error: { message: string; hint?: string }) {
    this.status = failed(this.status, this.now(), error);
    this.changed();
    if (this.disposed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), Math.max(0, (this.status.nextRetryAt ?? this.now()) - this.now()));
  }

  /** Close everything belonging to the current connection. Servers stay as last known. */
  private teardown() {
    this.generation++;
    clearInterval(this.healthTimer);
    clearInterval(this.outsideTimer);
    this.outside = [];
    this.otherHubs = [];
    this.events?.abort();
    this.events = undefined;
    this.hold?.kill();
    this.hold = undefined;
    for (const f of this.forwards.values()) this.deps.reserved.delete(f.localPort);
    if (this.apiPort) this.deps.reserved.delete(this.apiPort);
    const hadForwards = this.forwards.size > 0;
    this.forwards.clear();
    this.apiPort = undefined;
    this.api = undefined;
    this.transport = undefined;
    // Closing the master drops every forward on it.
    this.link?.close();
    this.link = undefined;
    if (hadForwards) this.emit("forwards");
  }

  dispose() {
    // What it saw last is kept for next time (e.g. the machine's entry was edited and it's recreated).
    if (this.saveTimer) this.save();
    this.disposed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.saveTimer);
    this.teardown();
    this.removeAllListeners();
  }

  /** Forget everything stored for this machine (it was removed). */
  purge() {
    this.dispose();
    this.deps.secrets.delete(this.name);
    fs.rmSync(this.cachePath(), { force: true });
  }

  private changed() {
    this.emit("status");
    this.saveSoon();
  }

  // ---------- forwards ----------

  /** Bring forwards in line with the servers' listening ports; runs one sync at a time. */
  syncForwards() {
    if (this.syncing) {
      this.resync = true;
      return;
    }
    this.syncing = (async () => {
      do {
        this.resync = false;
        await this.applyForwards().catch((e) => this.emit("warning", `forwarding ports from ${this.name}: ${(e as Error).message}`));
      } while (this.resync);
    })().finally(() => (this.syncing = undefined));
  }

  private async applyForwards() {
    const link = this.link;
    const gen = this.generation;
    if (!this.connected || !link) return;
    const current = [...this.forwards].map(([remotePort, f]) => ({ remotePort, localPort: f.localPort }));
    const outside = this.outside.map((o) => ({ status: "running", ports: o.ports }));
    const { add, cancel } = diffForwards(current, wantedPorts([...this.servers.values(), ...outside]));
    if (!add.length && !cancel.length) return;
    for (const f of cancel) {
      await link.cancel(f.localPort, f.remotePort, this.forwards.get(f.remotePort)?.target).catch(() => {});
      this.forwards.delete(f.remotePort);
      this.deps.reserved.delete(f.localPort);
    }
    await Promise.all(add.map((remote) => this.openForward(link, gen, remote)));
    if (gen === this.generation) this.emit("forwards");
  }

  /**
   * Forward one remote port. Which loopback address the server answers on isn't known from here,
   * so a forward to each is opened at once (on two local ports) and the one that leads somewhere is
   * kept; the other is cancelled.
   */
  private async openForward(link: SshLink, gen: number, remote: number) {
    const probe = this.deps.ports ?? systemPorts;
    const waitMs = this.config.kind === "wsl" ? 2500 : 800;
    const opened: { local: number; target: Target }[] = [];
    let lastError: unknown;
    for (const target of TARGETS) {
      for (let tries = 0; tries < 3 && gen === this.generation; tries++) {
        // The preferred number goes to the first target; the other one only needs some free port.
        const local = await chooseLocalPort(target === TARGETS[0] ? remote : 0, this.deps.reserved, probe);
        this.deps.reserved.add(local);
        try {
          await link.forward(local, remote, target);
          opened.push({ local, target });
          break;
        } catch (e) {
          // Most likely the port was taken between the check and ssh binding it: try another.
          this.deps.reserved.delete(local);
          lastError = e;
        }
      }
    }
    if (!opened.length) return void this.emit("warning", (lastError as Error)?.message ?? `couldn't forward port ${remote}`);
    const live = await Promise.all(opened.map((o) => probe.reaches(o.local, waitMs)));
    // Answers on neither (yet): keep the usual one.
    const keep = opened[live.indexOf(true)] ?? opened[0];
    for (const o of opened) {
      if (o === keep) continue;
      await link.cancel(o.local, remote, o.target).catch(() => {});
      this.deps.reserved.delete(o.local);
    }
    // The address that answers had to make do with another port; now that the trial forward on the
    // same number is gone, move it there (expo on WSL listens only on ::1).
    if (keep.local !== remote && gen === this.generation && (await chooseLocalPort(remote, this.deps.reserved, probe)) === remote) {
      this.deps.reserved.add(remote);
      try {
        await link.forward(remote, remote, keep.target);
        await link.cancel(keep.local, remote, keep.target).catch(() => {});
        this.deps.reserved.delete(keep.local);
        keep.local = remote;
      } catch {
        this.deps.reserved.delete(remote);
      }
    }
    this.keep(gen, remote, keep.local, keep.target);
  }

  private keep(gen: number, remotePort: number, localPort: number, target: Target) {
    if (gen !== this.generation) {
      this.deps.reserved.delete(localPort);
      return;
    }
    this.forwards.set(remotePort, { localPort, target });
  }

  // ---------- files ----------

  private socketPath() {
    return path.join(this.deps.dir, `${this.name}.sock`);
  }

  private cachePath() {
    return path.join(this.deps.dir, `${this.name}.json`);
  }

  private readCache(): Cache {
    try {
      return JSON.parse(fs.readFileSync(this.cachePath(), "utf8")) as Cache;
    } catch {
      return {};
    }
  }

  private saveSoon() {
    if (this.disposed) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 500);
  }

  save() {
    if (this.disposed) return;
    const cache: Cache = { lastSeen: this.status.lastSeen, os: this.os, version: this.version, remotePort: this.remotePort, servers: [...this.servers.values()], profiles: this.profiles };
    try {
      fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.cachePath()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
      fs.renameSync(tmp, this.cachePath());
    } catch {}
  }
}
