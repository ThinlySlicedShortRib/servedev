import { expect, test } from "bun:test"

import type { Machine, Server } from "../ui/src/lib/api"
import { filterGroups, groupEntries, viewEntries } from "../ui/src/lib/entries"
import { hostLabel, localPortOf, machineKind, machineSections, remoteHostname, remotePathProblem, remotePortOf, suggestMachineName, unavailableReason, worstState } from "../ui/src/lib/machines"
import { hostAliases, hostLabel as hubHostLabel } from "../src/remote/ids"

function server(id: string, status: Server["status"], extra: Partial<Server> = {}): Server {
  const [, project, name] = /^(?:[\w-]+\/)?([^:]+):(.+)$/.exec(id)!
  return { id, name, project, root: "/r", command: "x", cwd: "/r", status, ports: [], logFile: "", restarts: 0, ...extra }
}

function machine(name: string, extra: Partial<Machine> = {}): Machine {
  return {
    name,
    ssh: `me@${name}`,
    state: "connected",
    attempt: 0,
    hubVersion: "0.2.0",
    versionMismatch: false,
    counts: { total: 0, running: 0, crashed: 0 },
    forwards: [],
    ...extra,
  }
}

const servers = new Map(
  [
    server("demo:api", "running"),
    server("demo:web", "stopped", { pinned: true }),
    server("pc/demo:api", "running", { machine: "pc", pinned: true }),
    server("pc/demo:worker", "crashed", { machine: "pc" }),
    server("pc/shop:store", "stopped", { machine: "pc" }),
    server("nas/photos:web", "running", { machine: "nas", stale: true }),
  ].map((s) => [s.id, s])
)

test("groupEntries: the same project on two machines is two groups, this machine's first", () => {
  const groups = groupEntries(servers, [])
  expect(groups.map(([p, es]) => `${es[0].server?.machine ?? "-"}/${p}:${es.length}`)).toEqual(["-/demo:2", "pc/demo:2", "nas/photos:1", "pc/shop:1"])
})

test("viewEntries: only this machine's pinned servers are listed apart", () => {
  const { pinned, groups } = viewEntries(groupEntries(servers, []), undefined)
  expect(pinned.map((e) => e.key)).toEqual(["demo:web"])
  expect(groups.flatMap(([, es]) => es.map((e) => e.key))).toContain("pc/demo:api")
})

test("machineSections: this machine first, then each remote one with its projects and counts", () => {
  const { groups } = viewEntries(groupEntries(servers, []), undefined)
  const sections = machineSections(groups, [machine("nas", { state: "offline" }), machine("pc"), machine("idle")])
  expect(sections.map((s) => s.machine?.name ?? "local")).toEqual(["local", "nas", "pc", "idle"])
  expect(sections[0].groups.map(([p]) => p)).toEqual(["demo"])
  expect(sections[2].groups.map(([p]) => p)).toEqual(["demo", "shop"])
  expect(sections[2].counts).toEqual({ total: 3, running: 1, crashed: 1 })
  // An offline machine's servers count by their last known state.
  expect(sections[1].counts).toEqual({ total: 1, running: 1, crashed: 0 })
  // A machine without servers still has a section.
  expect(sections[3]).toMatchObject({ groups: [], counts: { total: 0, running: 0, crashed: 0 } })
})

test("search matches a machine's name", () => {
  const hits = filterGroups(groupEntries(servers, []), "pc", "all")
  expect(hits.flatMap(([, es]) => es.map((e) => e.key)).sort()).toEqual(["pc/demo:api", "pc/demo:worker", "pc/shop:store"])
  expect(filterGroups(groupEntries(servers, []), "", "running").flatMap(([, es]) => es.map((e) => e.key))).toContain("nas/photos:web")
})

test("remote ports: its own port there, and where it's forwarded here", () => {
  const s = server("pc/demo:api", "running", {
    machine: "pc",
    remoteUrl: "http://localhost:3000",
    url: "http://127.0.0.1:35733",
    ports: [3000, 9229],
    forwards: [
      { remotePort: 3000, localPort: 35733 },
      { remotePort: 9229, localPort: 9229 },
    ],
  })
  expect(remotePortOf(s)).toBe(3000)
  expect(localPortOf(s)).toBe(35733)
  // Offline: no URL or forwards, just the port it had.
  expect(remotePortOf(server("pc/demo:docs", "running", { machine: "pc", ports: [3001], stale: true }))).toBe(3001)
  expect(localPortOf(server("pc/demo:docs", "running", { machine: "pc", ports: [3001], stale: true }))).toBeUndefined()
})

test("machine labels, names and the header dot", () => {
  expect(machineKind({ kind: "wsl", distro: "Ubuntu", os: "Ubuntu 26.04.1 LTS (WSL on Windows)" })).toBe("WSL Ubuntu")
  expect(machineKind({ kind: "posix", os: "macOS 15.1" })).toBe("macOS")
  expect(machineKind({ kind: "posix", os: "Debian GNU/Linux 12 (bookworm)" })).toBe("Debian")
  expect(suggestMachineName("ariel@pc.tail3a9f.ts.net")).toBe("pc")
  expect(suggestMachineName("ariel@100.68.42.78")).toBe("")
  expect(suggestMachineName("Build_Box")).toBe("build-box")
  expect(worstState([machine("a"), machine("b", { state: "offline" })])).toBe("offline")
  expect(worstState([machine("a", { state: "reconnecting" }), machine("b", { state: "offline" })])).toBe("reconnecting")
  expect(worstState([machine("a")])).toBeNull()
})

test("new server on a machine: the hostname it gets here matches the hub's", () => {
  for (const n of ["web", "API_v2", "my docs", "--x--", ""]) expect(hostLabel(n)).toBe(hubHostLabel(n))
  const list = [server("pc/demo:api", "running", { machine: "pc" }), server("demo:web", "running")]
  expect(remoteHostname("pc", "web", "shop", list)).toBe("web.pc.localhost")
  // Another project there has an "api": both get their project in the name, as the hub does.
  expect(remoteHostname("pc", "api", "shop", list)).toBe("api.shop.pc.localhost")
  expect(hostAliases("pc", [{ id: "demo:api", name: "api", project: "demo" }, { id: "shop:api", name: "api", project: "shop" }]).get("shop:api")).toBe("api.shop.pc.localhost")
  // The same server again keeps its plain name.
  expect(remoteHostname("pc", "api", "demo", list)).toBe("api.pc.localhost")
})

test("new server on a machine: paths there must be absolute or under ~; only connected machines can take one", () => {
  expect(remotePathProblem("~/code/app", "pc")).toBeUndefined()
  expect(remotePathProblem("/mnt/c/code", "pc")).toBeUndefined()
  expect(remotePathProblem("", "pc")).toBeUndefined()
  expect(remotePathProblem("code/app", "pc")).toMatch(/full path on pc/)
  expect(unavailableReason(machine("pc"))).toBeUndefined()
  expect(unavailableReason(machine("pc", { state: "reconnecting", attempt: 2 }))).toBe("reconnecting (attempt 2)…")
  expect(unavailableReason(machine("pc", { state: "offline" }))).toBe("offline")
})
