import * as React from "react"

import { TruncatedText } from "@/components/hint"
import { ProfileAccounts } from "@/components/profile-accounts"
import { StatusDot } from "@/components/status-dot"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { ACTIVE, api, type Profile, type Selections, type Server } from "@/lib/api"

/** Create a profile, or edit one when `profile` is set. Servers start in the order they were ticked. */
export function ProfileDialog({
  open,
  onOpenChange,
  profile,
  servers,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile?: Profile
  servers: Map<string, Server>
  onSaved: (p: Profile) => void
}) {
  const [name, setName] = React.useState("")
  const [members, setMembers] = React.useState<string[]>([])
  const [accounts, setAccounts] = React.useState<Selections>({})
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setName(profile?.name ?? "")
    // A new profile starts from whatever is running now.
    setMembers(profile ? profile.servers : [...servers.values()].filter((s) => ACTIVE.includes(s.status)).map((s) => s.id))
    setAccounts(profile?.accounts ?? {})
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile])

  const byProject = React.useMemo(() => {
    const groups = new Map<string, Server[]>()
    for (const s of servers.values()) {
      if (!groups.has(s.project)) groups.set(s.project, [])
      groups.get(s.project)!.push(s)
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, list]) => [p, list.sort((a, b) => a.name.localeCompare(b.name))] as const)
  }, [servers])

  function toggle(id: string, on: boolean) {
    setMembers((m) => (on ? [...m.filter((x) => x !== id), id] : m.filter((x) => x !== id)))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const r = profile
        ? await api<{ profile: Profile }>("/api/profiles/update", { id: profile.id, rename: name.trim(), servers: members, accounts })
        : await api<{ profile: Profile }>("/api/profiles", { name: name.trim(), servers: members, accounts })
      onSaved(r.profile)
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{profile ? `Edit ${profile.name}` : "New profile"}</DialogTitle>
          <DialogDescription>
            A profile is a set of servers you work on together, from any project. Switching to it shows just those servers; starting it
            leaves everything else running.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="flex flex-col gap-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="profile-name">Name</FieldLabel>
              <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Capcon full stack" autoFocus />
            </Field>
            <FieldSet>
              <FieldLegend variant="label">Servers</FieldLegend>
              <FieldDescription>They start in the order you tick them, so tick an API before the apps that use it.</FieldDescription>
              {servers.size === 0 ? (
                <p className="text-sm text-muted-foreground">No servers yet. Start one, then add it here.</p>
              ) : (
                <ScrollArea className="max-h-72 rounded-lg border">
                  <div className="flex flex-col py-1">
                    {byProject.map(([project, list]) => (
                      <div key={project} className="flex flex-col">
                        <span className="px-3 pt-2 pb-1 text-xs text-muted-foreground">{project}</span>
                        {list.map((s) => {
                          const position = members.indexOf(s.id)
                          return (
                            <label key={s.id} className="flex cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-muted/50">
                              <Checkbox checked={position >= 0} onCheckedChange={(v) => toggle(s.id, v)} />
                              <StatusDot status={s.status} />
                              <TruncatedText text={s.name} className="flex-1 text-sm" />
                              {position >= 0 && (
                                <span className="text-xs text-muted-foreground tabular-nums" title="Start order">
                                  {position + 1}
                                </span>
                              )}
                            </label>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </FieldSet>
            <ProfileAccounts value={accounts} onChange={setAccounts} />
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!name.trim() || saving}>
              {saving && <Spinner data-icon="inline-start" />}
              {profile ? "Save profile" : "Create profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
