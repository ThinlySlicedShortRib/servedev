import * as React from "react"
import { ChevronDownIcon, ChevronUpIcon, SearchIcon } from "@/components/icons"

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Hint } from "@/components/hint"
import { cn } from "@/lib/utils"

/** Case-insensitive, global; an invalid regex is searched as plain text. */
export function searchRegex(query: string): RegExp | null {
  if (!query) return null
  try {
    return new RegExp(query, "gi")
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
  }
}

function lineMatches(re: RegExp, line: string): boolean {
  re.lastIndex = 0
  const m = re.exec(line)
  return !!m && m[0].length > 0
}

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

/** A log line with matches highlighted; the current match line is emphasized. */
export function HighlightedLine({ text, re, current }: { text: string; re: RegExp | null; current: boolean }) {
  if (!re || !text) return <>{text || " "}</>
  const parts: React.ReactNode[] = []
  let last = 0
  re.lastIndex = 0
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue
    const start = m.index ?? 0
    if (start > last) parts.push(text.slice(last, start))
    parts.push(
      <mark
        key={start}
        className={cn(
          "rounded-sm text-inherit terminal:rounded-none studio:rounded-[3px]",
          current
            ? "bg-orange-400/80 dark:bg-orange-500/70 terminal:bg-match-current terminal:dark:bg-match-current studio:bg-match-current studio:dark:bg-match-current studio:text-[oklch(0.22_0.03_70)]"
            : "bg-yellow-300/70 dark:bg-yellow-500/35 terminal:bg-match terminal:dark:bg-match studio:bg-match studio:dark:bg-match"
        )}
      >
        {m[0]}
      </mark>
    )
    last = start + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts.length ? parts : text}</>
}

/** Scroll a line into the middle of its own scroll container, without scrolling the page around it. */
export function scrollToLine(container: HTMLElement | null | undefined, index: number) {
  const el = container?.querySelector<HTMLElement>(`[data-line="${index}"]`)
  if (!container || !el) return
  const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  container.scrollTop = top - container.clientHeight / 2 + el.offsetHeight / 2
}

export function LogSearchBar({
  value,
  onChange,
  matchCount,
  position,
  onNext,
  onPrev,
  onEscape,
  autoFocus,
  className,
  compact,
}: {
  value: string
  onChange: (v: string) => void
  matchCount: number
  position: number
  onNext: () => void
  onPrev: () => void
  onEscape?: () => void
  autoFocus?: boolean
  className?: string
  compact?: boolean
}) {
  return (
    <InputGroup className={cn(compact ? "h-7" : "max-w-sm", className)}>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            if (e.shiftKey) onPrev()
            else onNext()
          } else if (e.key === "Escape") {
            e.preventDefault()
            onEscape?.()
          }
        }}
        placeholder="Search logs"
        aria-label="Search logs"
        autoFocus={autoFocus}
        spellCheck={false}
        className={cn("font-mono studio:text-xs studio:md:text-xs", compact && "text-xs studio:text-[11px] studio:md:text-[11px]")}
      />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupText className="text-xs tabular-nums">{matchCount ? `${position + 1} of ${matchCount}` : "No matches"}</InputGroupText>
          <Hint label="Previous match (Shift+Enter)">
            <InputGroupButton size="icon-xs" onClick={onPrev} disabled={!matchCount} aria-label="Previous match (Shift+Enter)">
              <ChevronUpIcon />
            </InputGroupButton>
          </Hint>
          <Hint label="Next match (Enter)">
          <InputGroupButton size="icon-xs" onClick={onNext} disabled={!matchCount} aria-label="Next match (Enter)">
            <ChevronDownIcon />
          </InputGroupButton>
          </Hint>
        </InputGroupAddon>
      )}
    </InputGroup>
  )
}
