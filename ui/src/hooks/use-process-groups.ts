import * as React from "react"

import { api, type ProcessGroup } from "@/lib/api"

/** Live process groups for a server; polls while `enabled`. */
export function useProcessGroups(serverId: string | undefined, enabled: boolean, intervalMs = 2000) {
  const [groups, setGroups] = React.useState<ProcessGroup[] | null>(null)
  // Start over whenever what's polled changes.
  const key = `${serverId}|${enabled}|${intervalMs}`
  const [polled, setPolled] = React.useState(key)
  if (polled !== key) {
    setPolled(key)
    setGroups(null)
  }
  React.useEffect(() => {
    if (!serverId || !enabled) return
    let cancelled = false
    const load = () =>
      api<{ groups: ProcessGroup[] }>(`/api/processes?${new URLSearchParams({ id: serverId })}`)
        .then((r) => !cancelled && setGroups(r.groups))
        .catch(() => {})
    void load()
    const t = setInterval(load, intervalMs)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [serverId, enabled, intervalMs])
  return groups
}
