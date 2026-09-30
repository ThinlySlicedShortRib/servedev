import * as React from "react"

import { CLIENT_ID, streamUrl, type Configured, type Profile, type Server } from "@/lib/api"

/** Live server state from the daemon's event stream. */
export function useServedev() {
  const [servers, setServers] = React.useState<Map<string, Server>>(new Map())
  const [configured, setConfigured] = React.useState<Configured[]>([])
  const [profiles, setProfiles] = React.useState<Profile[]>([])
  const [connected, setConnected] = React.useState<boolean | null>(null)
  /** Last grid layout changed by someone else (an agent, the CLI, another tab). */
  const [layoutChange, setLayoutChange] = React.useState<{ scope: string; at: number } | null>(null)
  /** Bumped when platform accounts change (switched here, by an agent, or the CLI). */
  const [accountsVersion, setAccountsVersion] = React.useState(0)

  React.useEffect(() => {
    const es = new EventSource(streamUrl("/api/stream/events"))
    es.addEventListener("snapshot", (e) => {
      const d = JSON.parse(e.data) as { build?: string; servers: Server[]; configured: Configured[]; profiles: Profile[] }
      // The daemon was updated while this tab stayed open: load the new dashboard.
      const mine = document.querySelector<HTMLMetaElement>('meta[name="servedev-build"]')?.content
      if (d.build && mine && !mine.startsWith("{{") && d.build !== mine) {
        location.reload()
        return
      }
      setServers(new Map(d.servers.map((s) => [s.id, s])))
      setConfigured(d.configured)
      setProfiles(d.profiles ?? [])
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
    es.addEventListener("profiles", (e) => setProfiles(JSON.parse(e.data) as Profile[]))
    es.addEventListener("layout", (e) => {
      const { scope, source } = JSON.parse(e.data) as { scope: string; source: string | null }
      if (source !== CLIENT_ID) setLayoutChange({ scope, at: Date.now() })
    })
    es.addEventListener("accounts", () => setAccountsVersion((v) => v + 1))
    es.onerror = () => setConnected(false)
    return () => es.close()
  }, [])

  return { servers, configured, profiles, connected, layoutChange, accountsVersion }
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
