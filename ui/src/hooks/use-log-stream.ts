import * as React from "react"

import { streamUrl } from "@/lib/api"

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
  const [text, setText] = React.useState("")

  React.useEffect(() => {
    setText("")
    if (!id) return
    const es = new EventSource(streamUrl("/api/stream/logs", { id }))
    es.addEventListener("reset", () => setText(""))
    es.addEventListener("data", (e) => {
      const chunk = JSON.parse(e.data) as string
      setText((t) => {
        const next = t + chunk
        return next.length > MAX_CHARS ? next.slice(-MAX_CHARS * 0.7) : next
      })
    })
    return () => es.close()
  }, [id])

  return React.useMemo(() => cleanLog(text), [text])
}
