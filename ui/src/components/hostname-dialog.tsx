import * as React from "react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { api, type Server } from "@/lib/api"

interface HostnameResponse {
  server: Server
  proxy: { running: boolean; port?: number; error?: string }
  note?: string
}

/** Set or remove a server's custom hostname, e.g. keel.localhost. */
export function HostnameDialog({ server, open, onOpenChange }: { server: Server; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [value, setValue] = React.useState("")
  const [saving, setSaving] = React.useState<"save" | "remove" | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const suggestion = `${server.project}.localhost`

  React.useEffect(() => {
    if (!open) return
    setValue(server.hostname ?? "")
    setError(null)
  }, [open, server.hostname])

  async function submit(hostname: string | null) {
    setSaving(hostname ? "save" : "remove")
    setError(null)
    try {
      const r = await api<HostnameResponse>("/api/hostname", { id: server.id, hostname })
      if (!hostname) toast.success(`Removed ${server.hostname}`)
      else {
        const extra = !r.proxy.running
          ? `The proxy couldn't start: ${r.proxy.error}`
          : r.proxy.port !== 80
            ? `Port 80 was unavailable, so it uses port ${r.proxy.port}.`
            : undefined
        toast.success(`${server.name} is now ${r.server.customUrl ?? r.server.hostname}`, { description: [extra, r.note].filter(Boolean).join(" ") || undefined })
      }
      onOpenChange(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(null)
    }
  }

  const trimmed = value.trim()
  const notLocal = trimmed !== "" && !/\.localhost\.?(:\d+)?\/?$/i.test(trimmed.replace(/^[a-z]+:\/\//i, ""))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Custom URL</DialogTitle>
          <DialogDescription>
            Reach {server.name} at a name instead of a port. servedev runs a small proxy on this Mac that sends the name to whatever port the
            server is using, including after restarts.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (trimmed) void submit(trimmed)
          }}
          className="flex flex-col gap-6"
        >
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="hostname">Hostname</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>http://</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id="hostname"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={suggestion}
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  aria-invalid={error ? true : undefined}
                />
              </InputGroup>
              <FieldDescription>
                {notLocal
                  ? `Names outside .localhost don't point at this Mac on their own; you'd also need a "127.0.0.1 ${trimmed}" line in /etc/hosts.`
                  : "Names ending in .localhost work in every browser without any setup. Only this Mac can reach them."}
              </FieldDescription>
            </Field>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
          <DialogFooter>
            {server.hostname && (
              <Button type="button" variant="ghost" className="sm:mr-auto" disabled={!!saving} onClick={() => submit(null)}>
                {saving === "remove" && <Spinner data-icon="inline-start" />}
                Remove
              </Button>
            )}
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!trimmed || !!saving}>
              {saving === "save" && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
