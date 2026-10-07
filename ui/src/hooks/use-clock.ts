import * as React from "react"

/**
 * One clock for small relative-time labels all over the page ("last seen 5m ago"): every
 * component using it shares a single 10s interval, which only runs while one is mounted. For a
 * component that already gets `now` from a parent (App's useNow), pass that instead.
 */
const TICK_MS = 10_000
let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void) {
  if (!listeners.size) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const l of listeners) l()
    }, TICK_MS)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) clearInterval(timer)
  }
}

const snapshot = () => now

export function useClock(): number {
  return React.useSyncExternalStore(subscribe, snapshot)
}
