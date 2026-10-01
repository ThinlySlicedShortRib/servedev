import { CheckIcon, ChevronsUpDownIcon, CopyIcon, GitBranchIcon, LayersIcon, PencilIcon, PlusIcon, Share2Icon, Trash2Icon, UsersIcon } from "@/components/icons"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TruncatedText } from "@/components/hint"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import type { Profile, Server } from "@/lib/api"

function runningCount(p: Profile, servers: Map<string, Server>) {
  return p.servers.filter((id) => ["running", "starting"].includes(servers.get(id)?.status ?? "")).length
}

/** The one project all of a profile's servers are in, if any: sharing puts it in that repo. */
export function shareTarget(p: Profile, servers: Map<string, Server>): string | undefined {
  const projects = new Set(p.servers.map((id) => servers.get(id)?.project ?? id.split(":")[0]))
  return p.kind === "local" && projects.size === 1 ? [...projects][0] : undefined
}

/** "Shared · shop · main" or "Yours" */
export function profileOrigin(p: Profile): string {
  return p.kind === "shared" ? `Shared in ${p.project}${p.branch ? ` · ${p.branch}` : ""}` : "Yours"
}

/** Switches the sidebar between all servers and a profile's servers. Switching never stops anything. */
export function ProfileSwitcher({
  profiles,
  active,
  servers,
  onChange,
  onNew,
  onEdit,
  onDelete,
  onShare,
  onDuplicate,
  gridMode = false,
}: {
  profiles: Profile[]
  active: Profile | undefined
  servers: Map<string, Server>
  onChange: (id: string | null) => void
  onNew: () => void
  onEdit: (p: Profile) => void
  onDelete: (p: Profile) => void
  onShare: (p: Profile) => void
  onDuplicate: (p: Profile) => void
  /** In custom-grid view, "no profile" means the unsaved grid rather than all servers. */
  gridMode?: boolean
}) {
  const noneLabel = gridMode ? "Unsaved grid" : "All servers"
  const mine = profiles.filter((p) => p.kind === "local")
  const shared = profiles.filter((p) => p.kind === "shared")

  const item = (p: Profile) => (
    <DropdownMenuItem key={p.id} onClick={() => onChange(p.id)}>
      {p.kind === "shared" ? <UsersIcon className="text-muted-foreground" /> : <LayersIcon className="text-muted-foreground" />}
      <div className="grid min-w-0 flex-1 leading-tight">
        <TruncatedText text={p.name} />
        {p.kind === "shared" && (
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <TruncatedText text={p.project ?? ""} />
            {p.branch && (
              <>
                <GitBranchIcon className="size-3 shrink-0" />
                <TruncatedText text={p.branch} />
              </>
            )}
            {p.uncommitted && <span className="size-1.5 shrink-0 rounded-full bg-amber-500 terminal:rounded-[1px] terminal:bg-warning studio:bg-warning" aria-label="uncommitted changes" />}
          </span>
        )}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {runningCount(p, servers)}/{p.servers.length}
      </span>
      {active?.id === p.id && <CheckIcon />}
    </DropdownMenuItem>
  )

  const target = active && shareTarget(active, servers)

  return (
    <div className="flex flex-col gap-2">
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  className="data-popup-open:bg-sidebar-accent"
                  // Shown expanded too (shadcn hides it unless collapsed): it explains the control.
                  tooltip={{
                    children: `${active ? `Profile: ${active.name} (${profileOrigin(active)})` : noneLabel}. Switch between all servers and profiles: yours, and ones shared in your repos' servedev.json.`,
                    hidden: false,
                  }}
                />
              }
            >
              {active?.kind === "shared" ? <UsersIcon /> : <LayersIcon />}
              <div className="grid flex-1 text-left leading-tight">
                <TruncatedText text={active ? active.name : noneLabel} className="font-medium" />
                <TruncatedText
                  className="text-xs text-muted-foreground"
                  text={
                    active
                      ? `${profileOrigin(active)}, ${runningCount(active, servers)} of ${active.servers.length} running`
                      : gridMode
                        ? "Save it as a profile to keep it"
                        : `${servers.size} servers`
                  }
                />
              </div>
              <ChevronsUpDownIcon className="ml-auto" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-64" align="start">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => onChange(null)}>
                  {noneLabel}
                  {!active && <CheckIcon className="ml-auto" />}
                </DropdownMenuItem>
              </DropdownMenuGroup>
              {mine.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Your profiles</DropdownMenuLabel>
                    {mine.map(item)}
                  </DropdownMenuGroup>
                </>
              )}
              {shared.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Shared in repos</DropdownMenuLabel>
                    {shared.map(item)}
                  </DropdownMenuGroup>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={onNew}>
                  <PlusIcon />
                  New profile…
                </DropdownMenuItem>
                {active && (
                  <>
                    <DropdownMenuItem onClick={() => onEdit(active)}>
                      <PencilIcon />
                      Edit {active.name}…
                    </DropdownMenuItem>
                    {active.kind === "local" && (
                      <DropdownMenuItem disabled={!target} onClick={() => onShare(active)}>
                        <Share2Icon />
                        <div className="grid leading-tight">
                          <span>Share with the repo…</span>
                          <span className="text-xs text-muted-foreground">
                            {target ? `Moves it into ${target}'s servedev.json` : "Its servers must all be from one repo"}
                          </span>
                        </div>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => onDuplicate(active)}>
                      <CopyIcon />
                      <div className="grid leading-tight">
                        <span>{active.kind === "shared" ? "Make a copy of your own" : `Duplicate ${active.name}`}</span>
                        {active.kind === "shared" && <span className="text-xs text-muted-foreground">Change it freely, without touching the repo</span>}
                      </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => onDelete(active)}>
                      <Trash2Icon />
                      Delete {active.name}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </div>
  )
}
