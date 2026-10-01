import * as React from "react"
import { CopyIcon, ExternalLinkIcon, GripVerticalIcon, Maximize2Icon, PlayIcon, RotateCwIcon, SearchIcon, SquareIcon, XIcon } from "@/components/icons"
import { toast } from "sonner"

import { AccountTag } from "@/components/account-tag"
import { useStartProfile } from "@/hooks/use-accounts"
import { BranchTag } from "@/components/branch-tag"
import { LineCopy } from "@/components/line-copy"
import { Hint, TruncatedText } from "@/components/hint"
import { HighlightedLine, LogSearchBar, scrollToLine, useLogSearch } from "@/components/log-search"
import { StatusDot } from "@/components/status-dot"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { copyText, lineCount } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import { useStyleId } from "@/components/style-provider"
import { useStatusFx } from "@/hooks/use-status-fx"
import { ACTIVE, api, openUrl, portOf, statusLabel, type Server } from "@/lib/api"

/** Class names react-grid-layout uses to decide what drags a tile and what doesn't. */
export const DRAG_HANDLE = "tile-drag-handle"
export const NO_DRAG = "tile-no-drag"

const MAX_LINES = 400

function lineClass(line: string) {
  if (/\b(\w*Error|error|ERROR|failed|FAILED|exception|fatal|panic)\b/.test(line) && !/DeprecationWarning/.test(line)) return "text-destructive log-error"
  if (/\bwarn(ing)?\b/i.test(line)) return "text-amber-600 dark:text-amber-400 terminal:text-warning terminal:dark:text-warning log-warn"
  return undefined
}

async function act(action: "start" | "restart" | "stop", s: Server, startProfile?: string) {
  try {
    if (action === "start") await api("/api/start", { id: s.id, clientCwd: s.cwd, wait: false, profile: startProfile })
    else if (action === "restart") await api("/api/restart", { id: s.id, wait: false })
    else await api("/api/stop", { id: s.id })
  } catch (e) {
    toast.error(`Couldn't ${action} ${s.name}`, { description: (e as Error).message })
  }
}

function IconAction({
  label,
  onClick,
  href,
  children,
  className,
}: {
  label: string
  onClick?: () => void
  /** Renders as a link (opens in a new tab) instead of a button. */
  href?: string
  children: React.ReactNode
  className?: string
}) {
  const props = { variant: "ghost" as const, size: "icon-xs" as const, className: cn(NO_DRAG, className), "aria-label": label }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          href ? <Button {...props} nativeButton={false} render={<a href={href} target="_blank" rel="noopener" />} /> : <Button {...props} onClick={onClick} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function ServerTile({
  server: s,
  onRemove,
  log,
  selected,
  onOpenDetails,
}: {
  server: Server
  /** Take the tile off the grid (the server keeps running). */
  onRemove: () => void
  log: string
  selected: boolean
  onOpenDetails: () => void
}) {
  const active = ACTIVE.includes(s.status)
  const startProfile = useStartProfile(s.id)
  const href = openUrl(s)
  const port = portOf(s)
  const logRef = React.useRef<HTMLPreElement>(null)
  const stick = React.useRef(true)
  const [searching, setSearching] = React.useState(false)
  const [query, setQuery] = React.useState("")
  // Friendly style: a tile shakes once when its server crashes while you watch.
  const statusFx = useStatusFx(s.status, useStyleId() === "friendly")

  const lines = React.useMemo(() => {
    const all = log.split("\n")
    if (all.at(-1) === "") all.pop()
    return all.slice(-MAX_LINES)
  }, [log])

  const search = useLogSearch(lines, query)

  // Keep the tail in view unless the user scrolled up to read or is looking at a match.
  React.useLayoutEffect(() => {
    const el = logRef.current
    if (el && stick.current && !query) el.scrollTop = el.scrollHeight
  }, [lines, query])

  React.useLayoutEffect(() => {
    if (search.currentLine >= 0) scrollToLine(logRef.current, search.currentLine)
  }, [search.currentLine, search.position])

  function closeSearch() {
    setSearching(false)
    setQuery("")
  }

  return (
    <div
      className={cn(
        // A container, so the header can adapt to the tile's own width as it's resized.
        "group/tile @container/tile flex h-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xs terminal:rounded-none studio:transition-[box-shadow,border-color] studio:duration-200 studio:hover:shadow-sm",
        // Studio style: a crashed tile is edged in red and flashes once (studio.css).
        s.status === "crashed" && "studio-crash-flash studio:border-destructive/50 studio:ring-1 studio:ring-destructive/30",
        "friendly:rounded-2xl friendly:shadow-sm friendly:transition-[box-shadow,border-color] friendly:duration-300 friendly:hover:shadow-md",
        s.status === "crashed" && "friendly:border-status-crashed/30",
        statusFx === "crash" && "friendly-shake",
        selected && "ring-2 ring-ring friendly:ring-offset-2 friendly:ring-offset-background"
      )}
    >
      <div className={cn(DRAG_HANDLE, "flex cursor-grab items-center gap-2 border-b px-2 py-1.5 active:cursor-grabbing terminal:bg-muted/60 terminal:py-1 studio:h-9 studio:py-0 friendly:flex-wrap friendly:gap-x-2 friendly:gap-y-1 friendly:bg-card friendly:px-3 friendly:py-2", s.status === "crashed" && "studio:bg-destructive/[0.06] friendly:bg-status-crashed-soft/60")}>
        <GripVerticalIcon className="size-3.5 shrink-0 text-muted-foreground studio:text-muted-foreground/60" aria-hidden />
        <StatusDot status={s.status} />
        <Hint label={`Show ${s.project} / ${s.name} in Single view, with details, processes and preview`}>
          <button type="button" className={cn(NO_DRAG, "flex min-w-0 items-baseline gap-1.5 text-left friendly:min-w-[6.5rem] friendly:flex-1 friendly:basis-0 friendly:rounded-md friendly:outline-none friendly:focus-visible:ring-4 friendly:focus-visible:ring-ring/35")} onClick={onOpenDetails}>
            <TruncatedText text={s.name} className={cn("text-sm font-medium friendly:font-bold", s.status === "crashed" && "studio:text-destructive")} />
            <TruncatedText text={s.project} className="text-xs text-muted-foreground @max-[30rem]/tile:hidden" />
            {s.branch && <BranchTag branch={s.branch} className="self-center @max-[36rem]/tile:hidden" />}
            <AccountTag server={s} className="max-w-48 self-center @max-[44rem]/tile:hidden" />
          </button>
        </Hint>
        {href ? (
          <TruncatedText text={href} className="min-w-12 shrink font-mono text-xs text-muted-foreground studio:text-[11px] studio:tabular-nums">
            {s.customUrl ? s.hostname : `:${port}`}
          </TruncatedText>
        ) : (
          <TruncatedText text={statusLabel(s)} className="text-xs text-muted-foreground" />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 friendly:gap-px studio:text-muted-foreground studio:opacity-70 studio:transition-opacity studio:duration-150 studio:group-hover/tile:opacity-100 studio:focus-within:opacity-100">
          <IconAction label={searching ? "Close search" : "Search logs"} onClick={() => (searching ? closeSearch() : setSearching(true))}>
            <SearchIcon />
          </IconAction>
          <IconAction
            label="Copy log"
            onClick={async () => {
              try {
                await copyText(log.replace(/\n+$/, ""))
                toast.success(`Copied ${s.name}'s log`, { description: `${lineCount(log)} lines` })
              } catch (e) {
                toast.error("Couldn't copy", { description: (e as Error).message })
              }
            }}
          >
            <CopyIcon />
          </IconAction>
          {href && (
            <IconAction label="Open in new tab" href={href}>
              <ExternalLinkIcon />
            </IconAction>
          )}
          {active ? (
            <>
              <IconAction label="Restart" onClick={() => act("restart", s)}>
                <RotateCwIcon />
              </IconAction>
              <IconAction label="Stop" onClick={() => act("stop", s)} className="hover:text-destructive">
                <SquareIcon />
              </IconAction>
            </>
          ) : (
            <IconAction label="Start" onClick={() => act("start", s, startProfile)}>
              <PlayIcon />
            </IconAction>
          )}
          <IconAction label="Details" onClick={onOpenDetails}>
            <Maximize2Icon />
          </IconAction>
          <IconAction label="Remove from grid (keeps running)" onClick={onRemove}>
            <XIcon />
          </IconAction>
        </div>
      </div>

      {searching && (
        <div className={cn(NO_DRAG, "border-b px-2 py-1.5 friendly:px-3 friendly:py-2")}>
          <LogSearchBar
            compact
            autoFocus
            value={query}
            onChange={setQuery}
            matchCount={search.matches.length}
            position={search.position}
            onNext={search.next}
            onPrev={search.prev}
            onEscape={closeSearch}
          />
        </div>
      )}
        <pre
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
          className="log-lines log-compact relative min-h-0 flex-1 overflow-auto bg-muted/40 px-2.5 py-2 pr-8 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap terminal:bg-terminal studio:bg-surface-sunken studio:leading-[1.6] studio:text-foreground/90 friendly:bg-log friendly:py-2 friendly:pr-8 friendly:pl-1.5 friendly:text-[11.5px] friendly:leading-[1.65] friendly:text-log-foreground"
        >
          <LineCopy container={logRef} lines={lines} />
          {lines.length ? (
            lines.map((l, i) => (
              <div key={i} data-line={i} className={cn(lineClass(l), i === search.currentLine && "log-current -mx-1 rounded-sm bg-orange-400/10 px-1 terminal:rounded-none terminal:bg-match/40 terminal:shadow-[inset_2px_0_0_var(--warning)]")}>
                {search.matchSet.has(i) ? <HighlightedLine text={l} re={search.re} current={i === search.currentLine} /> : l || " "}
              </div>
            ))
          ) : (
            <span className="log-empty text-muted-foreground studio:block">{active ? "No output yet." : "Not running."}</span>
          )}
        </pre>
    </div>
  )
}
