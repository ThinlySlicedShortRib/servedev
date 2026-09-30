import { ACTIVE, type Configured, type ExternalServer, type Server, type Status } from "@/lib/api"

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

export function groupEntries(servers: Map<string, Server>, configured: Configured[], external: ExternalServer[] = []): [string, Entry[]][] {
  const groups = new Map<string, Entry[]>()
  const add = (e: Entry) => {
    if (!groups.has(e.project)) groups.set(e.project, [])
    groups.get(e.project)!.push(e)
  }
  for (const s of servers.values()) add({ key: s.id, name: s.name, project: s.project, status: s.status, server: s })
  for (const c of configured) add({ key: `${c.project}:${c.name}`, name: c.name, project: c.project, status: "idle", configured: c })
  for (const x of external) add({ key: x.id, name: x.suggestedName, project: x.project, status: "running", external: x })

  // Managed running servers first, then ones running outside servedev, then the rest.
  const rank = (e: Entry) => (e.external ? 1 : ACTIVE.includes(e.status as Status) ? 0 : 2)
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, es]) => [p, es.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))])
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
  const haystack = [e.name, e.project, e.key, s?.url, s?.ports.join(" "), s?.command ?? e.configured?.command ?? x?.command, s?.cwd ?? x?.cwd, x?.ports.join(" "), x && "outside servedev", branchOf(e)]
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
  const pinned = groups.flatMap(([, es]) => es.filter((e) => e.server?.pinned))
  return {
    pinned,
    groups: groups.map(([p, es]): [string, Entry[]] => [p, es.filter((e) => !e.server?.pinned)]).filter(([, es]) => es.length > 0),
  }
}
