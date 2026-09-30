import * as React from "react"
import { FolderOpenIcon, LayoutGridIcon, MoreHorizontalIcon, RotateCcwIcon, SaveIcon, ServerIcon, SquareIcon, TriangleAlertIcon, UploadIcon } from "lucide-react"

import { AccountsSheet } from "@/components/accounts-sheet"
import { AppSidebar } from "@/components/app-sidebar"
import { ConfigIssues } from "@/components/config-issues"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Hint, TruncatedText } from "@/components/hint"
import { BulkActions } from "@/components/bulk-actions"
import { ExternalDetail } from "@/components/external-detail"
import { GridView } from "@/components/grid-view"
import { HungServers } from "@/components/hung-servers"
import { NewServerDialog } from "@/components/new-server-dialog"
import { ProfileDialog } from "@/components/profile-dialog"
import { ProfileSwitcher, shareTarget } from "@/components/profile-switcher"
import { SaveGridDialog } from "@/components/save-grid-dialog"
import { ServerDetail } from "@/components/server-detail"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { AccountsContext, ActiveProfileContext, useAccounts } from "@/hooks/use-accounts"
import { useCustomGrid } from "@/hooks/use-custom-grid"
import { useExternalServers } from "@/hooks/use-external"
import { useNow, useServedev } from "@/hooks/use-servedev"
import { toast } from "sonner"

import { ACTIVE, CLIENT_ID, api, openUrl, type Profile } from "@/lib/api"
import { groupEntries, viewEntries, type Entry } from "@/lib/entries"

const PROFILE_KEY = "servedev:profile"
const VIEW_KEY = "servedev:view"

type View = "single" | "grid"

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "single"
  } catch {
    return "single"
  }
}

/** The profile last shown. Ids are strings now ("local:Mine"); an old numeric one is resolved by the daemon. */
function loadProfileId(): string | null {
  try {
    return localStorage.getItem(PROFILE_KEY) || null
  } catch {
    return null
  }
}

export function App() {
  const { servers, configured, profiles, config, connected, layoutChange, accountsVersion } = useServedev()
  const accounts = useAccounts(accountsVersion)
  const now = useNow()
  const [profileId, setProfileId] = React.useState<string | null>(loadProfileId)
  const activeProfile = profiles.find((p) => p.id === profileId)
  // A profile saved before profiles moved to config files: its old numeric id maps to a new one.
  React.useEffect(() => {
    if (!profileId || !/^\d+$/.test(profileId) || !connected) return
    api<{ id: string }>(`/api/profiles/resolve?${new URLSearchParams({ ref: profileId })}`)
      .then((r) => switchProfile(r.id))
      .catch(() => switchProfile(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, connected])
  const [view, setViewState] = React.useState<View>(loadView)
  const setView = (v: View) => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // storage unavailable
    }
  }
  // Dev servers running outside servedev show up in their project with a tag, ready to take over.
  const external = useExternalServers(connected === true)
  const allGroups = React.useMemo(() => groupEntries(servers, configured, external.servers), [servers, configured, external.servers])
  // In the custom grid the sidebar is the full list to pick from; in single view a profile narrows it.
  const listProfile = view === "grid" ? undefined : activeProfile
  const { pinned, groups } = React.useMemo(() => viewEntries(allGroups, listProfile), [allGroups, listProfile])
  const entries = [...pinned, ...groups.flatMap(([, es]) => es)]
  const grid = useCustomGrid(activeProfile, layoutChange)
  // Start all / Stop all: the selected profile (in its start order), or with no profile every
  // server servedev tracks, in either view. (Without a profile the sidebar lists all servers.)
  const bulk = activeProfile
    ? { scope: activeProfile.name, ids: activeProfile.servers }
    : { scope: "all servers", ids: entries.flatMap((e) => (e.server ? [e.server.id] : [])) }
  const bulkServers = bulk.ids.flatMap((id) => (servers.get(id) ? [servers.get(id)!] : []))
  const [savingGrid, setSavingGrid] = React.useState(false)

  const [editing, setEditing] = React.useState<{ profile?: Profile } | null>(null)
  const [deleting, setDeleting] = React.useState<Profile | null>(null)
  const [sharing, setSharing] = React.useState<Profile | null>(null)

  async function shareProfile(p: Profile) {
    try {
      const r = await api<{ profile: Profile; savedServers: string[]; notes: string[] }>("/api/profiles/share", { id: p.id })
      switchProfile(r.profile.id)
      toast.success(`${p.name} is shared in ${r.profile.project}`, {
        description:
          `Commit servedev.json to share it with the team.` +
          (r.savedServers.length ? ` Also added to it: ${r.savedServers.join(", ")}.` : "") +
          (r.notes.length ? ` ${r.notes.join(" ")}` : ""),
        duration: 10_000,
      })
    } catch (e) {
      toast.error(`Couldn't share ${p.name}`, { description: (e as Error).message })
    }
  }

  async function duplicateProfile(p: Profile) {
    try {
      const r = await api<{ profile: Profile }>("/api/profiles/duplicate", { id: p.id })
      switchProfile(r.profile.id)
      toast.success(`Made ${r.profile.name}`, { description: "It's yours, in your config: change it freely." })
    } catch (e) {
      toast.error(`Couldn't copy ${p.name}`, { description: (e as Error).message })
    }
  }

  async function gridAction(action: "reset" | "repo") {
    if (!activeProfile) return
    try {
      if (action === "reset") await api("/api/layouts/reset", { scope: grid.scope })
      else await api("/api/layouts", { scope: grid.scope, items: grid.items ?? [], target: "repo" })
      toast.success(action === "reset" ? "Back to the repo's layout" : `Saved as ${activeProfile.name}'s default layout`, {
        description: action === "repo" ? "It's in servedev.json: commit it to share it." : undefined,
      })
    } catch (e) {
      toast.error("Couldn't update the grid", { description: (e as Error).message })
    }
  }
  const [removingProject, setRemovingProject] = React.useState<{ project: string; entries: Entry[] } | null>(null)

  async function removeProject(r: { project: string; entries: Entry[] }) {
    const root = r.entries[0]?.server?.root
    try {
      const res = await api<{ removed: string[] }>("/api/projects/remove", { root })
      toast.success(`Removed ${r.project} from servedev`, {
        description: `${res.removed.length} ${res.removed.length === 1 ? "server" : "servers"} forgotten. The folder and its files are untouched.`,
      })
    } catch (e) {
      toast.error(`Couldn't remove ${r.project}`, { description: (e as Error).message })
    }
  }

  function switchProfile(id: string | null) {
    setProfileId(id)
    try {
      if (id === null) localStorage.removeItem(PROFILE_KEY)
      else localStorage.setItem(PROFILE_KEY, String(id))
    } catch {
      // storage unavailable
    }
  }

  async function deleteProfile(p: Profile) {
    try {
      await api("/api/profiles/delete", { id: p.id })
      if (profileId === p.id) switchProfile(null)
      toast.success(`Deleted ${p.name}`, { description: "Its servers weren't touched." })
    } catch (e) {
      toast.error(`Couldn't delete ${p.name}`, { description: (e as Error).message })
    }
  }

  const [selected, setSelected] = React.useState<string | null>(() => decodeURIComponent(location.hash.slice(1)) || null)
  const current = entries.find((e) => e.key === selected) ?? entries.find((e) => ACTIVE.includes(e.server?.status as never)) ?? entries[0]

  const [creating, setCreating] = React.useState(false)

  // Shortcuts outside text fields: "n" opens the new-server dialog, "o" opens the selected server in a new tab.
  const currentUrl = openUrl(current?.server)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      const key = e.key.toLowerCase()
      if (key === "n") {
        e.preventDefault()
        setCreating(true)
      } else if (key === "o" && currentUrl) {
        e.preventDefault()
        window.open(currentUrl, "_blank", "noopener")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [currentUrl])

  const select = (key: string) => {
    setSelected(key)
    history.replaceState(null, "", `#${encodeURIComponent(key)}`)
  }

  return (
    <AccountsContext.Provider value={accounts}>
    <ActiveProfileContext.Provider value={activeProfile}>
    <SidebarProvider defaultOpen={!document.cookie.includes("sidebar_state=false")}>
      <AppSidebar
        groups={groups}
        pinned={pinned}
        profileControls={
          <>
            <ProfileSwitcher
              profiles={profiles}
              active={activeProfile}
              servers={servers}
              onChange={switchProfile}
              onNew={() => setEditing({})}
              onEdit={(p) => setEditing({ profile: p })}
              onDelete={setDeleting}
              onShare={setSharing}
              onDuplicate={duplicateProfile}
              gridMode={view === "grid"}
            />
            <BulkActions servers={bulkServers} scope={bulk.scope} profileId={activeProfile?.id} />
            <HungServers servers={external.servers} onCleared={external.refresh} />
          </>
        }
        onRemoveProject={(project, projectEntries) => setRemovingProject({ project, entries: projectEntries })}
        grid={view === "grid" ? { ids: grid.ids, onToggle: (id) => (grid.ids.has(id) ? grid.remove(id) : grid.add(id)) } : undefined}
        selected={current?.key ?? null}
        onSelect={select}
        connected={connected}
        now={now}
        onNew={() => setCreating(true)}
      />
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <Hint label="Shrink or expand the sidebar (⌘B)">
            <SidebarTrigger className="-ml-1" />
          </Hint>
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <TruncatedText
            className="text-sm text-muted-foreground"
            text={view === "grid"
              ? activeProfile
                ? activeProfile.kind === "shared"
                  ? `${activeProfile.name}: ${activeProfile.grid.hasOverride ? "your layout (only you see it)" : "the repo's layout; changes are yours only"}`
                  : `${activeProfile.name}: changes save to the profile`
                : "Unsaved grid"
              : current
                ? `${current.project} / ${current.name}`
                : "Dev servers"}
          />
          <div className="ml-auto flex items-center gap-2">
            <AccountsSheet />
            {view === "grid" && activeProfile?.kind === "shared" && (
              <DropdownMenu>
                <Hint label="This grid's layout: yours, or the repo's default everyone starts from">
                  <DropdownMenuTrigger render={<Button size="sm" variant="outline" aria-label="Layout options" />}>
                    <MoreHorizontalIcon data-icon="inline-start" />
                    <span className="max-sm:hidden">Layout</span>
                  </DropdownMenuTrigger>
                </Hint>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuItem disabled={!activeProfile.grid.hasOverride} onClick={() => gridAction("reset")}>
                    <RotateCcwIcon />
                    <div className="grid leading-tight">
                      <span>Reset to the repo's layout</span>
                      <span className="text-xs text-muted-foreground">
                        {activeProfile.grid.hasOverride ? "Drops your arrangement" : "You're already on the repo's layout"}
                      </span>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => gridAction("repo")}>
                    <UploadIcon />
                    <div className="grid leading-tight">
                      <span>Save as the repo's default layout</span>
                      <span className="text-xs text-muted-foreground">Writes it to servedev.json for everyone (commit to share)</span>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {view === "grid" && !activeProfile && (grid.items?.length ?? 0) > 0 && (
              <Hint label="Keep this grid: save its servers and layout as a profile you can reopen and start in one click">
                <Button size="sm" onClick={() => setSavingGrid(true)}>
                  <SaveIcon data-icon="inline-start" />
                  Save as profile
                </Button>
              </Hint>
            )}
            <ToggleGroup size="sm" variant="outline" value={[view]} onValueChange={(v) => v[0] && setView(v[0] as View)} aria-label="View">
              <Hint label="One server at a time, with details, logs, processes and a preview">
                <ToggleGroupItem value="single" aria-label="Single server">
                  <SquareIcon />
                  <span className="max-sm:hidden">Single</span>
                </ToggleGroupItem>
              </Hint>
              <Hint label="Your own grid of servers: drag them in from the list, then arrange and resize the tiles">
                <ToggleGroupItem value="grid" aria-label="Custom grid">
                  <LayoutGridIcon />
                  <span className="max-sm:hidden">Custom grid</span>
                </ToggleGroupItem>
              </Hint>
            </ToggleGroup>
          </div>
        </header>

        {connected && config && <ConfigIssues config={config} />}

        {connected === false && (
          <Alert variant="destructive" className="m-4 w-auto md:mx-6">
            <TriangleAlertIcon />
            <AlertTitle>Can't reach the servedev daemon</AlertTitle>
            <AlertDescription>
              Retrying automatically. If it doesn't come back, run <code className="font-mono">servedev daemon restart</code>.
            </AlertDescription>
          </Alert>
        )}

        {view === "grid" && connected ? (
          grid.items && (
            <GridView
              items={grid.items}
              version={grid.version}
              servers={servers}
              selected={current?.key ?? null}
              onLayout={grid.applyLayout}
              onDropServer={grid.add}
              onRemove={grid.remove}
              onOpenDetails={(id) => {
                select(id)
                setView("single")
              }}
            />
          )
        ) : current?.external ? (
          <ExternalDetail
            key={current.key}
            server={current.external}
            now={now}
            onTakenOver={(id) => {
              external.refresh()
              select(id)
            }}
            onStopped={external.refresh}
          />
        ) : current ? (
          <ServerDetail key={current.key} entry={current} now={now} />
        ) : (
          connected && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ServerIcon />
                </EmptyMedia>
                <EmptyTitle>No servers yet</EmptyTitle>
                <EmptyDescription>
                  Pick a project folder to start one here, or run <code className="font-mono">servedev start</code> in a project. Agents can do the
                  same through the CLI or the MCP server.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => setCreating(true)}>
                  <FolderOpenIcon data-icon="inline-start" />
                  Choose a folder
                </Button>
              </EmptyContent>
            </Empty>
          )
        )}
      </SidebarInset>
      <NewServerDialog open={creating} onOpenChange={setCreating} onStarted={select} />
      <SaveGridDialog
        open={savingGrid}
        onOpenChange={setSavingGrid}
        items={grid.items ?? []}
        onSaved={(p) => {
          // The draft became the profile; start the next draft empty.
          void api("/api/layouts", { scope: "draft", items: [], source: CLIENT_ID }).catch(() => {})
          switchProfile(p.id)
          toast.success(`Saved ${p.name}`, { description: "Changes to this grid now save to the profile." })
        }}
      />
      <ProfileDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        profile={editing?.profile}
        servers={servers}
        onSaved={(p) => switchProfile(p.id)}
      />
      <AlertDialog open={removingProject !== null} onOpenChange={(o) => !o && setRemovingProject(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removingProject?.project} from servedev?</AlertDialogTitle>
            <AlertDialogDescription>
              servedev stops and forgets {removingProject?.entries.length === 1 ? "its server" : `all ${removingProject?.entries.length} of its servers`}
              , with their logs and run history, and takes them off any profiles and grids. The folder and its files are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-60 overflow-auto rounded-lg border py-1 text-sm">
            {removingProject?.entries.map((e) => (
              <li key={e.key} className="flex items-center gap-2 px-3 py-1">
                <span className="font-medium">{e.name}</span>
                <span className="text-muted-foreground">{e.server && ACTIVE.includes(e.server.status) ? "running, will be stopped" : e.server?.status}</span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removingProject && removeProject(removingProject)}>
              Remove {removingProject?.entries.length === 1 ? "1 server" : `${removingProject?.entries.length} servers`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.kind === "shared"
                ? `It's removed from ${deleting.project}'s servedev.json, so once you commit, nobody on the repo has it. Your own changes to it go too. Its servers keep running and stay in the list.`
                : "Only the profile is removed. Its servers keep running and stay in the list."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && deleteProfile(deleting)}>
              Delete profile
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={sharing !== null} onOpenChange={(o) => !o && setSharing(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Share {sharing?.name} with the repo?</AlertDialogTitle>
            <AlertDialogDescription>
              It moves into {sharing && shareTarget(sharing, servers)}'s servedev.json, so everyone who clones the repo gets it once you commit. Servers only
              you have defined are added to servedev.json too, without credentials. Account picks that name a person (emails) stay yours.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => sharing && shareProfile(sharing)}>Share with the repo</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
    </ActiveProfileContext.Provider>
    </AccountsContext.Provider>
  )
}

export default App
