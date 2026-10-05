import * as React from "react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ACTIVE, api, type Server } from "@/lib/api"

/** Change how a server starts and stops: its command, the setup step before it, and an optional stop command. */
export function CommandDialog({
  server,
  open,
  onOpenChange,
}: {
  server: Server
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit command</DialogTitle>
          <DialogDescription>
            How {server.name} starts and stops. It's kept in your config.json; if the
            repo's servedev.json defines {server.name}, your change applies on
            top of it.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts from the server's current values. */}
        <CommandForm server={server} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function CommandForm({
  server,
  onDone,
}: {
  server: Server
  onDone: () => void
}) {
  const [command, setCommand] = React.useState(server.command)
  const [setup, setSetup] = React.useState(server.setup ?? "")
  const [stop, setStop] = React.useState(server.stop ?? "")
  const [saving, setSaving] = React.useState<"save" | "restart" | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const running = ACTIVE.includes(server.status)

  // A new stop command applies to the running process right away; the others on restart.
  const startChanged =
    command.trim() !== server.command || setup.trim() !== (server.setup ?? "")
  const changed = startChanged || stop.trim() !== (server.stop ?? "")

  async function submit(restart: boolean) {
    setSaving(restart ? "restart" : "save")
    setError(null)
    try {
      await api("/api/command", { id: server.id, command, setup, stop })
      if (restart) await api("/api/restart", { id: server.id, wait: false })
      toast.success(
        restart
          ? `Restarting ${server.name} with the new command`
          : `Saved ${server.name}'s command`,
        {
          description:
            !restart && running && startChanged
              ? "It's still running the old one; restart to use it."
              : undefined,
        }
      )
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(null)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (changed && command.trim()) void submit(running)
      }}
      className="flex flex-col gap-6"
    >
      <FieldGroup>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="command">Command</FieldLabel>
          <Input
            id="command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <FieldDescription>
            Runs with sh -c in {server.cwd}. Use {"{port}"} to get the port
            servedev picks.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="setup">Setup (optional)</FieldLabel>
          <Input
            id="setup"
            value={setup}
            onChange={(e) => setSetup(e.target.value)}
            placeholder="pnpm install"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          <FieldDescription>
            Runs before the command on every start and restart. If it fails, the
            server doesn't start.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="stop">Stop (optional)</FieldLabel>
          <Input
            id="stop"
            value={stop}
            onChange={(e) => setStop(e.target.value)}
            placeholder="docker compose down"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          <FieldDescription>
            Runs first when the server stops or restarts, with output in its
            log. Anything still running afterwards is stopped with signals.
          </FieldDescription>
        </Field>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        {running ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={!changed || !command.trim() || !!saving}
              onClick={() => submit(false)}
            >
              {saving === "save" && <Spinner data-icon="inline-start" />}
              Save
            </Button>
            <Button
              type="submit"
              disabled={!changed || !command.trim() || !!saving}
            >
              {saving === "restart" && <Spinner data-icon="inline-start" />}
              Save & restart
            </Button>
          </>
        ) : (
          <Button
            type="submit"
            disabled={!changed || !command.trim() || !!saving}
          >
            {saving === "save" && <Spinner data-icon="inline-start" />}
            Save
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}
