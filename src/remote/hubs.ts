/**
 * Which hubs are connected to this servedev. Each hub names itself (HUB_HEADER) on its requests
 * and keeps the live event stream open; a machine with two hubs has both forwarding its servers'
 * ports, so the second gets other port numbers. Hubs are told, so each can warn about the other.
 */
import { EventEmitter } from "node:events";
import os from "node:os";

export interface ConnectedHub {
  name: string;
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

/** Open event streams per hub. Emits "change" with the list when a hub comes or goes. */
export class HubTracker extends EventEmitter {
  private open = new Map<string, { count: number; since: number }>();

  constructor(private now: () => number = Date.now) {
    super();
  }

  /** A hub's stream opened; call the returned function when it closes. */
  connect(name: string): () => void {
    const entry = this.open.get(name);
    if (entry) entry.count++;
    else {
      this.open.set(name, { count: 1, since: this.now() });
      this.emit("change", this.list());
    }
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const e = this.open.get(name);
      if (!e || --e.count > 0) return;
      this.open.delete(name);
      this.emit("change", this.list());
    };
  }

  list(): ConnectedHub[] {
    return [...this.open].map(([name, e]) => ({ name, since: e.since })).sort((a, b) => a.since - b.since);
  }
}

/** The other hubs in a machine's list (not this one); anything malformed is ignored. */
export function otherHubs(list: unknown, self: string | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((h) => (h && typeof h === "object" && typeof h.name === "string" && h.name !== self ? [h.name] : []));
}

/** The warning for a machine another hub is connected to as well. */
export function otherHubsWarning(machine: string, hubs: string[]): string | undefined {
  if (!hubs.length) return undefined;
  const who = hubs.length === 1 ? `another hub, ${hubs[0]},` : `other hubs (${hubs.join(", ")}) are`;
  return `${who}${hubs.length === 1 ? " is" : ""} connected to ${machine} too: each forwards its servers' ports, so some may have other port numbers here`;
}
