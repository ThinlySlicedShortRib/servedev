import { CheckIcon, ChevronsUpDownIcon, LayersIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"

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

/** Switches the sidebar between all servers and a profile's servers. Switching never stops anything. */
export function ProfileSwitcher({
  profiles,
  active,
  servers,
  onChange,
  onNew,
  onEdit,
  onDelete,
  gridMode = false,
}: {
  profiles: Profile[]
  active: Profile | undefined
  servers: Map<string, Server>
  onChange: (id: number | null) => void
  onNew: () => void
  onEdit: (p: Profile) => void
  onDelete: (p: Profile) => void
  /** In custom-grid view, "no profile" means the unsaved grid rather than all servers. */
  gridMode?: boolean
}) {
  const noneLabel = gridMode ? "Unsaved grid" : "All servers"

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
                    children: `${active ? `Profile: ${active.name}` : noneLabel}. Switch between all servers and your profiles, or create, edit and delete profiles.`,
                    hidden: false,
                  }}
                />
              }
            >
              <LayersIcon />
              <div className="grid flex-1 text-left leading-tight">
                <TruncatedText text={active ? active.name : noneLabel} className="font-medium" />
                <TruncatedText className="text-xs text-muted-foreground" text={active
                    ? `Profile, ${runningCount(active, servers)} of ${active.servers.length} running`
                    : gridMode
                      ? "Save it as a profile to keep it"
                      : `${servers.size} servers`} />
              </div>
              <ChevronsUpDownIcon className="ml-auto" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-60" align="start">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => onChange(null)}>
                  {noneLabel}
                  {!active && <CheckIcon className="ml-auto" />}
                </DropdownMenuItem>
              </DropdownMenuGroup>
              {profiles.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Profiles</DropdownMenuLabel>
                    {profiles.map((p) => (
                      <DropdownMenuItem key={p.id} onClick={() => onChange(p.id)}>
                        <TruncatedText text={p.name} />
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                          {runningCount(p, servers)}/{p.servers.length}
                        </span>
                        {active?.id === p.id && <CheckIcon />}
                      </DropdownMenuItem>
                    ))}
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
