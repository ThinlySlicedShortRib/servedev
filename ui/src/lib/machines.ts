/**
 * Other machines (a hub's remote servedevs) as the dashboard shows them: grouping the sidebar by
 * machine, labels, and the ports a remote server listens on there and here. Pure functions, so
 * they can be tested without a DOM.
 */
import { ago, type Machine, type MachineState, type Server } from "./api"
import { statusGroup, type Entry } from "./entries"

/** Which icon a machine gets. */
export type MachineIconKind = "laptop" | "monitor" | "server"

/** The machine an entry's server runs on; undefined for this one. */
export function entryMachine(e: Entry): string | undefined {
  return e.server?.machine
}

/** "WSL Ubuntu", "macOS", "Ubuntu": the short kind shown next to a machine's name. */
export function machineKind(m: Pick<Machine, "kind" | "distro" | "os">): string {
  if (m.kind === "wsl") return `WSL ${m.distro || "Linux"}`
  const os = m.os?.trim()
  if (!os) return m.kind === "posix" ? "Linux" : ""
  if (/mac\s?os|darwin/i.test(os)) return "macOS"
  // "Ubuntu 24.04.1 LTS" -> "Ubuntu", "Debian GNU/Linux 12" -> "Debian"
  return os.split(/\s+/)[0]
}

export function machineIcon(m: Pick<Machine, "kind" | "os"> | undefined): MachineIconKind {
  if (!m) return "laptop"
  if (m.kind === "wsl") return "monitor"
  if (m.os && /mac\s?os|darwin/i.test(m.os)) return "laptop"
  return "server"
}

/** What to call the machine the dashboard runs on (the hub), from the browser's platform. */
export function localMachineName(platform = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`): string {
  if (/mac/i.test(platform)) return "This Mac"
  if (/win/i.test(platform)) return "This PC"
  return "This computer"
}

/** The port a remote server listens on, on its own machine (what the sidebar shows). */
export function remotePortOf(s: Server): number | undefined {
  const fromUrl = s.remoteUrl ? Number(s.remoteUrl.split(":").pop()?.replace(/\D.*$/, "")) : NaN
  if (Number.isFinite(fromUrl) && fromUrl > 0) return fromUrl
  return s.forwards?.[0]?.remotePort ?? s.ports[0] ?? s.port
}

/** Where that port is forwarded to here, if it is. */
export function localPortOf(s: Server): number | undefined {
  const remote = remotePortOf(s)
  const f = s.forwards?.find((x) => x.remotePort === remote) ?? s.forwards?.[0]
  if (f) return f.localPort
  const fromUrl = s.url ? Number(s.url.split(":").pop()?.replace(/\D.*$/, "")) : NaN
  return Number.isFinite(fromUrl) && fromUrl > 0 ? fromUrl : undefined
}

export interface MachineCounts {
  total: number
  running: number
  crashed: number
}

/** Running/crashed counts by each server's last known state (an offline machine's too). */
export function countEntries(entries: Entry[]): MachineCounts {
  let running = 0
  let crashed = 0
  for (const e of entries) {
    const g = statusGroup(e)
    if (g === "running") running++
    else if (g === "crashed") crashed++
  }
  return { total: entries.length, running, crashed }
}

export interface MachineSection {
  /** undefined: this machine (the hub). */
  machine?: Machine
  /** Its projects, in the order they came. */
  groups: [string, Entry[]][]
  counts: MachineCounts
}

/**
 * The sidebar's sections once another machine exists: this machine first, then each remote one
 * (in the order given), each with its own projects. A remote machine with no servers still gets a
 * section, so its state and Retry stay visible; this machine's appears only when it has servers,
 * or when no remote machine does either.
 */
export function machineSections(groups: [string, Entry[]][], machines: Machine[]): MachineSection[] {
  const own = (name?: string) =>
    groups.map(([p, es]): [string, Entry[]] => [p, es.filter((e) => entryMachine(e) === name)]).filter(([, es]) => es.length > 0)
  const section = (machine?: Machine): MachineSection => {
    const g = own(machine?.name)
    return { machine, groups: g, counts: countEntries(g.flatMap(([, es]) => es)) }
  }
  return [section(), ...machines.map(section)]
}

/** Machines in the order the dashboard lists them. */
export function sortMachines(machines: Iterable<Machine>): Machine[] {
  return [...machines].sort((a, b) => a.name.localeCompare(b.name))
}

/** "3h 0m" -> "3h": headers only need the rough age. */
export function shortAgo(ms: number | undefined, now: number): string {
  return ago(ms, now).split(" ")[0]
}

export function stateLabel(state: MachineState): string {
  return state === "connected" ? "connected" : state === "connecting" ? "connecting…" : state === "reconnecting" ? "reconnecting…" : "offline"
}

/** One line about a machine that isn't connected, for tooltips and the sheet. */
export function stateSentence(m: Machine, now: number): string {
  if (m.state === "connected") return "connected"
  if (m.state === "connecting") return "connecting…"
  if (m.state === "reconnecting") return `reconnecting${m.attempt ? ` (attempt ${m.attempt})` : ""}…`
  return m.lastSeen ? `offline, last seen ${ago(m.lastSeen, now)} ago` : "offline"
}

/** The worst state among machines, for the header button's dot. */
export function worstState(machines: Machine[]): "reconnecting" | "offline" | null {
  if (machines.some((m) => m.state === "reconnecting" || m.state === "connecting")) return "reconnecting"
  if (machines.some((m) => m.state === "offline")) return "offline"
  return null
}

/** A default machine name from an SSH destination: "ariel@pc.tail3a9f.ts.net" -> "pc". */
export function suggestMachineName(ssh: string): string {
  const host = ssh.trim().replace(/^.*@/, "").replace(/:\d+$/, "")
  // An IP address makes a poor name.
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return ""
  return host
    .split(".")[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
}

/** Machine names become part of ids and hostnames (api.pc.localhost). Mirrors the daemon's rule. */
export const MACHINE_NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/

// ---------------------------------------------------------------------------------------------
// New servers on another machine
// ---------------------------------------------------------------------------------------------

/** A DNS label from a server or project name, as the hub makes them: "API_v2" -> "api-v2". */
export function hostLabel(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "server"
  )
}

/**
 * The hub hostname a new server on a machine gets: <server>.<machine>.localhost, or with its
 * project in it when another project there already uses the name (as the hub names them).
 */
export function remoteHostname(machine: string, name: string, project: string | undefined, servers: Iterable<Server>): string {
  const label = hostLabel(name)
  const clash = [...servers].some((s) => s.machine === machine && hostLabel(s.name) === label && s.project !== project)
  return clash && project ? `${label}.${hostLabel(project)}.${machine}.localhost` : `${label}.${machine}.localhost`
}

/** Why a path can't be a folder on another machine (relative paths would depend on its daemon). */
export function remotePathProblem(path: string, machine: string): string | undefined {
  const p = path.trim()
  if (!p || p.startsWith("/") || p === "~" || p.startsWith("~/")) return undefined
  return `Use a full path on ${machine} (/…), or one in its home folder (~/…).`
}

/** Why a machine can't take a new server right now; undefined when it can. */
export function unavailableReason(m: Machine, now = Date.now()): string | undefined {
  return m.state === "connected" ? undefined : stateSentence(m, now)
}
