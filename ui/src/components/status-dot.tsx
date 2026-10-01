/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

import { cn } from "@/lib/utils"
import type { Status } from "@/lib/api"
import { useStyleId } from "@/components/style-provider"
import { useStatusFx } from "@/hooks/use-status-fx"

export function StatusDot({ status, className }: { status: Status | "idle"; className?: string }) {
  const style = useStyleId()
  if (style === "terminal") return <TerminalStatusGlyph status={status} className={className} />
  if (style === "studio") return <StudioStatusDot status={status} className={className} />
  if (style === "friendly") return <FriendlyStatusDot status={status} className={className} />
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
    (status === "stopped" || status === "exited" || status === "idle" || !status) && "terminal:border-border terminal:bg-transparent terminal:text-muted-foreground",
    // Friendly: a soft colored pill (with its dot inside; see server-detail.tsx).
    status === "running" && "friendly:border-status-running/25 friendly:bg-status-running-soft friendly:text-status-running-foreground friendly:dark:bg-status-running-soft",
    (status === "starting" || status === "stopping") && "friendly:border-status-starting/30 friendly:bg-status-starting-soft friendly:text-status-starting-foreground friendly:dark:bg-status-starting-soft",
    status === "crashed" && "friendly:border-status-crashed/25 friendly:bg-status-crashed-soft friendly:text-status-crashed-foreground friendly:dark:bg-status-crashed-soft",
    (status === "stopped" || status === "exited" || status === "idle" || !status) &&
      "friendly:border-status-stopped/30 friendly:bg-status-stopped-soft friendly:text-status-stopped-foreground friendly:dark:bg-status-stopped-soft"
  )
}

/**
 * Studio style: healthy is quiet, only a crash is loud. Colors crossfade between states;
 * a soft ring grows out while starting, and twice when it crashes (.studio-dot in studio.css).
 */
function StudioStatusDot({ status, className }: { status: Status | "idle"; className?: string }) {
  return (
    <span
      aria-hidden
      data-status={status}
      className={cn(
        "studio-dot inline-block size-2 shrink-0 rounded-full",
        status === "running" && "bg-success",
        (status === "starting" || status === "stopping") && "bg-warning",
        status === "crashed" && "bg-destructive shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive)_22%,transparent)]",
        (status === "stopped" || status === "exited") && "bg-muted-foreground/35",
        status === "idle" && "border border-muted-foreground/50",
        className
      )}
    />
  )
}

const SPARKLES = [
  { r: 0, c: "bg-status-running" },
  { r: 72, c: "bg-primary" },
  { r: 144, c: "bg-status-starting" },
  { r: 216, c: "bg-status-running" },
  { r: 288, c: "bg-primary" },
]

/**
 * Friendly style: status by shape as well as color: running = solid circle with a soft halo,
 * starting/stopping = half-filled breathing circle, crashed = diamond, stopped = rounded square,
 * not started = dashed ring. A change seen on screen plays once: a check and a few sparkles when
 * it becomes ready, a fading red glow when it crashes (friendly.css).
 */
function FriendlyStatusDot({ status, className }: { status: Status | "idle"; className?: string }) {
  const fx = useStatusFx(status)
  return (
    <span aria-hidden className={cn("relative inline-flex size-2.5 shrink-0 items-center justify-center", className)}>
      <span
        className={cn(
          "inline-block size-2.5 shrink-0 rounded-full transition-[background-color,box-shadow] duration-500",
          status === "running" && "bg-status-running ring-[3px] ring-status-running/20",
          (status === "starting" || status === "stopping") &&
            "friendly-breathe border-[1.5px] border-status-starting bg-[image:conic-gradient(var(--status-starting)_0_50%,transparent_0)]",
          status === "crashed" && "size-2 rotate-45 rounded-[2px] bg-status-crashed ring-[3px] ring-status-crashed/15",
          status === "crashed" && fx === "crash" && "friendly-crash-glow",
          (status === "stopped" || status === "exited") && "size-2 rounded-[3px] bg-status-stopped",
          status === "idle" && "border-[1.5px] border-dashed border-status-stopped"
        )}
      />
      {fx === "ready" && status === "running" && (
        <span className="pointer-events-none absolute inset-0">
          <span className="friendly-ready-ring absolute inset-0 rounded-full bg-status-running/50" />
          {SPARKLES.map((p) => (
            <span
              key={p.r}
              className={cn("friendly-sparkle absolute top-1/2 left-1/2 -mt-[2px] -ml-[2px] size-1 rounded-full", p.c)}
              style={{ "--r": `${p.r}deg` } as React.CSSProperties}
            />
          ))}
          <svg viewBox="0 0 16 16" className="friendly-check-badge absolute top-1/2 left-1/2 size-3.5">
            <circle cx="8" cy="8" r="8" className="fill-status-running" />
            <path
              d="M4.6 8.3 7 10.6l4.4-4.9"
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="24"
              className="friendly-draw stroke-white"
            />
          </svg>
        </span>
      )}
    </span>
  )
}
