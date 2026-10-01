import * as React from "react"

export type StatusFx = "ready" | "crash" | null

/**
 * Purely visual (Friendly style): notices when a status changes while it's on screen and returns a
 * one-off effect: "ready" when it becomes running, "crash" when it crashes. Nothing plays on first
 * render, and nothing is remembered while `enabled` is false, so switching into the style (or
 * loading the page) doesn't set off every dot at once.
 */
export function useStatusFx(status: string | undefined, enabled = true): StatusFx {
  const [prev, setPrev] = React.useState(status)
  const [fx, setFx] = React.useState<StatusFx>(null)
  if (prev !== status) {
    setPrev(status)
    setFx(enabled ? (status === "running" && prev !== undefined ? "ready" : status === "crashed" ? "crash" : null) : null)
  } else if (!enabled && fx !== null) {
    setFx(null)
  }
  return enabled ? fx : null
}
