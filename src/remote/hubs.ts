/**
 * Which hubs are connected to this servedev. Each hub names itself on its requests and keeps the
 * live event stream open; a machine with two hubs has both forwarding its servers' ports, so the
 * second gets other port numbers. Hubs are told, so each can warn about the other.
 *
 * A hub sends its hostname (HUB_HEADER) and a random id kept in its SERVEDEV_HOME (HUB_ID_HEADER),
 * so two hubs with the same hostname still count as two. Older hubs send only the hostname; they
 * are counted by it, as before.
 */
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME } from "../paths";

export interface ConnectedHub {
  /**
   * How to show it: its hostname, plus the start of its id when another hub here has the same
   * hostname ("mac (3f9a1c)"). Older hubs compare it with their own hostname to leave themselves
   * out, so it has to differ for hubs that only share a hostname.
   */
  name: string;
  /** Its hostname as it sent it. */
  hostname: string;
  /** Its id; null for an older hub that doesn't send one. Always present, so hubs know this machine counts by id. */
  id: string | null;
  /** When its first open stream started. */
  since: number;
}

/** This machine's name as a hub: its hostname, without .local, as something safe to show. */
export function hubName(hostname = os.hostname()): string {
  return cleanHubName(hostname.replace(/\.local$/i, "")) ?? "unknown";
}

/** A hub name from a request header: short and printable, or undefined. */
export function cleanHubName(raw: string | null | undefined): string | undefined {
  const v = (raw ?? "").replace(/[^\w.-]/g, "").slice(0, 64);
  return v || undefined;
}

/** A hub id from a request header: hex, as hubId() makes them, or undefined. */
export function cleanHubId(raw: string | null | undefined): string | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  return /^[0-9a-f]{8,64}$/.test(v) ? v : undefined;
}

/** This servedev's hub id: random, made once and kept in its home next to the token. */
export function hubId(file = path.join(HOME, "hub-id")): string {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, crypto.randomBytes(8).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch {
    // already exists
  }
  return cleanHubId(fs.readFileSync(file, "utf8")) ?? "";
}

/** Shown after a hostname to tell hubs with the same one apart. */
const shortId = (id: string) => id.slice(0, 6);

/** Open event streams per hub (by id, or by hostname for older hubs). Emits "change" with the list when a hub comes or goes. */
export class HubTracker extends EventEmitter {
  private open = new Map<string, { hostname: string; id?: string; count: number; since: number }>();

  constructor(private now: () => number = Date.now) {
    super();
  }

  /** A hub's stream opened; call the returned function when it closes. */
  connect(hostname: string, id?: string): () => void {
    const key = id ? `id:${id}` : `name:${hostname}`;
    const entry = this.open.get(key);
    if (entry) {
      entry.count++;
      entry.hostname = hostname;
    } else {
      this.open.set(key, { hostname, id, count: 1, since: this.now() });
      this.emit("change", this.list());
    }
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const e = this.open.get(key);
      if (!e || --e.count > 0) return;
      this.open.delete(key);
      this.emit("change", this.list());
    };
  }

  list(): ConnectedHub[] {
    const entries = [...this.open.values()].sort((a, b) => a.since - b.since);
    const shared = (h: string) => entries.filter((e) => e.hostname === h).length > 1;
    return entries.map((e) => ({
      name: e.id && shared(e.hostname) ? `${e.hostname} (${shortId(e.id)})` : e.hostname,
      hostname: e.hostname,
      id: e.id ?? null,
      since: e.since,
    }));
  }
}

/**
 * The other hubs in a machine's list (not this one), by the name to show; anything malformed is
 * ignored. A machine that counts by id says so with `id` on every entry, and this hub is the one
 * with its id; an older one lists hostnames only, so this hub is the one with its hostname.
 */
export function otherHubs(list: unknown, self: { name?: string; id?: string } | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((h) => {
    if (!h || typeof h !== "object" || typeof h.name !== "string") return [];
    const mine = "id" in h ? !!self?.id && h.id === self.id : h.name === self?.name;
    return mine ? [] : [h.name];
  });
}

/** The warning for a machine another hub is connected to as well. */
export function otherHubsWarning(machine: string, hubs: string[]): string | undefined {
  if (!hubs.length) return undefined;
  const who = hubs.length === 1 ? `another hub, ${hubs[0]},` : `other hubs (${hubs.join(", ")}) are`;
  return `${who}${hubs.length === 1 ? " is" : ""} connected to ${machine} too: each forwards its servers' ports, so some may have other port numbers here`;
}
