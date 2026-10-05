import * as React from "react"

import { streamUrl } from "@/lib/api"

// eslint-disable-next-line no-control-regex -- matching escape codes is the point
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const MAX_CHARS = 600_000

/** Strip escape codes and collapse carriage-return progress output. */
export function cleanLog(text: string) {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, "").split("\r").pop() ?? "")
    .join("\n")
}

/** Live log text for a server; resets when the server restarts. */
export function useLogStream(id: string | undefined) {
  const [log, setLog] = React.useState<{ id?: string; text: string }>({ id, text: "" })
  // Another server (or none) starts from nothing.
  if (log.id !== id) setLog({ id, text: "" })

  React.useEffect(() => {
    if (!id) return
    const es = new EventSource(streamUrl("/api/stream/logs", { id }))
    es.addEventListener("reset", () => setLog((l) => (l.id === id ? { id, text: "" } : l)))
    es.addEventListener("data", (e) => {
      const chunk = JSON.parse(e.data) as string
      setLog((l) => {
        if (l.id !== id) return l
        const next = l.text + chunk
        return { id, text: next.length > MAX_CHARS ? next.slice(-MAX_CHARS * 0.7) : next }
      })
    })
    return () => es.close()
  }, [id])

  return React.useMemo(() => cleanLog(log.text), [log.text])
}
