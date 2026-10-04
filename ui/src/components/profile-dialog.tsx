import * as React from "react"
import { GitBranchIcon, UsersIcon } from "@/components/icons"

import { Hint, TruncatedText } from "@/components/hint"
import { MachineIcon, StateDot } from "@/components/machine-ui"
import { ProfileAccounts } from "@/components/profile-accounts"
import { StatusDot } from "@/components/status-dot"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useMachines } from "@/hooks/use-machines"
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
 * Yours can hold servers from any project on any machine (listed by machine, then project). A
 * shared profile (from a repo's servedev.json) edits that file for its servers, order, description
 * and what its servers need; which servers you skip and your own accounts stay in your config. One
 * shared on another machine is edited there, and holds that machine's servers of its repo.
 */
export function ProfileDialog({
  open,
  onOpenChange,
  profile,
  servers,
  preset,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile?: Profile
  servers: Map<string, Server>
  /** Servers a new profile starts with (the sidebar's filtered list); without it, what's running. */
  preset?: string[]
  onSaved: (p: Profile) => void
}) {
  const shared = profile?.kind === "shared"
  const machines = useMachines()
  const there = profile?.machine
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
    // A new profile starts from the servers the sidebar lists while it's filtered, else from whatever
    // is running now, here and on connected machines.
    setMembers(
      profile
        ? profile.members
        : (preset?.filter((id) => servers.has(id)) ?? [...servers.values()].filter((s) => ACTIVE.includes(s.status) && !s.stale).map((s) => s.id))
    )
    setSkipped(profile?.skipped ?? [])
    setAccounts((profile?.kind === "shared" ? profile.mine : profile?.accounts) ?? {})
    setNeeds(profile?.needs ?? {})
    setShare(false)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile])

  // A shared profile can only hold its own repo's (worktree's) servers, on its own machine.
  const choices = React.useMemo(
    () => [...servers.values()].filter((s) => !shared || ((s.machine ?? "") === (there ?? "") && s.project === profile!.project)),
    [servers, shared, there, profile]
  )
  // By machine (this one first, then the others in the sidebar's order), then project.
  const byMachine = React.useMemo(() => {
    const order = ["", ...machines.list.map((m) => m.name)]
    const groups = new Map<string, Map<string, Server[]>>()
    for (const s of choices) {
      const m = s.machine ?? ""
      if (!groups.has(m)) groups.set(m, new Map())
      const projects = groups.get(m)!
      if (!projects.has(s.project)) projects.set(s.project, [])
      projects.get(s.project)!.push(s)
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999) || a.localeCompare(b))
      .map(([machine, projects]) => ({
        machine,
        projects: [...projects.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([p, list]) => [p, list.sort((a, b) => a.name.localeCompare(b.name))] as const),
      }))
  }, [choices, machines.list])
  const showMachines = byMachine.some((g) => g.machine)

  const memberProjects = [...new Set(members.map((id) => servers.get(id)?.project).filter(Boolean))] as string[]
  const memberMachines = [...new Set(members.flatMap((id) => (id.includes("/") ? [id.slice(0, id.indexOf("/"))] : [])))]
  const canShare = memberProjects.length === 1 && memberMachines.length === 0
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
        // Taken off the list: said explicitly, or the daemon keeps ones you skip (and ones from other branches).
        const removed = profile.members.filter((id) => !members.includes(id))
        r = await api<{ profile: Profile }>("/api/profiles/update", {
          id: profile.id,
          version: profile.version,
          rename: name.trim(),
          description,
          servers: members,
          ...(removed.length ? { remove: removed } : {}),
          // Another machine's profile keeps its accounts there (they're set on that machine).
          ...(there ? {} : { accounts }),
          ...(shared ? { ...(there ? {} : { needs }), skip: skipped.filter((id) => members.includes(id)) } : {}),
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
            {there && (
              <Badge variant="outline">
                <MachineIcon machine={machines.get(there)} data-icon="inline-start" />
                on {there}
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
                {there ? ` on ${there}` : ""}
                {profile!.uncommitted ? ", which has uncommitted changes" : ""}. Commit it to share the change. Skipped servers and your own
                accounts stay in your config{there ? ` there` : ""}.
              </>
            ) : (
              `A profile is a set of servers you work on together, from any project${machines.hasRemotes ? " and any machine" : ""}. Switching to it shows just those servers; starting it leaves everything else running.` +
              (!profile && preset ? " It starts with the servers the sidebar lists right now." : "")
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
                {!shared && showMachines && " Each starts on its own machine, after the previous one is ready; ones on a machine that's away are skipped."}
                {shared && ` Only this repo's servers${there ? ` on ${there}` : ""} can be in a shared profile. Turn off the switch to skip one yourself without changing it for the team.`}
              </FieldDescription>
              {choices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No servers yet. Start one, then add it here.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto overscroll-contain rounded-lg border">
                  <div className="flex flex-col py-1">
                    {byMachine.map(({ machine, projects }) => {
                      const m = machines.get(machine)
                      return (
                      <div key={machine || "\u0000here"} className="flex flex-col" role="group" aria-label={machine || machines.localName}>
                        {showMachines && (
                          <span className="flex items-center gap-1.5 border-b px-3 pt-2.5 pb-1.5 text-xs font-medium first:pt-1.5">
                            <MachineIcon machine={m} className="size-3.5 text-muted-foreground" />
                            {machine || machines.localName}
                            {m && m.state !== "connected" && (
                              <span className="flex items-center gap-1 font-normal text-muted-foreground">
                                <StateDot state={m.state} />
                                {m.state}, last known
                              </span>
                            )}
                          </span>
                        )}
                    {projects.map(([project, list]) => (
                      <div key={project} className="flex flex-col">
                        <span className={showMachines ? "px-3 pt-2 pb-1 pl-8 text-xs text-muted-foreground" : "px-3 pt-2 pb-1 text-xs text-muted-foreground"}>{project}</span>
                        {list.map((s) => {
                          const position = members.indexOf(s.id)
                          const isSkipped = skipped.includes(s.id)
                          return (
                            <div key={s.id} className={showMachines ? "flex items-center gap-3 py-1.5 pr-3 pl-8 hover:bg-muted/50" : "flex items-center gap-3 px-3 py-1.5 hover:bg-muted/50"}>
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
                      )
                    })}
                  </div>
                </div>
              )}
            </FieldSet>
            {!profile && (
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="profile-share">Share with the repo</FieldLabel>
                  <FieldDescription>
                    {canShare
                      ? `Saved to ${memberProjects[0]}'s servedev.json, so everyone who clones it gets this profile once you commit.`
                      : memberMachines.length
                        ? `Only for servers of one repo on this machine (it has servers on ${memberMachines.join(", ")}).`
                        : "Only possible when all its servers are from one repo."}
                  </FieldDescription>
                </FieldContent>
                <Switch id="profile-share" checked={share && canShare} disabled={!canShare} onCheckedChange={setShare} />
              </Field>
            )}
            {there ? (
              <FieldSet>
                <FieldLegend variant="label">Accounts</FieldLegend>
                <FieldDescription>
                  {Object.keys(profile!.accounts).length
                    ? `Its servers use ${Object.entries(profile!.accounts)
                        .map(([provider, sel]) => `${provider} ${Object.values(sel).join(", ")}`)
                        .join("; ")}, signed in on ${there}. `
                    : `Its servers use the accounts signed in on ${there}. `}
                  Accounts are {there}'s, so they're picked there: <span className="font-mono">servedev profile accounts "{profile!.name}" …</span> sets them on {there}.
                </FieldDescription>
              </FieldSet>
            ) : shared ? (
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
                    : memberMachines.length
                      ? `Its servers on this machine use these instead of this machine's accounts. Ones on ${memberMachines.join(", ")} use the accounts signed in there.`
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
              {profile ? (shared ? `Save to servedev.json${there ? ` on ${there}` : ""}` : "Save profile") : sharing ? "Create shared profile" : "Create profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
