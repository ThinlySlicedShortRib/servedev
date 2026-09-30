import * as React from "react"

import { cleanLog } from "@/hooks/use-log-stream"
import { streamUrl } from "@/lib/api"

const MAX_CHARS = 60_000

/** Live log tails for several servers over one connection. Returns cleaned text per server id. */
export function useMultiLogStream(ids: string[]): Record<string, string> {
  const [raw, setRaw] = React.useState<Record<string, string>>({})
  const key = [...ids].sort().join(",")

  React.useEffect(() => {
    setRaw({})
    if (!key) return
    const es = new EventSource(streamUrl("/api/stream/logs-multi", { ids: key }))
    es.addEventListener("reset", (e) => {
      const { id } = JSON.parse(e.data) as { id: string }
      setRaw((r) => ({ ...r, [id]: "" }))
    })
    es.addEventListener("data", (e) => {
      const { id, text } = JSON.parse(e.data) as { id: string; text: string }
      setRaw((r) => {
        const next = (r[id] ?? "") + text
        return { ...r, [id]: next.length > MAX_CHARS ? next.slice(-MAX_CHARS * 0.7) : next }
      })
    })
    return () => es.close()
  }, [key])

  return React.useMemo(() => Object.fromEntries(Object.entries(raw).map(([id, t]) => [id, cleanLog(t)])), [raw])
}
