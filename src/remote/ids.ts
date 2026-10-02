/**
 * Server ids across machines. Local ids stay "<project>:<name>"; a remote machine's servers get its
 * name in front: "pc/demo:api". Project labels and server names can't contain "/", so the slash
 * alone says a reference is remote.
 */

/** Machine names end up in ids and hostnames (api.pc.localhost), so they're hostname labels. */
export const MACHINE_NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

export function assertMachineName(name: string) {
  if (!MACHINE_NAME.test(name)) {
    throw new Error(`"${name}" can't be a machine name: use lowercase letters, digits and dashes (it becomes part of ids like ${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "pc"}/web:api and hostnames)`);
  }
}

export function remoteId(machine: string, id: string): string {
  return `${machine}/${id}`;
}

/** "pc/demo:api" -> { machine: "pc", ref: "demo:api" }; "pc/api" -> { machine: "pc", ref: "api" }; local refs -> undefined. */
export function splitRef(ref: string | undefined | null): { machine: string; ref: string } | undefined {
  if (!ref) return undefined;
  const i = ref.indexOf("/");
  if (i <= 0) return undefined;
  return { machine: ref.slice(0, i), ref: ref.slice(i + 1) };
}

export interface RefTarget {
  id: string;
  name: string;
  project: string;
}

/**
 * A reference within one machine's servers: a full id, or a name that only one server there has.
 * Mirrors the daemon's resolveRef, which can't run on the remote's data from here.
 */
export function resolveRemoteRef<T extends RefTarget>(machine: string, ref: string, servers: T[]): T {
  if (!ref) throw new RefError(400, `pass a server on ${machine}, e.g. ${machine}/${servers[0]?.id ?? "project:name"}`);
  const byId = servers.find((s) => s.id === ref);
  if (byId) return byId;
  const named = servers.filter((s) => s.name === ref);
  if (named.length === 1) return named[0];
  const known = servers.map((s) => `${machine}/${s.id}`).join(", ") || "none";
  if (named.length > 1) throw new RefError(409, `several servers on ${machine} are called "${ref}"; use the full id: ${named.map((s) => `${machine}/${s.id}`).join(", ")}`);
  throw new RefError(404, `no server "${ref}" on ${machine}. Known servers there: ${known}`);
}

export class RefError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A DNS label from a server or project name: "API_v2" -> "api-v2". */
export function hostLabel(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "server"
  );
}

/**
 * Hub hostnames for a machine's servers: "<server>.<machine>.localhost", or
 * "<server>.<project>.<machine>.localhost" for names that more than one project on it uses.
 */
export function hostAliases(machine: string, servers: RefTarget[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const s of servers) count.set(hostLabel(s.name), (count.get(hostLabel(s.name)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const s of servers) {
    const name = hostLabel(s.name);
    out.set(s.id, count.get(name)! > 1 ? `${name}.${hostLabel(s.project)}.${machine}.localhost` : `${name}.${machine}.localhost`);
  }
  return out;
}
