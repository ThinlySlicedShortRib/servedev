import { expect, test } from "bun:test";

import type { ProfileView } from "../src/config";
import type { PublicServer } from "../src/manager";
import { refsThere, remoteProfileView, sharedOn, withRemoteMembers, type MachineLookup } from "../src/remote/profiles";

const server = (id: string): PublicServer => ({ id, name: id.split(":")[1], project: id.split(":")[0], status: "stopped", ports: [] }) as unknown as PublicServer;

function profile(over: Partial<ProfileView>): ProfileView {
  return {
    id: "local:Full stack",
    name: "Full stack",
    kind: "local",
    servers: [],
    skipped: [],
    members: [],
    missing: [],
    accounts: {},
    file: "/x/config.json",
    version: "v",
    grid: { source: null, hasRepoDefault: false, hasOverride: false },
    ...over,
  };
}

test("your profiles: other machines' refs get full ids, keep their order, and are unavailable while the machine is away", () => {
  const machines: Record<string, MachineLookup> = {
    pc: { name: "pc", connected: true, servers: [server("demo:api"), server("demo:docs")] },
    lab: { name: "lab", connected: false, servers: [server("ml:train")] },
  };
  const p = withRemoteMembers(
    profile({ members: ["pc/api", "app:web", "lab/ml:train", "lab/ml:never-seen", "pc/demo:gone", "pc/demo:api"], missing: ["nas/x:y"] }),
    (n) => machines[n],
  );
  expect(p.servers).toEqual(["pc/demo:api", "app:web", "lab/ml:train", "lab/ml:never-seen"]);
  expect(p.members).toEqual(p.servers);
  // Gone from a connected machine: missing. Not seen on an offline one: kept as written.
  expect(p.missing).toEqual(["nas/x:y", "pc/demo:gone"]);
  expect(p.unavailable).toEqual(["lab/ml:train", "lab/ml:never-seen"]);
  // A machine that was removed: its refs are missing (kept in the file).
  expect(withRemoteMembers(profile({ members: ["old/a:b"] }), () => undefined).missing).toEqual(["old/a:b"]);
  // Nothing remote: the same object.
  const plain = profile({ members: ["app:web"], servers: ["app:web"] });
  expect(withRemoteMembers(plain, () => undefined)).toBe(plain);
});

test("a machine's shared profiles: pc/ ids, its machine, unavailable while it's away; its own and relayed ones aren't shown", () => {
  const shared = profile({ id: "demo:Demo/stack", name: "Demo/stack", kind: "shared", project: "demo", servers: ["demo:api"], members: ["demo:api", "demo:docs"], skipped: ["demo:docs"] });
  const v = remoteProfileView("pc", true, shared);
  expect(v).toMatchObject({ id: "pc/demo:Demo/stack", servers: ["pc/demo:api"], members: ["pc/demo:api", "pc/demo:docs"], skipped: ["pc/demo:docs"], machine: "pc", unavailable: [] });
  expect(remoteProfileView("pc", false, shared).unavailable).toEqual(["pc/demo:api", "pc/demo:docs"]);
  const theirs = profile({ id: "local:Mine" });
  const relayed = { ...shared, id: "lab/x:y", machine: "lab" };
  expect(sharedOn([shared, theirs, relayed]).map((p) => p.id)).toEqual(["demo:Demo/stack"]);
});

test("refs for a profile shared on another machine are in its terms; other machines' and the hub's servers are refused", () => {
  expect(refsThere("pc", ["pc/demo:api", "docs"])).toEqual(["demo:api", "docs"]);
  expect(refsThere("pc", "pc/api")).toEqual(["api"]);
  expect(refsThere("pc", undefined)).toBeUndefined();
  expect(() => refsThere("pc", ["lab/ml:train"])).toThrow(/lab/);
  const opts = { there: (r: string) => r === "docs", here: (r: string) => r === "web" };
  expect(refsThere("pc", ["docs", "unknown"], opts)).toEqual(["docs", "unknown"]);
  expect(() => refsThere("pc", ["web"], opts)).toThrow(/server on this machine/);
});
