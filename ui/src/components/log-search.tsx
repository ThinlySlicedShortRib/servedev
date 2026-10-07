import * as React from "react"
import { ChevronDownIcon, ChevronUpIcon, SearchIcon } from "@/components/icons"

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Hint } from "@/components/hint"
import { cn } from "@/lib/utils"

/** A log line with matches highlighted; the current match line is emphasized. */
export function HighlightedLine({ text, re, current }: { text: string; re: RegExp | null; current: boolean }) {
  if (!re || !text) return <>{text || " "}</>
  const parts: React.ReactNode[] = []
  let last = 0
  // A copy starts at lastIndex 0 (matchAll would start where the shared regex last stopped),
  // without mutating the prop.
  for (const m of text.matchAll(new RegExp(re))) {
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
