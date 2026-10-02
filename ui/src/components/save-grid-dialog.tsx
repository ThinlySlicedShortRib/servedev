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
  const [name, setName] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) {
      setName("")
      setError(null)
    }
  }, [open])

  // Profiles can't hold another machine's servers yet ("pc/..." ids): those tiles stay behind.
  const own = items.filter((it) => !it.i.includes("/"))
  const remote = items.length - own.length

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const { profile } = await api<{ profile: Profile }>("/api/profiles", { name: name.trim(), layout: own, source: CLIENT_ID })
      onSaved(profile)
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save grid as a profile</DialogTitle>
          <DialogDescription>
            The {own.length} {own.length === 1 ? "server" : "servers"} on this grid become a profile with this layout. Pick it from the
            switcher to come back to it, or start all of them at once.
            {remote > 0 &&
              ` ${remote === 1 ? "The server" : `The ${remote} servers`} from other machines can't be part of a profile yet, so ${remote === 1 ? "it isn't" : "they aren't"} included.`}
          </DialogDescription>
        </DialogHeader>
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
            <Button type="submit" disabled={!name.trim() || saving || own.length === 0}>
              {saving && <Spinner data-icon="inline-start" />}
              Save profile
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
