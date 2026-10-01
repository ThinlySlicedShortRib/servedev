/* eslint-disable react-refresh/only-export-components */
import { cn } from "@/lib/utils"
import type { Status } from "@/lib/api"
import { useStyleId } from "@/components/style-provider"

export function StatusDot({ status, className }: { status: Status | "idle"; className?: string }) {
  const style = useStyleId()
  if (style === "terminal") return <TerminalStatusGlyph status={status} className={className} />
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "running" && "bg-emerald-500",
        (status === "starting" || status === "stopping") && "animate-pulse bg-amber-500 motion-reduce:animate-none",
        status === "crashed" && "bg-destructive",
        (status === "stopped" || status === "exited") && "bg-muted-foreground/40",
        status === "idle" && "border border-muted-foreground/60",
        className
      )}
    />
  )
}

const BRAILLE: [number, number][] = [[0, 0], [1, 0], [1, 1], [1, 2], [0, 2], [0, 1]]

// 5x5 grid drawn at 10px: every cell is exactly 2px, so the glyphs stay sharp.

/**
 * Terminal style: status as a glyph: ■ running, a braille spinner while starting/stopping,
 * ✕ crashed, □ stopped, ⬚ not started. Decorative; the status word is always shown nearby.
 */
function TerminalStatusGlyph({ status, className }: { status: Status | "idle"; className?: string }) {
  const busy = status === "starting" || status === "stopping"
  return (
    <svg
      aria-hidden
      viewBox="0 0 5 5"
      shapeRendering="crispEdges"
      fill="currentColor"
      data-status={status}
      className={cn(
        "status-glyph inline-block size-2.5! shrink-0 overflow-visible",
        status === "running" && "text-success",
        busy && "text-warning",
        status === "crashed" && "text-destructive",
        (status === "stopped" || status === "exited" || status === "idle") && "text-muted-foreground",
        className
      )}
    >
      {status === "running" && <rect width="5" height="5" />}
      {busy && (
        <g className="braille-spinner">
          {BRAILLE.map(([x, y], i) => (
            <rect key={i} x={x * 3} y={y * 2} width="2" height="1" style={{ animationDelay: `${(i - 6) * 0.1}s` }} />
          ))}
        </g>
      )}
      {status === "crashed" && <path d="M0 0h1v1H0zM1 1h1v1H1zM2 2h1v1H2zM3 3h1v1H3zM4 4h1v1H4zM4 0h1v1H4zM3 1h1v1H3zM1 3h1v1H1zM0 4h1v1H0z" />}
      {(status === "stopped" || status === "exited") && <path d="M0 0h5v5H0zM1 1v3h3V1z" fillRule="evenodd" />}
      {status === "idle" && <path d="M0 0h1v1H0zM2 0h1v1H2zM4 0h1v1H4zM0 2h1v1H0zM4 2h1v1H4zM0 4h1v1H0zM2 4h1v1H2zM4 4h1v1H4z" />}
    </svg>
  )
}

/**
 * Classes for a status Badge. Classic keeps the Badge as is; Terminal turns it into a
 * bracketed tag: [ RUNNING ], an inverse red [ CRASHED (EXIT 1) ], amber while starting
 * (the words inside stay the app's own).
 */
export function statusTagClass(status: Status | "idle" | undefined) {
  return cn(
    "status-tag terminal:h-5 terminal:rounded-none terminal:border terminal:px-1.5 terminal:text-[11px]",
    status === "running" && "terminal:border-success/60 terminal:bg-success/10 terminal:text-success",
    (status === "starting" || status === "stopping") && "terminal:border-warning/60 terminal:bg-warning/10 terminal:text-warning",
    status === "crashed" && "terminal:border-destructive terminal:bg-destructive terminal:text-background terminal:dark:bg-destructive",
    (status === "stopped" || status === "exited" || status === "idle" || !status) && "terminal:border-border terminal:bg-transparent terminal:text-muted-foreground"
  )
}
