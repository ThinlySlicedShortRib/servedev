import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { CLIENT_ID, api, type LayoutItem, type Profile } from "@/lib/api"

/** Turn the unsaved custom grid into a profile, keeping its layout. */
export function SaveGridDialog({
  open,
  onOpenChange,
  items,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: LayoutItem[]
  onSaved: (p: Profile) => void
}) {
  // Tiles of servers on other machines ("pc/..." ids) go along: each starts on its own machine.
  const machines = [...new Set(items.flatMap((it) => (it.i.includes("/") ? [it.i.slice(0, it.i.indexOf("/"))] : [])))]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save grid as a profile</DialogTitle>
          <DialogDescription>
            The {items.length} {items.length === 1 ? "server" : "servers"} on this grid become a profile with this layout. Pick it from the
            switcher to come back to it, or start all of them at once.
            {machines.length > 0 &&
              ` Servers on ${machines.join(" and ")} stay on ${machines.length === 1 ? "that machine" : "their machines"}: starting the profile starts each one there.`}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts with an empty name. */}
        <SaveGridForm items={items} onSaved={onSaved} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function SaveGridForm({ items, onSaved, onDone }: { items: LayoutItem[]; onSaved: (p: Profile) => void; onDone: () => void }) {
  const [name, setName] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const { profile } = await api<{ profile: Profile }>("/api/profiles", { name: name.trim(), layout: items, source: CLIENT_ID })
      onSaved(profile)
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="grid-profile-name">Name</FieldLabel>
          <Input id="grid-profile-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Keel + Capcon review" autoFocus />
          <FieldDescription>Servers start in reading order: top row first, left to right.</FieldDescription>
        </Field>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={!name.trim() || saving || items.length === 0}>
          {saving && <Spinner data-icon="inline-start" />}
          Save profile
        </Button>
      </DialogFooter>
    </form>
  )
}
