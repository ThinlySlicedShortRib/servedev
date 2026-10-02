import { ACTIVE, type Configured, type ExternalServer, type Server, type Status } from "./api"

/** A row in the sidebar: a known server, or one declared in servedev.json but never started. */
export interface Entry {
  key: string
  name: string
  project: string
  status: Status | "idle"
  server?: Server
  configured?: Configured
  /** Running outside servedev: shown so it can be taken over. */
  external?: ExternalServer
}

/** The branch of an entry's folder, whichever kind of entry it is. */
export function branchOf(e: Entry): string | undefined {
  return e.server?.branch ?? e.configured?.branch ?? e.external?.branch
}

/**
 * Entries by project, sorted by project name. A project on another machine is its own group
 * ("demo" here and "demo" on pc are two groups with the same label), after this machine's.
 */
export function groupEntries(servers: Map<string, Server>, configured: Configured[], external: ExternalServer[] = []): [string, Entry[]][] {
  const groups = new Map<string, Entry[]>()
  const add = (e: Entry) => {
    const key = groupKey(e)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }
  for (const s of servers.values()) add({ key: s.id, name: s.name, project: s.project, status: s.status, server: s })
  for (const c of configured) add({ key: `${c.project}:${c.name}`, name: c.name, project: c.project, status: "idle", configured: c })
  for (const x of external) add({ key: x.id, name: x.suggestedName, project: x.project, status: "running", external: x })

  // Managed running servers first, then ones running outside servedev, then the rest.
  const rank = (e: Entry) => (e.external ? 1 : ACTIVE.includes(e.status as Status) ? 0 : 2)
  return [...groups.values()]
    .map((es): [string, Entry[]] => [es[0].project, es.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))])
    .sort(([a, x], [b, y]) => a.localeCompare(b) || (x[0].server?.machine ?? "").localeCompare(y[0].server?.machine ?? ""))
}

/** Which group an entry belongs to: its project, on its machine. */
function groupKey(e: Entry): string {
  return e.server?.machine ? `${e.server.machine}/${e.project}` : e.project
}

export type StatusFilter = "all" | "running" | "stopped" | "crashed"

export function statusGroup(e: Entry): Exclude<StatusFilter, "all"> {
  if (ACTIVE.includes(e.status as Status)) return "running"
  if (e.status === "crashed") return "crashed"
  return "stopped"
}

/** Every whitespace-separated term must appear in the name, project, port, command or directory. */
export function matchesQuery(e: Entry, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const s = e.server
  const x = e.external
  const haystack = [e.name, e.project, e.key, s?.url, s?.machine, s?.localHostname, s?.ports.join(" "), s?.command ?? e.configured?.command ?? x?.command, s?.cwd ?? x?.cwd, x?.ports.join(" "), x && "outside servedev", branchOf(e)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return terms.every((t) => haystack.includes(t))
}

export function filterGroups(groups: [string, Entry[]][], query: string, status: StatusFilter): [string, Entry[]][] {
  return groups
    .map(([p, es]): [string, Entry[]] => [p, es.filter((e) => (status === "all" || statusGroup(e) === status) && matchesQuery(e, query))])
    .filter(([, es]) => es.length > 0)
}

/**
 * What the sidebar shows. In a profile view: only the profile's servers, grouped by project.
 * Otherwise: pinned servers in their own list, and everything else by project.
 */
export function viewEntries(
  groups: [string, Entry[]][],
  profile: { servers: string[] } | undefined
): { pinned: Entry[]; groups: [string, Entry[]][] } {
  if (profile) {
    const members = new Set(profile.servers)
    return {
      pinned: [],
      groups: groups.map(([p, es]): [string, Entry[]] => [p, es.filter((e) => members.has(e.key))]).filter(([, es]) => es.length > 0),
    }
  }
  // Pinned on another machine means it starts with servedev there; it stays with its machine.
  const isPinned = (e: Entry) => !!e.server?.pinned && !e.server.machine
  const pinned = groups.flatMap(([, es]) => es.filter(isPinned))
  return {
    pinned,
    groups: groups.map(([p, es]): [string, Entry[]] => [p, es.filter((e) => !isPinned(e))]).filter(([, es]) => es.length > 0),
  }
}
