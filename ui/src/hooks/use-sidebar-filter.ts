import * as React from "react"

import type { StatusFilter } from "@/lib/entries"

const FILTER_KEY = "servedev:status-filter"
const STATUSES: StatusFilter[] = ["all", "running", "stopped", "crashed"]

function loadStatus(): StatusFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY)
    if (STATUSES.includes(v as StatusFilter)) return v as StatusFilter
  } catch {
    // storage unavailable
  }
  return "all"
}

export interface SidebarFilter {
  query: string
  setQuery: (q: string) => void
  /** Remembered across visits. */
  status: StatusFilter
  setStatus: (s: StatusFilter) => void
  /** A search or a status other than "all" narrows the list. */
  active: boolean
}

/** The sidebar's search and status filter; the app reads it too (a new profile starts with what's listed). */
export function useSidebarFilter(): SidebarFilter {
  const [query, setQuery] = React.useState("")
  const [status, setStatusState] = React.useState<StatusFilter>(loadStatus)
  const setStatus = React.useCallback((next: StatusFilter) => {
    setStatusState(next)
    try {
      localStorage.setItem(FILTER_KEY, next)
    } catch {
      // storage unavailable
    }
  }, [])
  return { query, setQuery, status, setStatus, active: query.trim() !== "" || status !== "all" }
}
