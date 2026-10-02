/**
 * Profiles across machines, on a hub.
 *
 * - Your own profiles (the hub's config.json) can list servers on other machines ("pc/demo:api").
 *   Whether such a server exists is the machine's to say, so refs are checked against what it last
 *   reported: found means a member (unavailable while the machine is away), not found on a
 *   connected machine means missing. Refs are never dropped just because a machine is away.
 * - Profiles shared in a repo on another machine belong to that machine: they're shown here with
 *   "pc/" ids and their own machine's name, and everything done to them is relayed there.
 */
import type { ProfileView } from "../config";
import type { PublicServer } from "../manager";
import { RefError, remoteId, resolveRemoteRef, splitRef } from "./ids";

/** What the hub knows about a machine, for checking refs. */
export interface MachineLookup {
  name: string;
  connected: boolean;
  servers: PublicServer[];
}

/**
 * One of your profiles with its other-machine refs checked: canonical ids ("pc/api" ->
 * "pc/demo:api"), unknown ones moved to `missing`, ones on a machine that's away in `unavailable`.
 * Profiles without such refs come back as they are.
 */
export function withRemoteMembers(p: ProfileView, machine: (name: string) => MachineLookup | undefined): ProfileView {
  if (p.kind !== "local" || !p.members.some((id) => splitRef(id))) return p;
  const members: string[] = [];
  const missing = [...p.missing];
  const unavailable: string[] = [];
  for (const ref of p.members) {
    const split = splitRef(ref);
    if (!split) {
      if (!members.includes(ref)) members.push(ref);
      continue;
    }
    const m = machine(split.machine);
    if (!m) {
      missing.push(ref);
      continue;
    }
    let id = ref;
    try {
      id = remoteId(m.name, resolveRemoteRef(m.name, split.ref, m.servers).id);
    } catch {
      // Gone from a machine that's here to say so: missing. Away: kept as it was written.
      if (m.connected) {
        missing.push(ref);
        continue;
      }
    }
    if (members.includes(id)) continue;
    members.push(id);
    if (!m.connected) unavailable.push(id);
  }
  return { ...p, servers: members, members, missing, unavailable };
}

/** A machine's shared profile as the hub shows it: "pc/" ids, its machine, all unavailable while it's away. */
export function remoteProfileView(machine: string, connected: boolean, p: ProfileView): ProfileView {
  const prefix = (ids: string[] | undefined) => (ids ?? []).map((id) => remoteId(machine, id));
  const members = prefix(p.members);
  return {
    ...p,
    id: remoteId(machine, p.id),
    servers: prefix(p.servers),
    skipped: prefix(p.skipped),
    members,
    missing: prefix(p.missing),
    unavailable: connected ? [] : members,
    machine,
  };
}

/** The profiles a machine reports that the hub shows: the ones shared in its repos (not its own, nor its hubs' relays). */
export function sharedOn(list: ProfileView[]): ProfileView[] {
  // Profile names may contain "/", so a relayed one is told apart by its machine, not its id.
  return list.filter((p) => p && p.kind === "shared" && typeof p.id === "string" && Array.isArray(p.members) && !p.machine);
}

/**
 * Server refs for a request about a profile on `machine`, in that machine's terms: "pc/demo:api"
 * -> "demo:api"; refs without a machine are taken as that machine's (resolved there). Another
 * machine's servers can't be in its profile.
 */
export function refsThere(machine: string, refs: unknown, opts: { there?: (ref: string) => boolean; here?: (ref: string) => boolean } = {}): string[] | undefined {
  if (refs === undefined || refs === null) return undefined;
  return [refs].flat().map((r) => {
    const ref = String(r);
    const split = splitRef(ref);
    if (split) {
      if (split.machine !== machine) throw new RefError(400, `${ref} is on ${split.machine}; a profile shared on ${machine} can only hold ${machine}'s servers of its repo`);
      return split.ref;
    }
    // A server of this machine (the hub) that the other one doesn't have: say so, rather than "not found there".
    if (opts.there && opts.here && !opts.there(ref) && opts.here(ref)) {
      throw new RefError(400, `${ref} is a server on this machine; a profile shared on ${machine} can only hold ${machine}'s servers of its repo. Use a profile of your own to mix machines.`);
    }
    return ref;
  });
}
