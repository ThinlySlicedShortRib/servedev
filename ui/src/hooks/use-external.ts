import * as React from "react"

import { api, type ExternalServer } from "@/lib/api"

/** Dev servers running outside servedev; rescanned every 10 seconds and on demand. */
export function useExternalServers(enabled: boolean) {
  const [servers, setServers] = React.useState<ExternalServer[]>([])
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = () =>
      api<{ servers: ExternalServer[] }>("/api/external")
        .then((r) => !cancelled && setServers(r.servers))
        .catch(() => {})
    void load()
    const t = setInterval(load, 10_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [enabled, tick])
  return { servers, refresh: () => setTick((t) => t + 1) }
}
