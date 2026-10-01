import * as React from "react"
import { GitBranchIcon, UsersIcon } from "lucide-react"

import { Hint, TruncatedText } from "@/components/hint"
import { ProfileAccounts } from "@/components/profile-accounts"
import { StatusDot } from "@/components/status-dot"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ACTIVE, api, type Profile, type Selections, type Server } from "@/lib/api"

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/

/** Merge picks over defaults, field by field. */
function overlay(base: Selections, top: Selections): Selections {
  const out: Selections = {}
  for (const id of new Set([...Object.keys(base), ...Object.keys(top)])) out[id] = { ...(base[id] ?? {}), ...(top[id] ?? {}) }
  return out
}

/**
 * Create a profile, or edit one when `profile` is set. Servers start in the order they were ticked.
 * A shared profile (from a repo's servedev.json) edits that file for its servers, order,
 * description and what its servers need; which servers you skip and your own accounts stay in
 * your config.
 */
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
  const shared = profile?.kind === "shared"
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [members, setMembers] = React.useState<string[]>([])
  const [skipped, setSkipped] = React.useState<string[]>([])
  const [accounts, setAccounts] = React.useState<Selections>({})
  const [needs, setNeeds] = React.useState<Selections>({})
  const [share, setShare] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setName(profile?.name ?? "")
    setDescription(profile?.description ?? "")
    // A new profile starts from whatever is running now.
    setMembers(
      profile ? [...profile.servers, ...profile.skipped] : [...servers.values()].filter((s) => ACTIVE.includes(s.status)).map((s) => s.id)
    )
    setSkipped(profile?.skipped ?? [])
    setAccounts((profile?.kind === "shared" ? profile.mine : profile?.accounts) ?? {})
    setNeeds(profile?.needs ?? {})
    setShare(false)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile])

  // A shared profile can only hold its own repo's (worktree's) servers.
  const choices = React.useMemo(
    () => [...servers.values()].filter((s) => !shared || s.project === profile!.project),
    [servers, shared, profile]
  )
  const byProject = React.useMemo(() => {
    const groups = new Map<string, Server[]>()
    for (const s of choices) {
      if (!groups.has(s.project)) groups.set(s.project, [])
      groups.get(s.project)!.push(s)
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, list]) => [p, list.sort((a, b) => a.name.localeCompare(b.name))] as const)
  }, [choices])

  const memberProjects = [...new Set(members.map((id) => servers.get(id)?.project).filter(Boolean))] as string[]
  const canShare = memberProjects.length === 1
  const sharing = shared || (share && canShare)
  const emailInNeeds = Object.values(needs).some((sel) => Object.values(sel).some((v) => EMAIL.test(v)))

  function toggle(id: string, on: boolean) {
    setMembers((m) => (on ? [...m.filter((x) => x !== id), id] : m.filter((x) => x !== id)))
    if (!on) setSkipped((k) => k.filter((x) => x !== id))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      let r: { profile: Profile }
      if (profile) {
        r = await api<{ profile: Profile }>("/api/profiles/update", {
          id: profile.id,
          version: profile.version,
          rename: name.trim(),
          description,
          servers: members,
          accounts,
          ...(shared ? { needs, skip: skipped.filter((id) => members.includes(id)) } : {}),
        })
      } else {
        r = await api<{ profile: Profile }>("/api/profiles", {
          name: name.trim(),
          description: description || undefined,
          servers: members,
          accounts,
          ...(sharing ? { shared: true, project: memberProjects[0] } : {}),
        })
      }
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
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {profile ? `Edit ${profile.name}` : "New profile"}
            {shared && (
              <Badge variant="secondary">
                <UsersIcon data-icon="inline-start" />
                Shared · {profile!.project}
              </Badge>
            )}
            {shared && profile!.branch && (
              <Badge variant="outline" className="font-mono">
                <GitBranchIcon data-icon="inline-start" />
                {profile!.branch}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {shared ? (
              <>
                Its servers, order, description and what they need are saved to <span className="font-mono break-all">{profile!.file}</span>
                {profile!.uncommitted ? ", which has uncommitted changes" : ""}. Commit it to share the change. Skipped servers and your own
                accounts stay in your config.
              </>
            ) : (
              "A profile is a set of servers you work on together, from any project. Switching to it shows just those servers; starting it leaves everything else running."
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="flex flex-col gap-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="profile-name">Name</FieldLabel>
              <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Capcon full stack" autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor="profile-description">Description</FieldLabel>
              <Textarea
                id="profile-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="API and Horizon against the dev database"
                rows={2}
              />
            </Field>
            <FieldSet>
              <FieldLegend variant="label">Servers</FieldLegend>
              <FieldDescription>
                They start in the order you tick them, so tick an API before the apps that use it.
                {shared && " Only this repo's servers can be in a shared profile. Turn off the switch to skip one yourself without changing it for the team."}
              </FieldDescription>
              {choices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No servers yet. Start one, then add it here.</p>
              ) : (
                <ScrollArea className="max-h-72 rounded-lg border">
                  <div className="flex flex-col py-1">
                    {byProject.map(([project, list]) => (
                      <div key={project} className="flex flex-col">
                        <span className="px-3 pt-2 pb-1 text-xs text-muted-foreground">{project}</span>
                        {list.map((s) => {
                          const position = members.indexOf(s.id)
                          const isSkipped = skipped.includes(s.id)
                          return (
                            <div key={s.id} className="flex items-center gap-3 px-3 py-1.5 hover:bg-muted/50">
                              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                                <Checkbox checked={position >= 0} onCheckedChange={(v) => toggle(s.id, v)} />
                                <StatusDot status={s.status} />
                                <TruncatedText
                                  text={s.name}
                                  className={isSkipped ? "flex-1 text-sm text-muted-foreground line-through" : "flex-1 text-sm"}
                                />
                              </label>
                              {shared && position >= 0 && (
                                <Hint label={isSkipped ? "Skipped when you start this profile (only for you)" : "Starts with this profile. Turn off to skip it, only for you."}>
                                  <Switch
                                    size="sm"
                                    checked={!isSkipped}
                                    onCheckedChange={(on) => setSkipped((k) => (on ? k.filter((x) => x !== s.id) : [...k, s.id]))}
                                    aria-label={`Start ${s.name} with this profile`}
                                  />
                                </Hint>
                              )}
                              {position >= 0 && (
                                <span className="w-4 text-right text-xs text-muted-foreground tabular-nums" title="Start order">
                                  {position + 1}
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </FieldSet>
            {!profile && (
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="profile-share">Share with the repo</FieldLabel>
                  <FieldDescription>
                    {canShare
                      ? `Saved to ${memberProjects[0]}'s servedev.json, so everyone who clones it gets this profile once you commit.`
                      : "Only possible when all its servers are from one repo."}
                  </FieldDescription>
                </FieldContent>
                <Switch id="profile-share" checked={share && canShare} disabled={!canShare} onCheckedChange={setShare} />
              </Field>
            )}
            {shared ? (
              <>
                <ProfileAccounts
                  legend="What its servers need"
                  description="Saved to servedev.json for everyone, e.g. a Google Cloud project. Leave personal accounts (emails) to the section below."
                  value={needs}
                  onChange={setNeeds}
                  // Problems (e.g. missing credentials) show once, under your accounts where they're fixed.
                  check={{}}
                />
                {emailInNeeds && (
                  <Alert>
                    <AlertDescription>An email here would be committed for the whole team. Pick your own account below instead.</AlertDescription>
                  </Alert>
                )}
                <ProfileAccounts
                  legend="Your accounts"
                  description="Only for you, saved in your config. Fields left on the repo's value use what servedev.json says."
                  value={accounts}
                  onChange={setAccounts}
                  defaults={needs}
                  check={overlay(needs, accounts)}
                />
              </>
            ) : (
              <ProfileAccounts
                value={accounts}
                onChange={setAccounts}
                description={
                  sharing
                    ? "Servers in this profile use these instead of this machine's accounts. Values like a project go to servedev.json; personal accounts (emails) stay in your config."
                    : undefined
                }
              />
            )}
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
              {profile ? (shared ? "Save to servedev.json" : "Save profile") : sharing ? "Create shared profile" : "Create profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
