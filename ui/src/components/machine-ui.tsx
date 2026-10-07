/**
 * Other machines in the sidebar and elsewhere: machine headers that group the server list,
 * their marker in the icon rail, a small tag for tiles, and state dots/badges.
 */
import { ChevronDownIcon, ChevronRightIcon, HardDriveIcon, LaptopIcon, MonitorIcon, RotateCwIcon } from "@/components/icons"

import { Hint } from "@/components/hint"
import { Badge } from "@/components/ui/badge"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { useClock } from "@/hooks/use-clock"
import { retryMachine, useMachines, useRetrying } from "@/hooks/use-machines"
import type { Machine, MachineState } from "@/lib/api"
import { machineIcon, machineKind, shortAgo, stateSentence, type MachineCounts } from "@/lib/machines"
import { cn } from "@/lib/utils"

/** The machine's icon: a monitor for a Windows PC, a laptop for a Mac, a box for Linux. */
export function MachineIcon({ machine, className }: { machine?: Machine; className?: string }) {
  const { localName } = useMachines()
  const kind = machine ? machineIcon(machine) : localName === "This PC" ? "monitor" : localName === "This Mac" ? "laptop" : "server"
  const Icon = kind === "laptop" ? LaptopIcon : kind === "monitor" ? MonitorIcon : HardDriveIcon
  return <Icon className={className} aria-hidden />
}

export function StateDot({ state, className }: { state: MachineState; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full terminal:rounded-[1px]",
        state === "connected" && "bg-emerald-500 terminal:bg-success studio:bg-success friendly:bg-status-running",
        (state === "reconnecting" || state === "connecting") &&
          "animate-pulse bg-amber-500 motion-reduce:animate-none terminal:bg-warning studio:bg-warning friendly:bg-status-starting",
        state === "offline" && "border border-muted-foreground/70 bg-transparent",
        className
      )}
    />
  )
}

/** Machine icon with its connection state as a small dot in the corner (none for this machine). */
export function MachineGlyph({ machine, className, dot = true }: { machine?: Machine; className?: string; dot?: boolean }) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <MachineIcon machine={machine} className={cn("size-4", machine?.state === "offline" && "opacity-50")} />
      {dot && machine && <StateDot state={machine.state} className="absolute -right-0.5 -bottom-0.5 ring-2 ring-sidebar" />}
    </span>
  )
}

function countsLabel(c: MachineCounts) {
  return `${c.running} of ${c.total} running${c.crashed ? `, ${c.crashed} crashed` : ""}`
}

const warnText = "text-amber-700 dark:text-amber-400 terminal:text-warning studio:text-warning-foreground friendly:text-status-starting-foreground"
const sweepBar = "machine-sweep h-0.5 rounded-full bg-amber-500/15 text-amber-500 terminal:rounded-none terminal:bg-warning/15 terminal:text-warning studio:bg-warning/15 studio:text-warning friendly:bg-status-starting/20 friendly:text-status-starting"

/** "Retry" for a machine that isn't connected; spins while the attempt runs. */
export function RetryButton({ machine, className, label = "Retry" }: { machine: Machine; className?: string; label?: string }) {
  const busy = useRetrying(machine.name)
  return (
    <Hint label={busy ? `Connecting to ${machine.name}…` : `Try to reach ${machine.name} now instead of waiting for the next retry`} side="right">
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          void retryMachine(machine.name)
        }}
        className={cn("inline-flex shrink-0 items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-70 disabled:no-underline", className)}
      >
        {busy ? <Spinner className="size-3" /> : <RotateCwIcon className="size-3" />}
        {busy ? "Retrying…" : label}
      </button>
    </Hint>
  )
}

/**
 * A machine's header in the sidebar: icon with state dot, name, kind, crashed count and
 * running/total, and a chevron to fold its servers. Sticky while its servers scroll by. A second
 * line only when it isn't connected.
 */
export function MachineHeader({
  machine: m,
  counts,
  folded,
  onToggle,
  now,
}: {
  machine?: Machine
  counts: MachineCounts
  folded: boolean
  onToggle: () => void
  now: number
}) {
  const { localName } = useMachines()
  const Chevron = folded ? ChevronRightIcon : ChevronDownIcon
  const name = m?.name ?? localName
  const kind = m ? machineKind(m) : ""
  const tip = `${name}${kind ? ` · ${kind}` : ""}${m ? ` · ${stateSentence(m, now)}` : ""} · ${countsLabel(counts)}. Click to ${folded ? "show" : "hide"} its servers.`
  return (
    <div className="sticky top-0 z-10 border-t border-sidebar-border bg-sidebar px-2 pt-2 pb-0.5 group-data-[collapsible=icon]:hidden first:border-t-0">
      <Hint label={tip} side="right">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!folded}
          aria-label={`${name}: ${countsLabel(counts)}`}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring terminal:rounded-none friendly:rounded-lg"
        >
          <MachineGlyph machine={m} className="text-muted-foreground" />
          <span className={cn("shrink-0 font-semibold friendly:font-bold", m?.state === "offline" && "text-muted-foreground")}>{name}</span>
          {kind && <span className="min-w-0 truncate text-xs text-muted-foreground">{kind}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            {counts.crashed > 0 && (
              <span className="inline-flex items-center gap-1 text-destructive" aria-hidden>
                <span className="size-1.5 rounded-full bg-destructive terminal:rounded-[1px]" />
                {counts.crashed}
              </span>
            )}
            {counts.running}/{counts.total}
          </span>
          <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </Hint>
      {m && (m.state === "reconnecting" || m.state === "connecting") && (
        <div className="flex flex-col gap-1 px-2 pb-1" role="status">
          <span className={cn("text-xs", warnText)}>
            {m.state === "connecting" ? "Connecting…" : `Reconnecting…${m.attempt ? ` (attempt ${m.attempt})` : ""}`}
          </span>
          <span className={sweepBar} />
        </div>
      )}
      {m?.state === "offline" && (
        <div className="flex items-center gap-2 px-2 pb-1 text-xs text-muted-foreground" role="status">
          <Hint label={m.lastError ? `${m.lastError}${m.hint ? `. ${m.hint}` : ""}` : `servedev can't reach ${m.name}; it retries every minute`} side="right">
            <span className="min-w-0 truncate">Offline{m.lastSeen ? ` · last seen ${shortAgo(m.lastSeen, now)} ago` : ""}</span>
          </Hint>
          <RetryButton machine={m} className="ml-auto" />
        </div>
      )}
    </div>
  )
}

/** In the icon rail: the machine's icon, separating its servers' dots. Clicking folds it. */
export function MachineRailMarker({ machine: m, counts, folded, onToggle, now }: { machine?: Machine; counts: MachineCounts; folded: boolean; onToggle: () => void; now: number }) {
  const { localName } = useMachines()
  const name = m?.name ?? localName
  return (
    <SidebarMenu className="hidden border-t border-sidebar-border px-2 pt-2 group-data-[collapsible=icon]:flex">
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={`${name}${m ? ` (${machineKind(m)}): ${stateSentence(m, now)}` : ""}, ${countsLabel(counts)}. Click to ${folded ? "show" : "hide"} its servers.`}
          onClick={onToggle}
          aria-expanded={!folded}
          className={cn(m?.state === "offline" && "opacity-60")}
        >
          <MachineGlyph machine={m} />
          <span>{name}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/** A small tag naming another machine, for grid tiles and lists. */
export function MachineTag({ machine: m, className }: { machine: Machine; className?: string }) {
  const now = useClock()
  return (
    <Hint label={`Runs on ${m.name} (${machineKind(m)}), ${m.state === "connected" ? "connected" : stateSentence(m, now)}`}>
      <span
        className={cn(
          "inline-flex h-4 shrink-0 items-center gap-1 rounded-sm border px-1 text-[10px] leading-none font-medium text-muted-foreground terminal:rounded-none friendly:rounded-full friendly:px-1.5",
          className
        )}
      >
        <MachineIcon machine={m} className="size-2.5" />
        {m.name}
        {m.state !== "connected" && <StateDot state={m.state} className="size-1" />}
      </span>
    </Hint>
  )
}

/** A machine's connection state as a badge (Machines sheet). */
export function MachineStateBadge({ machine: m, now }: { machine?: Machine; now: number }) {
  if (!m || m.state === "connected")
    return (
      <Badge variant="outline" className="gap-1.5 font-normal">
        <StateDot state="connected" />
        {m ? "connected" : "this machine"}
      </Badge>
    )
  if (m.state === "reconnecting" || m.state === "connecting")
    return (
      <Badge variant="outline" className={cn("gap-1.5 font-normal", warnText)}>
        <Spinner className="size-3" />
        {m.state === "connecting" ? "connecting" : `reconnecting${m.attempt ? ` (attempt ${m.attempt})` : ""}`}
      </Badge>
    )
  return (
    <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
      <StateDot state="offline" />
      offline{m.lastSeen ? ` ${shortAgo(m.lastSeen, now)}` : ""}
    </Badge>
  )
}
