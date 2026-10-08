import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DeviceKeys, hashKey, isDeviceKey } from "../src/remote/device-keys";
import { parseServedevProbe, servedevProbe } from "../src/remote/setup";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sd-keys-"));
  dirs.push(d);
  return d;
}

const MAC = "aaaa1111bbbb2222";
const LAPTOP = "cccc3333dddd4444";

test("issuing: a random sdk_ key; only its hash is kept, in a 0600 file", () => {
  const file = path.join(tmp(), "device-keys.json");
  const keys = new DeviceKeys(file, () => 1000);
  const { key, entry, replaced } = keys.issue(MAC, "Seans-Mac");
  expect(key).toMatch(/^sdk_[A-Za-z0-9_-]{43}$/);
  expect(isDeviceKey(key)).toBe(true);
  expect(entry).toEqual({ hubId: MAC, name: "Seans-Mac", created: 1000, lastUsed: undefined, revoked: undefined } as never);
  expect(replaced).toBe(false);
  const raw = fs.readFileSync(file, "utf8");
  expect(raw).not.toContain(key);
  expect(JSON.parse(raw).keys[0]).toMatchObject({ hubId: MAC, name: "Seans-Mac", hash: hashKey(key), created: 1000 });
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  // No temp or lock files left behind.
  expect(fs.readdirSync(path.dirname(file))).toEqual(["device-keys.json"]);
  expect(() => keys.issue("not hex!", "x")).toThrow(/invalid hub id/);
});

test("verifying: the right key from the hub it was issued to; nothing else", () => {
  const keys = new DeviceKeys(path.join(tmp(), "device-keys.json"));
  const mac = keys.issue(MAC, "mac").key;
  const laptop = keys.issue(LAPTOP, "laptop").key;
  expect(keys.verify(mac, MAC)).toMatchObject({ ok: true, entry: { hubId: MAC, name: "mac" } });
  expect(keys.verify(laptop, LAPTOP.toUpperCase())).toMatchObject({ ok: true });
  // Another hub's id, or none: a key copied to another device doesn't work there.
  expect(keys.verify(mac, LAPTOP)).toEqual({ ok: false, reason: "this access key belongs to another device" });
  expect(keys.verify(mac, null)).toMatchObject({ ok: false });
  expect(keys.verify("sdk_madeup", MAC)).toMatchObject({ ok: false, reason: expect.stringContaining("isn't valid") });
  expect(keys.verify("plain-token", MAC)).toMatchObject({ ok: false });
});

test("re-issuing for the same hub replaces its key; the old one stops working", () => {
  const keys = new DeviceKeys(path.join(tmp(), "device-keys.json"));
  const first = keys.issue(MAC, "mac").key;
  const second = keys.issue(MAC, "mac-renamed");
  expect(second.replaced).toBe(true);
  expect(keys.verify(first, MAC).ok).toBe(false);
  expect(keys.verify(second.key, MAC).ok).toBe(true);
  expect(keys.list().map((k) => k.name)).toEqual(["mac-renamed"]);
});

test("revoking: by name, hub id or its start; the key stops working, and no new key until allowed again", () => {
  const file = path.join(tmp(), "device-keys.json");
  const keys = new DeviceKeys(file);
  const mac = keys.issue(MAC, "mac").key;
  const laptop = keys.issue(LAPTOP, "laptop").key;
  expect(keys.revoke("MAC").map((k) => k.hubId)).toEqual([MAC]);
  expect(keys.verify(mac, MAC).ok).toBe(false);
  expect(keys.verify(laptop, LAPTOP).ok).toBe(true);
  expect(keys.list().find((k) => k.hubId === MAC)?.revoked).toBeNumber();
  // A revoked device can't just get a new key on its next reconnect.
  expect(() => keys.issue(MAC, "mac")).toThrow(/was revoked/);
  expect(() => keys.revoke("mac")).toThrow(/no device with an access key matches "mac"/);
  expect(() => keys.revoke("ab")).toThrow(/no device/);
  expect(keys.revoke("cccc33").map((k) => k.name)).toEqual(["laptop"]);
  // Allowed again: it can get a key.
  expect(keys.allow(MAC).map((k) => k.name)).toEqual(["mac"]);
  expect(keys.issue(MAC, "mac").key).toStartWith("sdk_");
  expect(() => keys.allow("nobody")).toThrow(/no revoked device/);
});

test("two devices with the same name: revoking by name asks for the hub id", () => {
  const keys = new DeviceKeys(path.join(tmp(), "device-keys.json"));
  keys.issue(MAC, "mac");
  keys.issue(LAPTOP, "mac");
  expect(() => keys.revoke("mac")).toThrow(/matches several devices/);
  expect(keys.revoke(LAPTOP)).toHaveLength(1);
});

test("a key issued by another process (the CLI) works at once; one it revokes stops at once and reports it", () => {
  const file = path.join(tmp(), "device-keys.json");
  const daemon = new DeviceKeys(file);
  const reloads: number[] = [];
  daemon.onReload = (entries) => reloads.push(entries.length);
  expect(daemon.list()).toEqual([]);
  const cli = new DeviceKeys(file);
  const key = cli.issue(MAC, "mac").key;
  expect(daemon.verify(key, MAC).ok).toBe(true);
  new DeviceKeys(file).revoke(MAC);
  expect(daemon.verify(key, MAC).ok).toBe(false);
  expect(reloads.length).toBeGreaterThanOrEqual(3);
});

test("lastUsed is kept, written at most once a minute", () => {
  const file = path.join(tmp(), "device-keys.json");
  let now = 1000;
  const keys = new DeviceKeys(file, () => now);
  const key = keys.issue(MAC, "mac").key;
  const v = keys.verify(key, MAC);
  if (!v.ok) throw new Error("expected a valid key");
  now = 70_000;
  keys.touch(v.hash);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).keys[0].lastUsed).toBe(70_000);
  now = 80_000;
  keys.touch(v.hash);
  // Not written yet, but shown.
  expect(JSON.parse(fs.readFileSync(file, "utf8")).keys[0].lastUsed).toBe(70_000);
  expect(keys.list()[0].lastUsed).toBe(80_000);
  now = 140_000;
  keys.touch(v.hash);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).keys[0].lastUsed).toBe(140_000);
});

test("a corrupt or missing file means no keys, not a crash", () => {
  const file = path.join(tmp(), "device-keys.json");
  expect(new DeviceKeys(file).list()).toEqual([]);
  fs.writeFileSync(file, "{nope");
  expect(new DeviceKeys(file).list()).toEqual([]);
  fs.writeFileSync(file, JSON.stringify({ keys: [{ hubId: "zz", created: 1 }, { hubId: MAC, name: "m", created: 2, hash: "short" }] }));
  const keys = new DeviceKeys(file);
  expect(keys.list().map((k) => k.hubId)).toEqual([MAC]);
  expect(keys.verify("sdk_x", MAC).ok).toBe(false);
});

// ---------- the probe, run by a real shell against a stand-in servedev ----------

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

/** A `servedev` on PATH: the real `keys` command (new), or one that doesn't know it (old). */
function fakeServedev(kind: "new" | "old"): { bin: string; home: string } {
  const dir = tmp();
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "token"), "the-master-token");
  const keys =
    kind === "new"
      ? `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"`
      : `echo "servedev: Unknown option '--hub-id'. To specify a positional argument starting with a '-', place it at the end" >&2; exit 1`;
  fs.writeFileSync(
    path.join(dir, "servedev"),
    `#!/bin/bash
case "$1" in
  --version) echo 0.3.0 ;;
  config) ;;
  daemon) echo "daemon 0.3.0 running (pid 42) at http://127.0.0.1:7777; log: x" ;;
  keys) ${keys} ;;
esac
`,
    { mode: 0o755 },
  );
  return { bin: dir, home };
}

function runProbe(s: { bin: string; home: string }, hub: { id?: string; name?: string }) {
  const r = Bun.spawnSync(["bash", "-c", servedevProbe(hub)], {
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, SERVEDEV_HOME: s.home, SERVEDEV_PORT: "1" },
  });
  return parseServedevProbe(r.stdout.toString());
}

test("probe on a current servedev: a key is issued to this hub, and the machine's token isn't read", () => {
  const s = fakeServedev("new");
  const p = runProbe(s, { id: MAC, name: "Seans-Mac" });
  expect(p).toMatchObject({ running: true, port: 7777, legacy: false, token: undefined, revoked: undefined });
  expect(p.key).toStartWith("sdk_");
  const keys = new DeviceKeys(path.join(s.home, "device-keys.json"));
  expect(keys.verify(p.key!, MAC)).toMatchObject({ ok: true, entry: { name: "Seans-Mac" } });

  // Revoked there: refused, and still no token.
  keys.revoke(MAC);
  const again = runProbe(s, { id: MAC, name: "Seans-Mac" });
  expect(again).toMatchObject({ key: undefined, token: undefined, legacy: false });
  expect(again.revoked).toContain("was revoked");
});

test("probe on an older servedev without `keys`: falls back to its token", () => {
  const p = runProbe(fakeServedev("old"), { id: MAC, name: "mac" });
  expect(p).toMatchObject({ key: undefined, legacy: true, token: "the-master-token" });
  expect(p.keyError).toContain("Unknown option");
});

test("probe without a hub id (or with junk in the name) stays safe", () => {
  expect(runProbe(fakeServedev("new"), {})).toMatchObject({ legacy: true, token: "the-master-token" });
  // The name is cleaned to [\w.-] before it goes into the script.
  expect(servedevProbe({ id: MAC, name: "x'; rm -rf ~; '" })).toContain("--name 'xrm-rf'");
});
