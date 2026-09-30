import * as React from "react"
import { CheckIcon, ExternalLinkIcon, PinIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react"

import { StatusDot } from "@/components/status-dot"
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
import { ACTIVE, ago, openUrl, portOf, statusLabel } from "@/lib/api"
import { SERVER_MIME } from "@/lib/drag"
import { BranchTag } from "@/components/branch-tag"
import { Hint, TruncatedText } from "@/components/hint"
import { branchOf, filterGroups, statusGroup, type Entry, type StatusFilter } from "@/lib/entries"

const FILTERS: { value: StatusFilter; label: string; hint: string }[] = [
  { value: "all", label: "All", hint: "Show every server" },
  { value: "running", label: "Running", hint: "Show only servers that are running or starting" },
  { value: "stopped", label: "Stopped", hint: "Show only servers that were stopped or exited on their own" },
  { value: "crashed", label: "Crashed", hint: "Show only servers that crashed (exited with an error)" },
]
const FILTER_KEY = "servedev:status-filter"
/** Group key for the pinned section; can't collide with a project name. */
const PINNED = "\u0000pinned"

function loadFilter(): StatusFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY)
    if (FILTERS.some((f) => f.value === v)) return v as StatusFilter
  } catch {
    // storage unavailable
  }
  return "all"
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
  /** Set in custom-grid view: rows can be dragged onto the grid or added with +. */
  grid?: { ids: Set<string>; onToggle: (id: string) => void }
  /** Remove a tracked folder: all of its servers. Given the project's tracked servers. */
  onRemoveProject: (project: string, entries: Entry[]) => void
}) {
  const { setOpenMobile, state: sidebarState, setOpen } = useSidebar()
  const collapsed = sidebarState === "collapsed"
  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState<StatusFilter>(loadFilter)
  const searchRef = React.useRef<HTMLInputElement>(null)

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
  const filtering = query.trim() !== "" || status !== "all"

  /** Focus search, expanding the sidebar first if it's shrunk to icons. */
  function focusSearch() {
    if (!collapsed) return searchRef.current?.focus()
    setOpen(true)
    setTimeout(() => searchRef.current?.focus(), 220)
  }

  function changeStatus(next: StatusFilter) {
    setStatus(next)
    try {
      localStorage.setItem(FILTER_KEY, next)
    } catch {
      // storage unavailable
    }
  }

  // "/" focuses search from anywhere outside a text field.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      e.preventDefault()
      focusSearch()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 pl-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:pl-0">
          <span className="font-semibold group-data-[collapsible=icon]:hidden">servedev</span>
          <span className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            {connected === null ? "Connecting…" : connected ? "Live" : "Disconnected"}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-sm" className="ml-auto group-data-[collapsible=icon]:ml-0" onClick={onNew} aria-label="New server" />}
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
            className="pr-8 pl-8"
          />
          {!query && <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>}
        </div>
        <ToggleGroup
          variant="outline"
          size="sm"
          value={[status]}
          onValueChange={(v) => v[0] && changeStatus(v[0] as StatusFilter)}
          aria-label="Filter by status"
          className="w-full group-data-[collapsible=icon]:hidden"
        >
          {FILTERS.map((f) => (
            <Hint key={f.value} label={`${f.hint} (${counts[f.value]})`}>
              <ToggleGroupItem value={f.value} className="flex-1 px-1.5 text-xs">
                {f.label}
                {f.value === "crashed" && counts.crashed > 0 && <span className="text-destructive tabular-nums">{counts.crashed}</span>}
              </ToggleGroupItem>
            </Hint>
          ))}
        </ToggleGroup>
      </SidebarHeader>
      {/* shadcn disables scrolling in the icon rail; with many servers the bottom ones would be unreachable. */}
      <SidebarContent className="group-data-[collapsible=icon]:overflow-auto">
        {filtering && visible.length === 0 && (
          <div className="flex flex-col items-start gap-1 px-4 py-6 text-sm text-muted-foreground group-data-[collapsible=icon]:hidden">
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
        {visible.map(([project, entries]) => (
          <SidebarGroup key={project} className="group/sidebar-group">
            {/* Shrunk to icons the label fades out but still overlaps the first row; let clicks and hover through. */}
            {project !== PINNED && entries.some((e) => e.server) && (
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
                  <PinIcon className="mr-1.5 size-3" />
                  Pinned
                </>
              ) : (
                // All servers in a project share its folder, so they share the branch.
                <span className="flex min-w-0 items-center gap-1.5">
                  <TruncatedText text={project} />
                  {entries.map(branchOf).find(Boolean) && <BranchTag branch={entries.map(branchOf).find(Boolean)!} className="shrink" />}
                </span>
              )}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {entries.map((e) => {
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
                  // Pinned servers come from any project, so say which.
                  const sub = project === PINNED ? `${e.project}, ${state}` : state
                  const port = s && portOf(s)
                  return (
                    <SidebarMenuItem key={e.key}>
                      <SidebarMenuButton
                        draggable={!!grid && !!s && !grid.ids.has(s.id)}
                        onDragStart={(ev) => {
                          if (!s) return
                          ev.dataTransfer.setData(SERVER_MIME, s.id)
                          ev.dataTransfer.setData("text/plain", s.id)
                          ev.dataTransfer.effectAllowed = "copy"
                        }}
                        size="lg"
                        // Outside servers carry a tag line; let the row grow instead of clipping it.
                        className={x || (project === PINNED && branchOf(e)) ? "h-auto min-h-12 py-1.5" : undefined}
                        tooltip={`${e.project} / ${e.name}, ${state}${s?.hostname ? `, ${s.hostname}` : port ? `, :${port}` : ""}`}
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
                            <span aria-hidden className="inline-block size-2 shrink-0 rounded-full border-[1.5px] border-emerald-500" />
                          ) : (
                            <StatusDot status={e.status} />
                          )}
                        </span>
                        <div className="grid flex-1 text-left leading-tight">
                          <TruncatedText text={e.name} className="font-medium" side="right" />
                          <TruncatedText text={sub} className="text-xs text-muted-foreground" side="right" />
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
                        <Hint label={grid.ids.has(s.id) ? "On the grid. Click to take it off (it keeps running)." : "Add to the grid, or drag the row onto it"} side="right">
                          <SidebarMenuAction
                            onClick={() => grid.onToggle(s.id)}
                            aria-label={grid.ids.has(s.id) ? `Remove ${e.name} from the grid` : `Add ${e.name} to the grid`}
                            className="top-3"
                          >
                            {grid.ids.has(s.id) ? <CheckIcon className="text-emerald-600 dark:text-emerald-400" /> : <PlusIcon />}
                          </SidebarMenuAction>
                        </Hint>
                      ) : x?.url ? (
                        <Hint label={`Open ${x.url} in a new tab`} side="right">
                          <SidebarMenuAction
                            render={<a href={x.url} target="_blank" rel="noopener" />}
                            aria-label={`Open ${e.name} in a new tab`}
                            className="top-2.5 aspect-auto h-6 w-auto gap-1 px-1.5 font-mono text-xs tabular-nums [&>svg]:size-3"
                          >
                            <span>{x.url.split(":").pop()}</span>
                            <ExternalLinkIcon />
                          </SidebarMenuAction>
                        </Hint>
                      ) : openUrl(s) ? (
                        // The port (or custom hostname) is the link: always visible, and a real <a>, so middle-click and ⌘-click work too.
                        <Hint label={`Open ${openUrl(s)} in a new tab`} side="right">
                          <SidebarMenuAction
                            render={<a href={openUrl(s)} target="_blank" rel="noopener" />}
                            aria-label={`Open ${e.name} in a new tab`}
                            className="top-2.5 aspect-auto h-6 w-auto max-w-32 gap-1 px-1.5 font-mono text-xs tabular-nums [&>svg]:size-3"
                          >
                            <span className="truncate">{s?.customUrl ? s.hostname : port}</span>
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
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
