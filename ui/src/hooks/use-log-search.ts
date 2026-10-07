import * as React from "react"

import { lineMatches, searchRegex } from "@/lib/log-search"

/**
 * Search that keeps the whole log visible: returns which lines match and a current match to
 * step through. Starts on the most recent match, since logs read oldest to newest.
 */
export function useLogSearch(lines: string[], query: string) {
  const re = React.useMemo(() => searchRegex(query), [query])
  const matches = React.useMemo(() => (re ? lines.flatMap((l, i) => (lineMatches(re, l) ? [i] : [])) : []), [lines, re])
  const [current, setCurrent] = React.useState(-1)
  const lastQuery = React.useRef(query)

  React.useEffect(() => {
    if (query !== lastQuery.current || current >= matches.length) {
      lastQuery.current = query
      setCurrent(matches.length - 1)
    }
  }, [query, matches.length, current])

  const step = (delta: number) => {
    if (!matches.length) return
    setCurrent((c) => (c + delta + matches.length) % matches.length)
  }
  return {
    re,
    matches,
    matchSet: React.useMemo(() => new Set(matches), [matches]),
    /** Line index of the current match, or -1. */
    currentLine: current >= 0 && current < matches.length ? matches[current] : -1,
    position: current,
    next: () => step(1),
    prev: () => step(-1),
  }
}
