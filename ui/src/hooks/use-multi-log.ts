import * as React from "react"

import { cleanLog } from "@/hooks/use-log-stream"
import { streamUrl } from "@/lib/api"

const MAX_CHARS = 60_000

/** Live log tails for several servers over one connection. Returns cleaned text per server id. */
export function useMultiLogStream(ids: string[]): Record<string, string> {
  const key = [...ids].sort().join(",")
  const [logs, setLogs] = React.useState<{ key: string; raw: Record<string, string> }>({ key, raw: {} })
  // Another set of servers starts from nothing.
  if (logs.key !== key) setLogs({ key, raw: {} })

  React.useEffect(() => {
    if (!key) return
    const es = new EventSource(streamUrl("/api/stream/logs-multi", { ids: key }))
    es.addEventListener("reset", (e) => {
      const { id } = JSON.parse(e.data) as { id: string }
      setLogs((l) => (l.key === key ? { key, raw: { ...l.raw, [id]: "" } } : l))
    })
    es.addEventListener("data", (e) => {
      const { id, text } = JSON.parse(e.data) as { id: string; text: string }
      setLogs((l) => {
        if (l.key !== key) return l
        const next = (l.raw[id] ?? "") + text
        return { key, raw: { ...l.raw, [id]: next.length > MAX_CHARS ? next.slice(-MAX_CHARS * 0.7) : next } }
      })
    })
    return () => es.close()
  }, [key])

  const raw = logs.raw
  return React.useMemo(() => Object.fromEntries(Object.entries(raw).map(([id, t]) => [id, cleanLog(t)])), [raw])
}
