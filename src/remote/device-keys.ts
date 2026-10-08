/**
 * Per-device access keys: how other machines' servedev (hubs) get to control this one.
 *
 * A hub connects over SSH and runs `servedev keys issue --hub-id <id> --name <name>` here; that
 * makes a random key for that hub and keeps only its SHA-256 hash in device-keys.json. The hub
 * keeps the key (Keychain or a 0600 file) and sends it as x-servedev-token along with its hub id.
 * This machine's own token never leaves it, and each device can be told apart and revoked.
 *
 * A revoked device stays listed as revoked, and issuing it a new key is refused until it's allowed
 * again here: otherwise a hub would just get a new key on its next reconnect.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths";
import { cleanHubId, cleanHubName } from "./hubs";

export const DEVICE_KEYS_FILE = path.join(HOME, "device-keys.json");
export const KEY_PREFIX = "sdk_";
/** lastUsed is written at most this often per key. */
const TOUCH_EVERY = 60_000;

export interface DeviceKeyEntry {
  hubId: string;
  name: string;
  /** SHA-256 of the key, hex. Absent once revoked. */
  hash?: string;
  created: number;
  lastUsed?: number;
  /** When it was revoked; it can't get a new key until allowed again. */
  revoked?: number;
}

/** What's shown and returned by the API: everything but the hash. */
export type DeviceKeyView = Omit<DeviceKeyEntry, "hash">;

export class DeviceKeyError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export type Verified = { ok: true; entry: DeviceKeyEntry; hash: string } | { ok: false; reason: string };

export const hashKey = (key: string) => crypto.createHash("sha256").update(key).digest("hex");
export const isDeviceKey = (key: string | null | undefined): key is string => !!key && key.startsWith(KEY_PREFIX);
export const view = ({ hash: _hash, ...rest }: DeviceKeyEntry): DeviceKeyView => rest;
export const shortHubId = (id: string) => id.slice(0, 8);

/** Constant-time string comparison (for the master token). */
export function sameSecret(a: string, b: string): boolean {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

export class DeviceKeys {
  private entries: DeviceKeyEntry[] = [];
  /** mtime, size and inode of the file as last read; a change means someone (the CLI) wrote it. */
  private stamp = "unread";
  /** Hash -> lastUsed not yet written. */
  private used = new Map<string, number>();
  /** Called with the keys whenever they change (read again or written), e.g. to close a revoked key's streams. */
  onReload?: (entries: DeviceKeyEntry[]) => void;

  constructor(
    readonly file = DEVICE_KEYS_FILE,
    private now: () => number = Date.now,
  ) {}

  private statStamp(): string {
    try {
      const s = fs.statSync(this.file);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return "none";
    }
  }

  private readFile(): DeviceKeyEntry[] {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
    const list = (raw as { keys?: unknown })?.keys;
    if (!Array.isArray(list)) return [];
    return list.flatMap((e): DeviceKeyEntry[] => {
      const hubId = cleanHubId(e?.hubId);
      if (!hubId || typeof e.created !== "number") return [];
      return [
        {
          hubId,
          name: cleanHubName(e.name) ?? hubId,
          hash: typeof e.hash === "string" && /^[0-9a-f]{64}$/.test(e.hash) ? e.hash : undefined,
          created: e.created,
          lastUsed: typeof e.lastUsed === "number" ? e.lastUsed : undefined,
          revoked: typeof e.revoked === "number" ? e.revoked : undefined,
        },
      ];
    });
  }

  /** The keys as in the file, read again when the file changed. */
  current(): DeviceKeyEntry[] {
    const stamp = this.statStamp();
    if (stamp !== this.stamp) {
      this.entries = this.readFile();
      this.stamp = stamp;
      this.onReload?.(this.entries);
    }
    return this.entries;
  }

  list(): DeviceKeyView[] {
    return this.current()
      .map((e) => ({ ...e, lastUsed: Math.max(e.lastUsed ?? 0, (e.hash && this.used.get(e.hash)) || 0) || undefined }))
      .sort((a, b) => a.created - b.created)
      .map(view);
  }

  /**
   * Is this a valid key, sent by the hub it was issued to? Every stored hash is compared, in
   * constant time, so timing says nothing about which (if any) matched.
   */
  verify(key: string, hubIdHeader: string | null | undefined): Verified {
    if (!isDeviceKey(key)) return { ok: false, reason: "not an access key" };
    const given = Buffer.from(hashKey(key), "hex");
    let found: DeviceKeyEntry | undefined;
    for (const e of this.current()) {
      if (!e.hash) continue;
      if (crypto.timingSafeEqual(Buffer.from(e.hash, "hex"), given) && !found) found = e;
    }
    if (!found) return { ok: false, reason: "this device's access key isn't valid here (revoked or replaced)" };
    if (cleanHubId(hubIdHeader) !== found.hubId) return { ok: false, reason: "this access key belongs to another device" };
    return { ok: true, entry: found, hash: found.hash! };
  }

  /** Note that a key was used; written to the file at most once a minute per key. */
  touch(hash: string) {
    const t = this.now();
    this.used.set(hash, t);
    const e = this.entries.find((x) => x.hash === hash);
    if (e && t - (e.lastUsed ?? 0) < TOUCH_EVERY) return;
    try {
      this.edit((list) => {
        const entry = list.find((x) => x.hash === hash);
        if (entry) entry.lastUsed = t;
      });
    } catch {
      // Busy or unwritable: try again on a later request.
    }
  }

  /**
   * A new key for this hub, replacing any key it had. Refused for a revoked hub until it's allowed
   * again. Returns the key; only its hash is kept.
   */
  issue(rawHubId: string, rawName: string): { key: string; entry: DeviceKeyView; replaced: boolean } {
    const hubId = cleanHubId(rawHubId);
    if (!hubId) throw new DeviceKeyError(`invalid hub id "${rawHubId}" (expected 8-64 hex characters)`);
    const name = cleanHubName(rawName) ?? hubId;
    const key = KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
    let result!: { entry: DeviceKeyView; replaced: boolean };
    this.edit((list) => {
      const old = list.find((e) => e.hubId === hubId);
      if (old?.revoked) throw new DeviceKeyError(`${old.name} (${shortHubId(hubId)}) was revoked; allow it again first: servedev keys allow ${shortHubId(hubId)}`, 403);
      const entry: DeviceKeyEntry = { hubId, name, hash: hashKey(key), created: this.now() };
      if (old) list.splice(list.indexOf(old), 1, entry);
      else list.push(entry);
      result = { entry: view(entry), replaced: !!old };
    });
    return { key, ...result };
  }

  /** Revoke a device's key, by hub id (or its start) or name. It can't get a new key until allowed again. */
  revoke(ref: string): DeviceKeyView[] {
    let done: DeviceKeyView[] = [];
    this.edit((list) => {
      const matches = this.match(list.filter((e) => !e.revoked), ref, "revoke");
      for (const e of matches) {
        if (e.hash) this.used.delete(e.hash);
        delete e.hash;
        e.revoked = this.now();
      }
      done = matches.map(view);
    });
    return done;
  }

  /** Let a revoked device get a key again (it gets one on its next reconnect). */
  allow(ref: string): DeviceKeyView[] {
    let done: DeviceKeyView[] = [];
    this.edit((list) => {
      const matches = this.match(list.filter((e) => e.revoked), ref, "allow");
      for (const e of matches) list.splice(list.indexOf(e), 1);
      done = matches.map(view);
    });
    return done;
  }

  private match(list: DeviceKeyEntry[], rawRef: string, verb: string): DeviceKeyEntry[] {
    const ref = rawRef.trim();
    const lower = ref.toLowerCase();
    if (!ref) throw new DeviceKeyError(`pass a device's name or hub id to ${verb}`);
    const byId = list.filter((e) => e.hubId === lower);
    if (byId.length) return byId;
    const byName = list.filter((e) => e.name.toLowerCase() === lower);
    const byPrefix = lower.length >= 4 ? list.filter((e) => e.hubId.startsWith(lower)) : [];
    const found = byName.length ? byName : byPrefix;
    const what = verb === "allow" ? "revoked device" : "device with an access key";
    if (!found.length) {
      const known = list.map((e) => `${e.name} (${shortHubId(e.hubId)})`).join(", ");
      throw new DeviceKeyError(`no ${what} matches "${ref}"${known ? `; ${verb === "allow" ? "revoked" : "these have keys"}: ${known}` : ""}`, 404);
    }
    if (found.length > 1) throw new DeviceKeyError(`"${ref}" matches several devices (${found.map((e) => shortHubId(e.hubId)).join(", ")}); pass its hub id instead`, 409);
    return found;
  }

  /** Read, change and write the file under a lock (the CLI and the daemon both write it). */
  private edit(change: (list: DeviceKeyEntry[]) => void) {
    withLock(`${this.file}.lock`, () => {
      const list = this.readFile();
      change(list);
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, keys: list }, null, 2) + "\n", { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
      this.entries = list;
      this.stamp = this.statStamp();
      this.onReload?.(list);
    });
  }
}

/** A lock directory; one left behind by a crashed writer is taken over after a few seconds. */
function withLock(lock: string, fn: () => void) {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new DeviceKeyError(`${lock} is held by another servedev; try again`, 503);
      Bun.sleepSync(10);
    }
  }
  try {
    fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
