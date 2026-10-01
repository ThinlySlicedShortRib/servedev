import * as React from "react"

import { CopyLogMenu } from "@/components/copy-log-menu"
import { Hint } from "@/components/hint"
import { LineCopy } from "@/components/line-copy"
import { HighlightedLine, LogSearchBar, scrollToLine, useLogSearch } from "@/components/log-search"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { cleanLog, useLogStream } from "@/hooks/use-log-stream"
import { ago, api, type RunEntry } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useStyleId } from "@/components/style-provider"

const MAX_LINES = 5000

function lineClass(line: string) {
  if (/\b(error|failed|exception|fatal|panic)\b/i.test(line)) return "text-destructive log-error"
  if (/\bwarn(ing)?\b/i.test(line)) return "text-amber-600 dark:text-amber-400 terminal:text-warning terminal:dark:text-warning log-warn"
  return undefined
}

function runLabel(r: RunEntry, now: number) {
  if (r.current) return "Current run"
  const end = r.status === "crashed" || r.status === "exited" ? `${r.status} (exit ${r.exitCode ?? "?"})` : r.status
  return `Run ${r.id}, ${ago(r.startedAt, now)} ago, ${end}`
}

export function LogView({
  serverId,
  command,
  runId,
  status,
  placeholder,
}: {
  serverId?: string
  /** The server's command, for "Copy for an agent". */
  command?: string
  /** The server's current run; a change means it restarted. */
  runId?: number
  status?: string
  placeholder?: string
}) {
  const [runs, setRuns] = React.useState<RunEntry[]>([])
  const [choice, setChoice] = React.useState<string>("current")
  const [past, setPast] = React.useState<{ text: string; purged: boolean } | null>(null)
  const viewingPast = choice !== "current"
  const live = useLogStream(viewingPast ? undefined : serverId)
  const text = viewingPast ? (past?.text ?? "") : live
  const now = Date.now()

  // Run history; refreshed when the server restarts or changes state.
  React.useEffect(() => {
    if (!serverId) return
    let cancelled = false
    api<{ runs: RunEntry[] }>(`/api/runs?${new URLSearchParams({ id: serverId, limit: "50" })}`)
      .then((r) => !cancelled && setRuns(r.runs))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [serverId, runId, status])

  React.useEffect(() => {
    if (!serverId || !viewingPast) return
    let cancelled = false
    setPast(null)
    api<{ lines: string[]; purged: boolean }>(
      `/api/logs?${new URLSearchParams({ id: serverId, run: choice, tail: "all", maxChars: "2000000" })}`
    )
      .then((r) => !cancelled && setPast({ text: cleanLog(r.lines.join("\n")), purged: r.purged }))
      .catch((e) => !cancelled && setPast({ text: `Couldn't load this run: ${(e as Error).message}`, purged: false }))
    return () => {
      cancelled = true
    }
  }, [serverId, choice, viewingPast])
  const [query, setQuery] = React.useState("")
  const styleId = useStyleId()
  const terminal = styleId === "terminal"
  const studio = styleId === "studio"
  const [follow, setFollow] = React.useState(true)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const preRef = React.useRef<HTMLPreElement>(null)

  const { lines, total } = React.useMemo(() => {
    const all = text.split("\n")
    if (all.at(-1) === "") all.pop()
    return { lines: all.slice(-MAX_LINES), total: all.length }
  }, [text])
  // Search highlights matches in the full log rather than hiding the other lines.
  const search = useLogSearch(lines, query)

  const viewport = () => rootRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')

  React.useLayoutEffect(() => {
    const v = viewport()
    if (follow && !query && v) v.scrollTop = v.scrollHeight
  }, [lines, follow, query])

  // Bring the current match into view; reading a match shouldn't be interrupted by new output.
  React.useLayoutEffect(() => {
    if (search.currentLine < 0) return
    setFollow(false)
    scrollToLine(viewport(), search.currentLine)
  }, [search.currentLine, search.position])

  // Scrolling up pauses follow; scrolling back to the bottom resumes it. Only the user's own
  // scrolling pauses it: layout changes (switching styles changes fonts and line heights) also
  // move the scroll position, and that shouldn't stop following.
  const keepPinned = React.useRef(true)
  React.useLayoutEffect(() => {
    keepPinned.current = follow && !query
  }, [follow, query])
  React.useEffect(() => {
    const v = viewport()
    const root = rootRef.current
    if (!v || !root) return
    let userUntil = 0
    const byUser = () => {
      userUntil = Date.now() + 600
    }
    const onScroll = () => {
      if (v.scrollHeight - v.scrollTop - v.clientHeight < 30) setFollow(true)
      else if (Date.now() < userUntil) setFollow(false)
      else if (keepPinned.current) v.scrollTop = v.scrollHeight
    }
    // While following, stay at the bottom when the log's size changes without new lines.
    const resized = new ResizeObserver(() => {
      if (keepPinned.current) v.scrollTop = v.scrollHeight
    })
    resized.observe(v)
    if (preRef.current) resized.observe(preRef.current)
    const input = ["wheel", "touchmove", "keydown", "pointerdown"] as const
    for (const e of input) root.addEventListener(e, byUser, { passive: true })
    v.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      resized.disconnect()
      for (const e of input) root.removeEventListener(e, byUser)
      v.removeEventListener("scroll", onScroll)
    }
  }, [])

  const empty =
    placeholder ??
    (viewingPast && past?.purged
      ? "This run's log was deleted by log retention."
      : viewingPast && !past
        ? "Loading…"
        : "No output yet.")
  const items = runs.map((r) => ({ value: r.current ? "current" : String(r.id), label: runLabel(r, now) }))

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-4 px-4 py-2 md:px-6 studio:gap-3 studio:border-b friendly:gap-3 friendly:px-5 friendly:py-3 friendly:md:px-7">
        {runs.length > 1 && (
          <Select items={items} value={choice} onValueChange={(v) => v && setChoice(String(v))}>
            <Hint label="Choose a run: the current one, or an earlier start of this server (kept for the log retention period)">
            <SelectTrigger size="sm" className="w-56" aria-label="Choose a run">
              <SelectValue />
            </SelectTrigger>
            </Hint>
            <SelectContent>
              {items.map((i) => (
                <SelectItem key={i.value} value={i.value}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <LogSearchBar
          value={query}
          onChange={setQuery}
          matchCount={search.matches.length}
          position={search.position}
          onNext={search.next}
          onPrev={search.prev}
          onEscape={() => setQuery("")}
          className="w-auto min-w-64 flex-1"
        />
        <div className="mr-auto flex items-center gap-2">
          <Hint label={viewingPast ? "Following only applies to the current run" : "Keep scrolling to the newest output as it arrives"}>
            <span className="flex">
              <Switch id="follow" checked={follow && !viewingPast} onCheckedChange={setFollow} disabled={viewingPast} />
            </span>
          </Hint>
          <Label htmlFor="follow">Follow</Label>
        </div>
        <CopyLogMenu
          text={text}
          query={query}
          serverId={serverId}
          command={command}
          runLabel={items.find((i) => i.value === choice)?.label ?? "Current run"}
        />
        <span className="text-xs text-muted-foreground tabular-nums studio:text-[11px]">
          {query ? `${search.matches.length} matching ${search.matches.length === 1 ? "line" : "lines"} of ${total}` : `${total} ${total === 1 ? "line" : "lines"}`}
        </span>
      </div>
      <ScrollArea ref={rootRef} className="min-h-0 flex-1 bg-muted/40 terminal:border-t terminal:bg-terminal studio:bg-surface-sunken friendly:mx-3 friendly:mb-3 friendly:rounded-2xl friendly:border friendly:bg-log friendly:text-log-foreground friendly:shadow-xs friendly:md:mx-5 friendly:md:mb-5">
        {/* Studio style: a shadow that fades in once the log is scrolled. */}
        {studio && <div aria-hidden className="studio-scroll-shadow pointer-events-none sticky top-0 z-10 -mb-2 h-2" />}
        <pre ref={preRef} className="log-lines relative px-4 py-3 pr-9 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap md:px-6 md:pr-9 studio:leading-[1.6] studio:text-foreground/90 friendly:pl-2 friendly:text-[12.5px] friendly:leading-[1.7] friendly:md:pl-3">
          <LineCopy container={preRef} lines={lines} className="md:right-2" />
          {lines.length
            ? lines.map((l, i) => (
                <div
                  key={i}
                  data-line={i}
                  className={cn(lineClass(l), i === search.currentLine && "log-current -mx-2 rounded-sm bg-orange-400/10 px-2 terminal:rounded-none terminal:bg-match/40 terminal:shadow-[inset_2px_0_0_var(--warning)]")}
                >
                  {search.matchSet.has(i) ? <HighlightedLine text={l} re={search.re} current={i === search.currentLine} /> : l || " "}
                </div>
              ))
            : <span className="log-empty text-muted-foreground studio:block">{empty}</span>}
          {/* Terminal style: a cursor under live output. */}
          {terminal && !viewingPast && lines.length > 0 && (status === "running" || status === "starting") && (
            <span aria-hidden className="term-cursor select-none" />
          )}
        </pre>
      </ScrollArea>
    </div>
  )
}
