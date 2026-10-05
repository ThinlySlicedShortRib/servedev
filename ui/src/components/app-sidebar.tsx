import * as React from "react"
import { CheckIcon, ExternalLinkIcon, PinIcon, PlusIcon, SearchIcon, Trash2Icon } from "@/components/icons"

import { StatusDot } from "@/components/status-dot"
import { useStyleId } from "@/components/style-provider"
import { LogoMark } from "@/components/terminal-decor"
import { NoMatchIllustration, StudioLogoMark } from "@/components/studio-decor"
import { FriendlyLogoMark, ProjectAvatar } from "@/components/friendly-decor"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { ACTIVE, ago, openUrl, portOf, statusLabel, type Machine, type Server } from "@/lib/api"
import { SERVER_MIME } from "@/lib/drag"
import { BranchTag } from "@/components/branch-tag"
import { Hint, TruncatedText } from "@/components/hint"
import { type SidebarFilter } from "@/hooks/use-sidebar-filter"
import { branchOf, filterGroups, statusGroup, type Entry, type StatusFilter } from "@/lib/entries"
import { MachineHeader, MachineRailMarker, MachineTag } from "@/components/machine-ui"
import { useMachineFolds, useMachines } from "@/hooks/use-machines"
import { localPortOf, machineSections, remotePortOf } from "@/lib/machines"

const FILTERS: { value: StatusFilter; label: string; hint: string }[] = [
  { value: "all", label: "All", hint: "Show every server" },
  { value: "running", label: "Running", hint: "Show only servers that are running or starting" },
  { value: "stopped", label: "Stopped", hint: "Show only servers that were stopped or exited on their own" },
  { value: "crashed", label: "Crashed", hint: "Show only servers that crashed (exited with an error)" },
]
/** Group key for the pinned section; can't collide with a project name. */
const PINNED = "\u0000pinned"

/** A machine section's counts with this machine's pinned servers added (they're listed apart). */
function countPinned(c: { total: number; running: number; crashed: number }, pinned: Entry[]) {
  return {
    total: c.total + pinned.length,
    running: c.running + pinned.filter((e) => statusGroup(e) === "running").length,
    crashed: c.crashed + pinned.filter((e) => e.status === "crashed").length,
  }
}

export function AppSidebar({
  groups,
  pinned,
  profileControls,
  selected,
  onSelect,
  connected,
  now,
  onNew,
  grid,
  onRemoveProject,
  byMachine = false,
  filter,
}: {
  groups: [string, Entry[]][]
  /** Pinned servers, shown above the projects. */
  pinned: Entry[]
  profileControls: React.ReactNode
  selected: string | null
  onSelect: (key: string) => void
  connected: boolean | null
  now: number
  onNew: () => void
  /**
   * Set in custom-grid view: rows can be dragged onto the grid or added with +. `blocked` says
   * why a server can't go on this grid, if it can't.
   */
  grid?: { ids: Set<string>; onToggle: (id: string) => void; blocked?: (s: Server) => string | undefined }
  /** Group servers by machine first (once another machine exists, outside a profile). */
  byMachine?: boolean
  /** Remove a tracked folder: all of its servers. Given the project's tracked servers. */
  onRemoveProject: (project: string, entries: Entry[]) => void
  /** Search and status filter (owned by the app, which starts new profiles from what's listed). */
  filter: SidebarFilter
}) {
  const { setOpenMobile, state: sidebarState, setOpen } = useSidebar()
  const collapsed = sidebarState === "collapsed"
  const { query, setQuery, status } = filter
  const searchRef = React.useRef<HTMLInputElement>(null)
  const styleId = useStyleId()
  const terminal = styleId === "terminal"
  const studio = styleId === "studio"
  const friendly = styleId === "friendly"

  const all = React.useMemo(() => [...pinned, ...groups.flatMap(([, es]) => es)], [groups, pinned])
  const counts = React.useMemo(() => {
    const c: Record<StatusFilter, number> = { all: all.length, running: 0, stopped: 0, crashed: 0 }
    for (const e of all) c[statusGroup(e)]++
    return c
  }, [all])
  // Pinned entries render as their own section; the label only matters for grouping.
  const visible = React.useMemo(
    () => filterGroups(pinned.length ? [[PINNED, pinned], ...groups] : groups, query, status),
    [groups, pinned, query, status]
  )
  const filtering = filter.active

  // With other machines, each machine is a section (This Mac first) with its own projects.
  const machines = useMachines()
  const folds = useMachineFolds()
  const sections = React.useMemo(() => {
    if (!byMachine || !machines.hasRemotes) return null
    return machineSections(groups, machines.list).map((sec) => ({
      ...sec,
      // Pinned servers are this machine's; they lead its section.
      visible: filterGroups(!sec.machine && pinned.length ? [[PINNED, pinned], ...sec.groups] : sec.groups, query, status),
      counts: sec.machine ? sec.counts : { ...sec.counts, ...countPinned(sec.counts, pinned) },
    }))
  }, [byMachine, machines, groups, pinned, query, status])

  /** Focus search, expanding the sidebar first if it's shrunk to icons. */
  function focusSearch() {
    if (!collapsed) return searchRef.current?.focus()
    setOpen(true)
    setTimeout(() => searchRef.current?.focus(), 220)
  }

  const changeStatus = filter.setStatus

  // "/" focuses search from anywhere outside a text field.
  const onSlash = React.useEffectEvent(focusSearch)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      e.preventDefault()
      onSlash()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  /** One project's servers (or the pinned ones). `machine`: the remote machine they're on. */
  const renderGroup = ([project, entries]: [string, Entry[]], sectionMachine?: Machine) => {
    const machine = sectionMachine ?? machines.get(entries[0]?.server?.machine)
    return (
          <SidebarGroup key={`${machine?.name ?? ""}/${project}`} className="group/sidebar-group studio:py-1">
            {/* Shrunk to icons the label fades out but still overlaps the first row; let clicks and hover through. */}
            {/* A project on another machine is removed there (its paths aren't this machine's). */}
            {project !== PINNED && !machine && entries.some((e) => e.server) && (
              <Hint label={`Remove ${project} from servedev: stops and forgets its ${entries.filter((e) => e.server).length} tracked ${entries.filter((e) => e.server).length === 1 ? "server" : "servers"}. Files on disk stay. (Asks first.)`} side="right">
                <SidebarGroupAction
                  aria-label={`Remove ${project} from servedev`}
                  className="text-muted-foreground opacity-0 group-hover/sidebar-group:opacity-100 hover:text-destructive focus-visible:opacity-100 [&>svg]:size-3.5"
                  onClick={() => onRemoveProject(project, entries.filter((e) => e.server))}
                >
                  <Trash2Icon />
                </SidebarGroupAction>
              </Hint>
            )}
            <SidebarGroupLabel className="pr-7 group-data-[collapsible=icon]:pointer-events-none">
              {project === PINNED ? (
                <>
                  <PinIcon className="mr-1.5 size-3 friendly:size-3.5 friendly:text-primary" />
                  Pinned
                </>
              ) : (
                // All servers in a project share its folder, so they share the branch.
                <span className="flex min-w-0 items-center gap-1.5">
                  {friendly && <ProjectAvatar name={project} />}
                  <TruncatedText text={project} />
                  {entries.map(branchOf).find(Boolean) && <BranchTag branch={entries.map(branchOf).find(Boolean)!} className="shrink" />}
                  {/* Listed without machine sections (a profile's servers): say which machine it's on. */}
                  {!sectionMachine && machine && <MachineTag machine={machine} className="pointer-events-auto" />}
                </span>
              )}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {entries.map((e, i) => {
                  const s = e.server
                  const x = e.external
                  const state = x
                    ? x.startedAt
                      ? `running for ${ago(x.startedAt, now)}`
                      : "running"
                    : !s
                      ? "Not started"
                      : ACTIVE.includes(s.status)
                        ? `${s.status} for ${ago(s.startedAt, now)}`
                        : statusLabel(s)
                  // Its machine isn't connected: what servedev saw last, dimmed.
                  const stale = !!s?.stale
                  // Pinned servers come from any project, so say which.
                  const sub = stale ? `last known: ${s ? statusLabel(s) : state}` : project === PINNED ? `${e.project}, ${state}` : state
                  // A remote server shows the port it has on its machine; the link opens it here.
                  const remotePort = s?.machine ? remotePortOf(s) : undefined
                  const href = stale ? undefined : openUrl(s)
                  // (Offline: the port it had, as plain text.)
                  const port = s && (s.machine ? (stale || href ? remotePort : undefined) : portOf(s))
                  const blocked = grid && s ? grid.blocked?.(s) : undefined
                  return (
                    <SidebarMenuItem key={e.key} className={cn("tree-row terminal:pl-5 terminal:group-data-[collapsible=icon]:pl-0 studio-row-in friendly-rise", stale && "opacity-55")} style={friendly ? { animationDelay: `${Math.min(i, 10) * 30}ms` } : undefined}>
                      <SidebarMenuButton
                        draggable={!!grid && !!s && !grid.ids.has(s.id) && !blocked}
                        onDragStart={(ev) => {
                          if (!s) return
                          ev.dataTransfer.setData(SERVER_MIME, s.id)
                          ev.dataTransfer.setData("text/plain", s.id)
                          ev.dataTransfer.effectAllowed = "copy"
                        }}
                        size="lg"
                        // Outside servers carry a tag line; let the row grow instead of clipping it.
                        className={cn(x || (project === PINNED && branchOf(e)) ? "h-auto min-h-12 py-1.5" : undefined, studio && e.status === "crashed" && "studio-crash-flash")}
                        tooltip={`${machine ? `${machine.name} / ` : ""}${e.project} / ${e.name}, ${stale ? sub : state}${machine ? (port ? `, ${machine.name}:${port}` : "") : s?.hostname ? `, ${s.hostname}` : port ? `, :${port}` : ""}`}
                        isActive={selected === e.key}
                        onClick={() => {
                          onSelect(e.key)
                          setOpenMobile(false)
                        }}
                      >
                        {/* Centered in the icon rail, where the dot is all that shows. */}
                        <span className="flex size-4 shrink-0 items-center justify-center group-data-[collapsible=icon]:size-8">
                          {x ? (
                            // Hollow: running, but not managed by servedev.
                            <span aria-hidden className="inline-block size-2 shrink-0 rounded-full border-[1.5px] border-emerald-500 terminal:rounded-[1px] terminal:border-success studio:border-success friendly:size-2.5 friendly:border-2 friendly:border-status-running" />
                          ) : (
                            <StatusDot status={e.status} />
                          )}
                        </span>
                        <div className="grid flex-1 text-left leading-tight">
                          <TruncatedText text={e.name} className={cn("font-medium friendly:font-semibold", studio && e.status === "crashed" && "text-destructive")} side="right" />
                          <TruncatedText text={sub} className="text-xs text-muted-foreground studio:tabular-nums" side="right" />
                          {project === PINNED && branchOf(e) && (
                            <span className="mt-0.5 flex">
                              <BranchTag branch={branchOf(e)!} />
                            </span>
                          )}
                          {x && (
                            <span className="mt-0.5 flex gap-1">
                              <Hint label="Started by something other than servedev (a terminal or an agent's shell). Select it to take it over." side="right">
                                <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                                  outside servedev
                                </Badge>
                              </Hint>
                              {x.orphaned && (
                                <Hint label="Its folder was deleted (a removed worktree, most likely); it can only be stopped" side="right">
                                  <Badge variant="destructive" className="h-4 px-1 text-[10px] font-normal">
                                    folder deleted
                                  </Badge>
                                </Hint>
                              )}
                            </span>
                          )}
                        </div>
                      </SidebarMenuButton>
                      {grid && s ? (
                        <Hint label={grid.ids.has(s.id) ? "On the grid. Click to take it off (it keeps running)." : blocked ?? "Add to the grid, or drag the row onto it"} side="right">
                          <SidebarMenuAction
                            // Not `disabled`: the hint has to stay hoverable.
                            aria-disabled={(!!blocked && !grid.ids.has(s.id)) || undefined}
                            onClick={() => (!blocked || grid.ids.has(s.id)) && grid.onToggle(s.id)}
                            aria-label={grid.ids.has(s.id) ? `Remove ${e.name} from the grid` : `Add ${e.name} to the grid`}
                            className={cn("top-3", blocked && !grid.ids.has(s.id) && "cursor-not-allowed opacity-40 hover:bg-transparent")}
                          >
                            {grid.ids.has(s.id) ? <CheckIcon className="text-emerald-600 dark:text-emerald-400 terminal:text-success terminal:dark:text-success friendly:text-status-running-foreground friendly:dark:text-status-running-foreground studio:text-success-foreground studio:dark:text-success-foreground" /> : <PlusIcon />}
                          </SidebarMenuAction>
                        </Hint>
                      ) : x?.url ? (
                        <Hint label={`Open ${x.url} in a new tab`} side="right">
                          <SidebarMenuAction
                            render={<a href={x.url} target="_blank" rel="noopener" />}
                            aria-label={`Open ${e.name} in a new tab`}
                            className="top-2.5 aspect-auto h-6 w-auto gap-1 px-1.5 font-mono text-xs tabular-nums [&>svg]:size-3 studio:text-[11px] studio:text-muted-foreground studio:hover:text-foreground friendly:top-3 friendly:rounded-full friendly:bg-sidebar-accent/70 friendly:px-2 friendly:text-[11px] friendly:ring-1 friendly:ring-transparent friendly:transition-colors friendly:hover:bg-primary/12 friendly:hover:text-primary friendly:hover:ring-primary/25"
                          >
                            <span>{x.url.split(":").pop()}</span>
                            <ExternalLinkIcon />
                          </SidebarMenuAction>
                        </Hint>
                      ) : href ? (
                        // The port (or custom hostname) is the link: always visible, and a real <a>, so middle-click and ⌘-click work too.
                        <Hint label={`Open ${href} in a new tab${machine && s ? ` (${machine.name}:${remotePort}${localPortOf(s) !== remotePort ? `, at localhost:${localPortOf(s)} here` : ""})` : ""}`} side="right">
                          <SidebarMenuAction
                            render={<a href={href} target="_blank" rel="noopener" />}
                            aria-label={`Open ${e.name} in a new tab`}
                            className="top-2.5 aspect-auto h-6 w-auto max-w-32 gap-1 px-1.5 font-mono text-xs tabular-nums [&>svg]:size-3 studio:text-[11px] studio:text-muted-foreground studio:hover:text-foreground friendly:top-3 friendly:rounded-full friendly:bg-sidebar-accent/70 friendly:px-2 friendly:text-[11px] friendly:ring-1 friendly:ring-transparent friendly:transition-colors friendly:hover:bg-primary/12 friendly:hover:text-primary friendly:hover:ring-primary/25"
                          >
                            <span className="truncate">{machine ? port : s?.customUrl ? s.hostname : port}</span>
                            <ExternalLinkIcon />
                          </SidebarMenuAction>
                        </Hint>
                      ) : (
                        port && <SidebarMenuBadge className="top-3 font-mono tabular-nums">{port}</SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
    )
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 pl-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:pl-0">
          {terminal ? (
            <>
              <span className="flex items-center gap-2 group-data-[collapsible=icon]:hidden">
                <LogoMark className="size-5" />
                <span className="phosphor-glow font-bold tracking-tight">
                  servedev<span aria-hidden className="text-primary select-none">_</span>
                </span>
              </span>
              <span
                className={`flex items-center gap-1.5 text-[11px] font-semibold tracking-wider uppercase group-data-[collapsible=icon]:hidden ${connected ? "text-success" : connected === false ? "text-destructive" : "text-warning"}`}
              >
                <StatusDot status={connected === null ? "starting" : connected ? "running" : "crashed"} />
                {connected === null ? "Connecting…" : connected ? "Live" : "Disconnected"}
              </span>
            </>
          ) : studio ? (
            <>
              <StudioLogoMark className="group-data-[collapsible=icon]:hidden" />
              <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">servedev</span>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-1.5 py-px text-[10.5px] font-medium text-muted-foreground transition-colors duration-300 group-data-[collapsible=icon]:hidden",
                  connected === false && "border-destructive/30 bg-destructive/[0.06] text-destructive"
                )}
              >
                {/* Breathes while live, amber while (re)connecting, solid red when the daemon is gone. */}
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full transition-colors duration-300",
                    connected === null && "studio-live bg-warning text-warning",
                    connected === true && "studio-live bg-success text-success",
                    connected === false && "bg-destructive"
                  )}
                />
                {connected === null ? "Connecting…" : connected ? "Live" : "Disconnected"}
              </span>
            </>
          ) : friendly ? (
            <>
              <FriendlyLogoMark className="transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-data-[collapsible=icon]:hidden hover:-rotate-6 hover:scale-105" />
              <span className="text-[17px] font-extrabold tracking-tight group-data-[collapsible=icon]:hidden">servedev</span>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold transition-colors duration-500 group-data-[collapsible=icon]:hidden",
                  connected === null && "bg-status-stopped-soft text-status-stopped-foreground",
                  connected === true && "bg-status-running-soft text-status-running-foreground",
                  connected === false && "bg-status-crashed-soft text-status-crashed-foreground"
                )}
              >
                {/* A calm heartbeat while live, a pulse while (re)connecting. */}
                <span aria-hidden className={cn("size-1.5 rounded-full bg-current", connected === true && "friendly-live", connected === null && "friendly-pulse")} />
                {connected === null ? "Connecting…" : connected ? "Live" : "Disconnected"}
              </span>
            </>
          ) : (
            <>
              <span className="font-semibold group-data-[collapsible=icon]:hidden">servedev</span>
              <span className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                {connected === null ? "Connecting…" : connected ? "Live" : "Disconnected"}
              </span>
            </>
          )}
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-sm" className="ml-auto group-data-[collapsible=icon]:ml-0 friendly:bg-primary/10 friendly:text-primary friendly:hover:bg-primary/20 friendly:hover:text-primary friendly:dark:hover:bg-primary/20" onClick={onNew} aria-label="New server" />}
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipContent side="right">
              New server <Kbd>N</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
        {profileControls}
        {/* Shrunk to icons: search becomes a button that expands the sidebar. */}
        <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Search servers ( / )" onClick={focusSearch}>
              <SearchIcon />
              <span>Search</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="relative group-data-[collapsible=icon]:hidden">
          <Label htmlFor="server-search" className="sr-only">
            Search servers
          </Label>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 opacity-50 select-none" />
          <SidebarInput
            id="server-search"
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("")
                e.currentTarget.blur()
              }
            }}
            placeholder="Search name, port, project…"
            className="pr-8 pl-8 terminal:pr-7 terminal:placeholder:text-xs"
          />
          {!query && <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>}
        </div>
        <ToggleGroup
          variant="outline"
          size="sm"
          value={[status]}
          onValueChange={(v) => v[0] && changeStatus(v[0] as StatusFilter)}
          aria-label="Filter by status"
          className="w-full group-data-[collapsible=icon]:hidden terminal:gap-1"
        >
          {FILTERS.map((f) => (
            <Hint key={f.value} label={`${f.hint} (${counts[f.value]})`}>
              <ToggleGroupItem value={f.value} className="flex-1 px-1.5 text-xs terminal:flex-auto terminal:gap-1 terminal:px-1.5 terminal:text-[11px] studio:min-w-0 studio:flex-auto studio:gap-1 studio:px-1.5 studio:text-[11.5px] friendly:flex-auto friendly:gap-1">
                {f.label}
                {f.value === "crashed" && counts.crashed > 0 && (
                  <span className="text-destructive tabular-nums studio:-mr-0.5 studio:inline-flex studio:h-4 studio:min-w-4 studio:items-center studio:justify-center studio:rounded-full studio:bg-destructive studio:px-1 studio:text-[10px] studio:leading-none studio:font-semibold studio:text-white studio:animate-in studio:zoom-in-50 studio:duration-300 studio:dark:text-[oklch(0.18_0.02_25)] friendly:rounded-full friendly:bg-status-crashed-soft friendly:px-1.5 friendly:text-[11px] friendly:leading-4 friendly:font-bold friendly:text-status-crashed-foreground">
                    {counts.crashed}
                  </span>
                )}
              </ToggleGroupItem>
            </Hint>
          ))}
        </ToggleGroup>
      </SidebarHeader>
      {/* shadcn disables scrolling in the icon rail; with many servers the bottom ones would be unreachable. */}
      <SidebarContent className="group-data-[collapsible=icon]:overflow-auto">
        {/* Studio style: shimmering placeholder rows while the first connection is pending. */}
        {studio && connected === null && visible.length === 0 && (
          <div aria-hidden className="flex flex-col gap-1 p-2 group-data-[collapsible=icon]:hidden">
            <span className="studio-skeleton mx-2 mt-2 mb-1 h-2.5 w-16 rounded-full" />
            {[0.72, 0.5, 0.64, 0.42].map((w, i) => (
              <span key={i} className="flex h-12 items-center gap-2.5 px-2">
                <span className="studio-skeleton size-2 shrink-0 rounded-full" />
                <span className="flex flex-1 flex-col gap-1.5">
                  <span className="studio-skeleton h-2.5 rounded-full" style={{ width: `${w * 100}%` }} />
                  <span className="studio-skeleton h-2 w-1/3 rounded-full opacity-70" />
                </span>
              </span>
            ))}
          </div>
        )}
        {/* Friendly style: warm shimmering placeholders while the first list loads. */}
        {friendly && connected === null && visible.length === 0 && (
          <div aria-hidden className="flex flex-col gap-1 p-3 group-data-[collapsible=icon]:hidden">
            <div className="friendly-shimmer mb-2 ml-2 h-3 w-20 rounded-full" />
            {[0.9, 0.7, 0.8, 0.6].map((w, i) => (
              <div key={i} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
                <div className="friendly-shimmer size-2.5 rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="friendly-shimmer h-3 rounded-full" style={{ width: `${w * 100}%` }} />
                  <div className="friendly-shimmer h-2.5 w-1/2 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        )}
        {filtering && visible.length === 0 && (
          <div className="flex flex-col items-start gap-1 px-4 py-6 text-sm text-muted-foreground group-data-[collapsible=icon]:hidden studio:animate-in studio:fade-in-0 studio:duration-300">
            {studio && <NoMatchIllustration className="mb-2" />}
            No servers match{query.trim() ? ` "${query.trim()}"` : ""}{status !== "all" ? ` in ${status}` : ""}.
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => {
                setQuery("")
                changeStatus("all")
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
        {sections
          ? sections.map(({ machine, visible: vis, counts: c }) => {
              // While filtering, every match shows (folds wait), and machines without any are left out.
              if (filtering && vis.length === 0) return null
              const folded = !filtering && folds.isFolded(machine?.name)
              return (
                <section key={machine?.name ?? "\u0000local"} aria-label={machine?.name ?? machines.localName} className="flex flex-col">
                  <MachineHeader machine={machine} counts={c} folded={folded} onToggle={() => folds.toggle(machine?.name)} now={now} />
                  <MachineRailMarker machine={machine} counts={c} folded={folded} onToggle={() => folds.toggle(machine?.name)} now={now} />
                  {!folded && vis.map((g) => renderGroup(g, machine))}
                  {!folded && !filtering && vis.length === 0 && (machine?.state ?? "connected") === "connected" && (
                    <p className="px-4 pt-1 pb-3 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                      {machine ? `No servers on ${machine.name} yet. Start one there and it shows up here.` : "No servers here yet."}
                    </p>
                  )}
                </section>
              )
            })
          : visible.map((g) => renderGroup(g))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
