import type { Profile, Server } from "./api"

/**
 * The one project all of a profile's servers are in, if any: sharing puts it in that repo. A
 * profile with servers on other machines can't be shared (a repo's profile starts one machine's servers).
 */
export function shareTarget(p: Profile, servers: Map<string, Server>): string | undefined {
  if (p.kind !== "local" || p.members.some((id) => id.includes("/"))) return undefined
  const projects = new Set(p.servers.map((id) => servers.get(id)?.project ?? id.split(":")[0]))
  return projects.size === 1 ? [...projects][0] : undefined
}

/** Other machines a profile of yours has servers on. */
export function profileMachines(p: Profile): string[] {
  return [...new Set(p.members.flatMap((id) => (id.includes("/") ? [id.slice(0, id.indexOf("/"))] : [])))]
}

/** "Shared in shop · main", "Shared in demo on pc", or "Yours" */
export function profileOrigin(p: Profile): string {
  return p.kind === "shared" ? `Shared in ${p.project}${p.machine ? ` on ${p.machine}` : ""}${p.branch ? ` · ${p.branch}` : ""}` : "Yours"
}
