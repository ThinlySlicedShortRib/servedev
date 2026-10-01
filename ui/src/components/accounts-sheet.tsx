import * as React from "react"
import { CircleAlertIcon, EllipsisIcon, InfoIcon, KeyRoundIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "@/components/icons"
import { toast } from "sonner"

import { AccountPicker } from "@/components/account-picker"
import { AddPlatformDialog } from "@/components/add-platform-dialog"
import { Hint } from "@/components/hint"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { useAccountsContext } from "@/hooks/use-accounts"
import { runAccountAction } from "@/lib/accounts"
import { api, type AccountField, type AccountProvider, type ProviderSpec } from "@/lib/api"

interface Manage {
  edit: (id: string) => void
  remove: (p: { id: string; name: string }) => void
}

/** This machine's platform accounts (gcloud, GitHub, user-added providers), switchable in place. */
export function AccountsSheet() {
  const { providers, hidden, errors, dir, loading, refresh } = useAccountsContext()
  const warnings = (providers ?? []).flatMap((p) => p.notices.filter((n) => n.level === "warning")).length + errors.length
  const [adding, setAdding] = React.useState(false)
  const [editing, setEditing] = React.useState<ProviderSpec | undefined>()
  const [removing, setRemoving] = React.useState<{ id: string; name: string } | null>(null)

  const manage: Manage = {
    edit: (id) =>
      void api<{ spec: ProviderSpec }>(`/api/accounts/providers/${encodeURIComponent(id)}/spec`)
        .then((r) => setEditing(r.spec))
        .catch((e) => toast.error("Couldn't open it for editing", { description: (e as Error).message })),
    remove: setRemoving,
  }

  async function remove() {
    const target = removing
    setRemoving(null)
    if (!target) return
    try {
      const r = await api<{ restoredBuiltIn: boolean; clearedFrom: string[] }>("/api/accounts/providers/delete", { id: target.id })
      const notes = [
        r.restoredBuiltIn && `The built-in ${target.name} is back in use.`,
        r.clearedFrom.length && `Profiles that picked accounts for it (${r.clearedFrom.join(", ")}) now use this machine's.`,
      ].filter(Boolean)
      toast.success(`Removed ${target.name}`, { description: notes.join(" ") || undefined })
    } catch (e) {
      toast.error(`Couldn't remove ${target.name}`, { description: (e as Error).message })
    }
  }

  return (
    <Sheet>
      <Hint label="This machine's accounts for Google Cloud, GitHub and other platforms. Profiles can pick different ones for their servers.">
        <SheetTrigger render={<Button variant="outline" size="sm" className="relative" />}>
          <KeyRoundIcon data-icon="inline-start" />
          <span className="max-sm:hidden">Accounts</span>
          {warnings > 0 && <span className="absolute -top-1 -right-1 size-2 rounded-full bg-amber-500 terminal:rounded-[1px] terminal:bg-warning studio:bg-warning studio:ring-2 studio:ring-background" aria-label={`${warnings} warnings`} />}
        </SheetTrigger>
      </Hint>
      <SheetContent className="gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Accounts</SheetTitle>
          <SheetDescription>
            What this machine is signed in as. Switching here changes it for every terminal and tool. To use other accounts for some servers only,
            pick them in a profile.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-6 px-4 pb-4">
            {errors.map((e) => (
              <Alert key={e.file} variant="destructive">
                <CircleAlertIcon />
                <AlertTitle>A provider file didn't load</AlertTitle>
                <AlertDescription>
                  <span className="font-mono break-all">{e.file}</span>: {e.message}
                </AlertDescription>
              </Alert>
            ))}
            {providers === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No platform CLIs found. Install gcloud or gh, or add a platform.</p>
            ) : (
              providers.map((p, i) => (
                <React.Fragment key={p.id}>
                  {i > 0 && <Separator />}
                  <ProviderSection provider={p} manage={manage} />
                </React.Fragment>
              ))
            )}
            {hidden.length > 0 && (
              <section className="flex flex-col gap-2" aria-label="Added, CLI not installed">
                <Separator />
                <p className="text-xs text-muted-foreground">Added, but their CLI isn't installed, so they're hidden:</p>
                <ul className="flex flex-col gap-1">
                  {hidden.map((h) => (
                    <li key={h.id} className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">
                        {h.name} <span className="font-mono text-xs text-muted-foreground">({h.id})</span>
                      </span>
                      {h.removable && (
                        <>
                          <Hint label={`Edit ${h.name}`}>
                            <Button variant="ghost" size="icon-xs" aria-label={`Edit ${h.name}`} onClick={() => manage.edit(h.id)}>
                              <PencilIcon />
                            </Button>
                          </Hint>
                          <Hint label={`Remove ${h.name}`}>
                            <Button variant="ghost" size="icon-xs" aria-label={`Remove ${h.name}`} onClick={() => manage.remove(h)}>
                              <Trash2Icon />
                            </Button>
                          </Hint>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </ScrollArea>
        <SheetFooter className="border-t">
          <p className="text-xs text-muted-foreground">
            Platforms are JSON files in <span className="font-mono break-all">{dir || "~/.servedev/providers"}</span>; see docs/providers.md.
          </p>
          <div className="flex gap-2">
            <Hint label="Add AWS, Docker, Kubernetes and more from the catalog, or describe your own CLI">
              <Button size="sm" className="flex-1" onClick={() => setAdding(true)}>
                <PlusIcon data-icon="inline-start" />
                Add platform
              </Button>
            </Hint>
            <Hint label="Re-read provider files and ask each CLI again">
              <Button variant="outline" size="sm" onClick={() => void refresh(true)} disabled={loading}>
                {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                Reload
              </Button>
            </Hint>
          </div>
        </SheetFooter>
      </SheetContent>
      <AddPlatformDialog open={adding} onOpenChange={setAdding} />
      <AddPlatformDialog open={!!editing} onOpenChange={(v) => !v && setEditing(undefined)} editing={editing} />
      <AlertDialog open={!!removing} onOpenChange={(v) => !v && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes its file from {dir || "~/.servedev/providers"}. Its CLI and accounts aren't touched. Profiles that picked accounts for it go back to
              this machine's.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}

function ProviderSection({ provider: p, manage }: { provider: AccountProvider; manage: Manage }) {
  return (
    <section className="flex flex-col gap-3" aria-label={p.name}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {p.name}
            {p.source !== "built in" && (
              <Hint label={`Added from ${p.source}`}>
                <Badge variant="outline">custom</Badge>
              </Hint>
            )}
          </h3>
          {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
        </div>
        {(p.actions.length > 0 || p.editable || p.removable) && (
          <DropdownMenu>
            <Hint label={`More ${p.name} actions`}>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More ${p.name} actions`} />}>
                <EllipsisIcon />
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end" className="w-72">
              {p.actions.map((a) => (
                <DropdownMenuItem key={a.id} onClick={() => void runAccountAction(p, a.id, defaultArgs(p))} className="flex-col items-start gap-0.5">
                  <span>{a.label}</span>
                  <span className="text-xs text-muted-foreground">{a.description}</span>
                </DropdownMenuItem>
              ))}
              {p.actions.length > 0 && (p.editable || p.removable) && <DropdownMenuSeparator />}
              {p.editable && (
                <DropdownMenuItem onClick={() => manage.edit(p.id)}>
                  <PencilIcon />
                  Edit {p.name}
                </DropdownMenuItem>
              )}
              {p.removable && (
                <DropdownMenuItem variant="destructive" onClick={() => manage.remove(p)}>
                  <Trash2Icon />
                  Remove {p.name}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {p.notices.map((n, i) => (
        <Alert key={i} variant={n.level === "warning" ? "destructive" : "default"}>
          {n.level === "warning" ? <CircleAlertIcon /> : <InfoIcon />}
          <AlertDescription className="flex flex-col items-start gap-2 [overflow-wrap:anywhere]">
            {n.message}
            {n.fix && (
              <Button
                size="xs"
                variant="outline"
                className="h-auto max-w-full py-1 text-left whitespace-normal"
                onClick={() => void runAccountAction(p, n.fix!.action, n.fix!.args)}
              >
                {n.fix.label}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ))}
      <FieldGroup className="gap-3">
        {p.fields.map((f) => (
          <MachineField key={f.id} provider={p} field={f} />
        ))}
      </FieldGroup>
    </section>
  )
}

/** Actions take the machine's current first field (e.g. the gcloud account) as a hint. */
function defaultArgs(p: AccountProvider): Record<string, string> {
  const first = p.fields[0]
  return first?.current ? { [first.id]: first.current } : {}
}

function MachineField({ provider: p, field: f }: { provider: AccountProvider; field: AccountField }) {
  const [saving, setSaving] = React.useState(false)
  const id = `acct-${p.id}-${f.id}`

  async function change(value: string | undefined) {
    if (!value || value === f.current) return
    setSaving(true)
    try {
      await api("/api/accounts/set", { provider: p.id, field: f.id, value })
      toast.success(`${p.name} ${f.label.toLowerCase()}: ${value}`, {
        description: `Switched for this machine. Servers that read ${p.name} credentials only at startup need a restart to pick it up.`,
      })
    } catch (e) {
      toast.error(`Couldn't switch ${p.name} ${f.label.toLowerCase()}`, { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Field>
      <FieldLabel htmlFor={id} className="flex items-center gap-2">
        {f.label}
        {saving && <Spinner />}
      </FieldLabel>
      {f.settable ? (
        <AccountPicker id={id} options={f.options} value={f.current} onChange={change} freeform={f.freeform} disabled={saving} placeholder="Not set" />
      ) : (
        <p className="text-sm">{f.current ?? <span className="text-muted-foreground">Not set</span>}</p>
      )}
      {f.error ? (
        <FieldDescription className="text-destructive">{f.error}</FieldDescription>
      ) : (
        f.description && <FieldDescription>{f.description}</FieldDescription>
      )}
      {!f.settable && <FieldDescription>Can't be switched machine-wide; pick it per profile.</FieldDescription>}
    </Field>
  )
}
