import * as React from "react"
import { ExternalLinkIcon, HandIcon, SquareIcon, TriangleAlertIcon } from "@/components/icons"
import { toast } from "sonner"

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
import { BranchTag } from "@/components/branch-tag"
import { Hint } from "@/components/hint"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ago, api, type ExternalServer, type Server } from "@/lib/api"

function tildify(p: string) {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~")
}

/** A dev server running outside servedev: what's known about it, and taking it over. */
export function ExternalDetail({
  server: x,
  now,
  onTakenOver,
  onStopped,
}: {
  server: ExternalServer
  now: number
  onTakenOver: (id: string) => void
  onStopped: () => void
}) {
  const [takingOver, setTakingOver] = React.useState(false)
  const [confirmStop, setConfirmStop] = React.useState(false)
  const [stopping, setStopping] = React.useState(false)

  async function stop() {
    setStopping(true)
    try {
      await api("/api/external/stop", { id: x.id })
      toast.success(`Stopped ${x.suggestedName} from ${x.project}`)
      onStopped()
    } catch (e) {
      toast.error(`Couldn't stop ${x.suggestedName}`, { description: (e as Error).message })
    } finally {
      setStopping(false)
      setConfirmStop(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold terminal:flex terminal:items-baseline terminal:gap-2 terminal:text-lg">
            <span aria-hidden className="hidden text-muted-foreground select-none terminal:inline">❯</span>
            {x.suggestedName}
          </h1>
          <Badge variant="outline">running outside servedev</Badge>
          {x.orphaned && <Badge variant="destructive">folder deleted</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          {x.url && (
            <Hint label={`Open ${x.url} in a new browser tab`}>
              <Button variant="outline" nativeButton={false} render={<a href={x.url} target="_blank" rel="noopener" />}>
                <ExternalLinkIcon data-icon="inline-start" />
                Open in new tab
              </Button>
            </Hint>
          )}
          {x.orphaned ? (
            <Hint label="Stop its processes and free its ports; nothing else is touched (asks first)">
              <Button variant="destructive" onClick={() => setConfirmStop(true)}>
                <SquareIcon data-icon="inline-start" />
                Stop
              </Button>
            </Hint>
          ) : (
            <Hint label="Stop it and start the same command in the same folder under servedev, so you get logs, restarts and history (you can review first)">
              <Button onClick={() => setTakingOver(true)}>
                <HandIcon data-icon="inline-start" />
                Take over
              </Button>
            </Hint>
          )}
        </div>
      </div>

      {x.orphaned ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Its folder no longer exists</AlertTitle>
          <AlertDescription>
            {tildify(x.cwd)} was deleted (a removed worktree, most likely), but the server kept running from memory. There's nothing to
            restart it from, so it can only be stopped.
          </AlertDescription>
        </Alert>
      ) : (
        <p className="max-w-prose text-sm text-muted-foreground">
          Something other than servedev started this server, such as a terminal or an agent's shell, so servedev can't see its logs or
          restart it. Take it over to manage it like any other server: servedev stops it and starts the same command in the same folder, with
          logs, restarts and run history from then on.
        </p>
      )}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Project</dt>
        <dd>{x.project}</dd>
        {x.ports.length > 0 && (
          <>
            <dt className="text-muted-foreground">Ports</dt>
            <dd className="flex flex-wrap gap-x-3 font-mono">
              {x.ports.map((p) => (
                <a key={p} href={`http://localhost:${p}`} target="_blank" rel="noopener" className="underline-offset-4 hover:underline">
                  localhost:{p}
                </a>
              ))}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Command</dt>
        <dd className="font-mono break-all">{x.command}</dd>
        {x.branch && (
          <>
            <dt className="text-muted-foreground">Branch</dt>
            <dd>
              <BranchTag branch={x.branch} className="text-xs" />
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Started in</dt>
        <dd className="font-mono break-all">{tildify(x.cwd)}</dd>
        <dt className="text-muted-foreground">PID</dt>
        <dd className="font-mono">
          {x.pid}
          <span className="text-muted-foreground"> ({x.pids.length} {x.pids.length === 1 ? "process" : "processes"})</span>
        </dd>
        {x.startedAt && (
          <>
            <dt className="text-muted-foreground">Running for</dt>
            <dd>{ago(x.startedAt, now)}</dd>
          </>
        )}
      </dl>

      <TakeOverDialog open={takingOver} onOpenChange={setTakingOver} server={x} onDone={onTakenOver} />

      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop {x.suggestedName} from {x.project}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Stops its {x.pids.length} {x.pids.length === 1 ? "process" : "processes"} (pid {x.pid}) and frees{" "}
              {x.ports.map((p) => `:${p}`).join(", ")}. Nothing else is touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={stop} disabled={stopping}>
              {stopping && <Spinner data-icon="inline-start" />}
              Stop it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function TakeOverDialog({
  open,
  onOpenChange,
  server: x,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  server: ExternalServer
  onDone: (id: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Take over {x.suggestedName}</DialogTitle>
          <DialogDescription>
            servedev stops the running process (pid {x.pid}, {x.ports.map((p) => `:${p}`).join(", ")}) and starts this command in{" "}
            {tildify(x.cwd)}. It's down for a moment while it restarts.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts from the suggested name and command. */}
        <TakeOverForm
          server={x}
          onDone={(id) => {
            onOpenChange(false)
            onDone(id)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function TakeOverForm({ server: x, onDone }: { server: ExternalServer; onDone: (id: string) => void }) {
  const [name, setName] = React.useState(x.suggestedName)
  const [command, setCommand] = React.useState(x.command)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const nameValid = /^[\w.-]+$/.test(name)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const r = await api<{ server: Server; ready?: { ok: boolean; reason?: string } }>("/api/external/takeover", {
        id: x.id,
        name,
        command: command.trim(),
      })
      if (r.ready && !r.ready.ok) toast.error(`${name} didn't come back up`, { description: `${r.ready.reason}. Its logs are in servedev now.` })
      else toast.success(`servedev now manages ${name}`, { description: r.server.url ? `Running at ${r.server.url}` : undefined })
      onDone(r.server.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <FieldGroup>
        <Field data-invalid={!nameValid ? true : undefined}>
          <FieldLabel htmlFor="takeover-name">Name</FieldLabel>
          <Input id="takeover-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!nameValid ? true : undefined} />
          {!nameValid && <FieldError>Use letters, digits, dots, dashes or underscores.</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="takeover-command">Command</FieldLabel>
          <Textarea id="takeover-command" value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono text-xs" rows={3} />
          <FieldDescription>
            This is how it was started. It keeps port {x.ports.find((p) => p < 10000) ?? x.ports[0]}, and runs with servedev's environment
            variables rather than the original terminal's; settings in .env files still apply.
          </FieldDescription>
        </Field>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={!nameValid || !command.trim() || saving}>
          {saving && <Spinner data-icon="inline-start" />}
          {saving ? "Taking over…" : "Stop and take over"}
        </Button>
      </DialogFooter>
    </form>
  )
}
