import * as React from "react"

import { CLIENT_ID, streamUrl, type ConfigSummary, type Configured, type Machine, type Profile, type Server } from "@/lib/api"

/** Live server state from the daemon's event stream. */
export function useServedev() {
  const [servers, setServers] = React.useState<Map<string, Server>>(new Map())
  const [configured, setConfigured] = React.useState<Configured[]>([])
  const [profiles, setProfiles] = React.useState<Profile[]>([])
  /** Config files and problems in them (a syntax error keeps the last good version in use). */
  const [config, setConfig] = React.useState<ConfigSummary | null>(null)
  const [connected, setConnected] = React.useState<boolean | null>(null)
  /** Last grid layout changed by someone else (an agent, the CLI, another tab). */
  const [layoutChange, setLayoutChange] = React.useState<{ scope: string; at: number } | null>(null)
  /** Bumped when platform accounts change (switched here, by an agent, or the CLI). */
  const [accountsVersion, setAccountsVersion] = React.useState(0)
  /** Other machines this servedev relays (a hub's); empty on a machine without any. */
  const [machines, setMachines] = React.useState<Map<string, Machine>>(new Map())

  React.useEffect(() => {
    const es = new EventSource(streamUrl("/api/stream/events"))
    es.addEventListener("snapshot", (e) => {
      const d = JSON.parse(e.data) as { build?: string; servers: Server[]; configured: Configured[]; profiles: Profile[]; config?: ConfigSummary; machines?: Machine[] }
      // The daemon was updated while this tab stayed open: load the new dashboard.
      const mine = document.querySelector<HTMLMetaElement>('meta[name="servedev-build"]')?.content
      if (d.build && mine && !mine.startsWith("{{") && d.build !== mine) {
        location.reload()
        return
      }
      setServers(new Map(d.servers.map((s) => [s.id, s])))
      setConfigured(d.configured)
      setProfiles(d.profiles ?? [])
      setConfig(d.config ?? null)
      setMachines(new Map((d.machines ?? []).map((m) => [m.name, m])))
      setConnected(true)
    })
    es.addEventListener("server", (e) => {
      const s = JSON.parse(e.data) as Server
      setServers((m) => new Map(m).set(s.id, s))
      setConfigured((c) => c.filter((x) => !(x.root === s.root && x.name === s.name)))
    })
    es.addEventListener("remove", (e) => {
      const { id } = JSON.parse(e.data) as { id: string }
      setServers((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
    })
    es.addEventListener("machine", (e) => {
      const m = JSON.parse(e.data) as Machine
      setMachines((all) => new Map(all).set(m.name, m))
    })
    es.addEventListener("machine-removed", (e) => {
      const { name } = JSON.parse(e.data) as { name: string }
      setMachines((all) => {
        const next = new Map(all)
        next.delete(name)
        return next
      })
    })
    es.addEventListener("profiles", (e) => setProfiles(JSON.parse(e.data) as Profile[]))
    es.addEventListener("config", (e) => setConfig(JSON.parse(e.data) as ConfigSummary))
    es.addEventListener("layout", (e) => {
      const { scope, source } = JSON.parse(e.data) as { scope: string; source: string | null }
      if (source !== CLIENT_ID) setLayoutChange({ scope, at: Date.now() })
    })
    es.addEventListener("accounts", () => setAccountsVersion((v) => v + 1))
    es.onerror = () => setConnected(false)
    return () => es.close()
  }, [])

  return { servers, configured, profiles, config, connected, layoutChange, accountsVersion, machines }
}

/** Current time, refreshed on an interval, for uptime labels. */
export function useNow(intervalMs = 10_000) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
