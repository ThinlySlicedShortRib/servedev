import * as React from "react"
import { FolderOpenIcon, FolderPlusIcon, PlayIcon } from "lucide-react"
import { toast } from "sonner"

import { Hint, TruncatedText } from "@/components/hint"
import { StatusDot } from "@/components/status-dot"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { api, type Inspection, type Server } from "@/lib/api"

const NAME_RE = /^[\w.-]+$/

export function NewServerDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStarted: (id: string) => void
}) {
  const [dir, setDir] = React.useState("")
  const [info, setInfo] = React.useState<Inspection | null>(null)
  const [inspecting, setInspecting] = React.useState(false)
  const [picking, setPicking] = React.useState(false)
  const [adding, setAdding] = React.useState(false)

  async function addProject() {
    if (!info?.root) return
    setAdding(true)
    try {
      const r = await api<{ project: string; servers: string[]; profiles: string[] }>("/api/projects/add", { root: info.root })
      toast.success(`Added ${r.project}`, {
        description: `${plural(r.servers.length, "server")} and ${plural(r.profiles.length, "shared profile")} from servedev.json.`,
      })
      onOpenChange(false)
    } catch (e) {
      toast.error("Couldn't add the project", { description: (e as Error).message })
    } finally {
      setAdding(false)
    }
  }
  const [name, setName] = React.useState("")
  const [command, setCommand] = React.useState("")
  const [port, setPort] = React.useState("")
  const [install, setInstall] = React.useState(false)
  const [hostname, setHostname] = React.useState("")
  const [submitting, setSubmitting] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  // Fields the user typed into keep their value when the folder changes.
  const touched = React.useRef({ name: false, command: false, install: false })

  React.useEffect(() => {
    if (!open) return
    setDir("")
    setInfo(null)
    setName("")
    setCommand("")
    setPort("")
    setInstall(false)
    setHostname("")
    setError(null)
    touched.current = { name: false, command: false, install: false }
  }, [open])

  // Inspect the folder as the path is typed or picked.
  React.useEffect(() => {
    const path = dir.trim()
    if (!path) {
      setInfo(null)
      return
    }
    let cancelled = false
    setInspecting(true)
    const t = setTimeout(async () => {
      try {
        const res = await api<Inspection>(`/api/inspect?${new URLSearchParams({ dir: path })}`)
        if (cancelled) return
        setInfo(res)
        if (res.exists) {
          if (!touched.current.name) setName(res.suggestedName ?? "dev")
          if (!touched.current.command) setCommand(res.detected?.command ?? "")
          if (!touched.current.install) setInstall(res.install?.state === "missing" || res.install?.state === "stale")
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setInspecting(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [dir])

  async function browse() {
    setPicking(true)
    setError(null)
    try {
      const res = await api<{ path: string | null }>("/api/pick-folder", { start: info?.exists ? info.dir : undefined })
      if (res.path) {
        touched.current = { name: false, command: false, install: false }
        setDir(res.path)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPicking(false)
    }
  }

  async function start(body: Record<string, unknown>, label: string) {
    setSubmitting(label)
    setError(null)
    try {
      const res = await api<{ server: Server; alreadyRunning: boolean }>("/api/start", { ...body, wait: false })
      if (res.alreadyRunning) toast.info(`${res.server.name} was already running`)
      onStarted(res.server.id)
      onOpenChange(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(null)
    }
  }

  const ready = !!info?.exists
  const portValue = port.trim()
  const portValid = !portValue || portValue === "auto" || (/^\d+$/.test(portValue) && +portValue > 0 && +portValue < 65536)
  const nameValid = NAME_RE.test(name)
  const nameTaken = ready && info.existing?.find((s) => s.name === name)
  const canSubmit = ready && nameValid && portValid && command.trim() !== "" && !submitting

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || !info) return
    void start(
      {
        root: info.root,
        clientCwd: info.dir,
        name,
        // Leave the detected command to the daemon so it can add framework port flags.
        command: command.trim() === info.detected?.command ? undefined : command.trim(),
        port: !portValue ? undefined : portValue === "auto" ? "auto" : Number(portValue),
        install: install || undefined,
        hostname: hostname.trim() || undefined,
      },
      "new"
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New dev server</DialogTitle>
          <DialogDescription>Choose a project folder. servedev works out how to start it, and you can adjust that before it runs.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <FieldGroup>
            <Field data-invalid={info && !info.exists ? true : undefined}>
              <FieldLabel htmlFor="ns-dir">Folder</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="ns-dir"
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  placeholder="~/code/my-app"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  aria-invalid={info && !info.exists ? true : undefined}
                />
                <InputGroupAddon align="inline-end">
                  {inspecting && !picking && <Spinner />}
                  <Hint label="Open the macOS folder picker to choose the project folder">
                  <InputGroupButton onClick={browse} disabled={picking}>
                    {picking ? <Spinner /> : <FolderOpenIcon />}
                    {picking ? "Waiting…" : "Browse…"}
                  </InputGroupButton>
                  </Hint>
                </InputGroupAddon>
              </InputGroup>
              {info && !info.exists ? (
                <FieldError>No folder at {info.dir}.</FieldError>
              ) : ready ? (
                <FieldDescription>
                  Project <span className="font-medium text-foreground">{info.project}</span>
                  {info.root !== info.dir && <> (root {tildify(info.root!)})</>}.
                </FieldDescription>
              ) : (
                <FieldDescription>Type a path or browse for a folder on this machine.</FieldDescription>
              )}
            </Field>

            {ready && !info.tracked && ((info.configured?.length ?? 0) > 0 || (info.profiles?.length ?? 0) > 0) && (
              <Alert>
                <AlertTitle>This repo has a servedev.json</AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-2">
                  {describeRepo(info)} Add the project to see them without starting anything.
                  <Hint label="Track this project: its servedev.json servers and shared profiles appear in the sidebar and profile switcher">
                    <Button type="button" size="sm" variant="outline" disabled={adding} onClick={addProject}>
                      {adding ? <Spinner data-icon="inline-start" /> : <FolderPlusIcon data-icon="inline-start" />}
                      Add project
                    </Button>
                  </Hint>
                </AlertDescription>
              </Alert>
            )}

            {ready && info.configured && info.configured.length > 0 && (
              <FieldSet>
                <FieldLegend variant="label">Defined in servedev.json</FieldLegend>
                <div className="flex flex-col divide-y rounded-lg border">
                  {info.configured.map((c) => (
                    <div key={c.name} className="flex items-center gap-3 px-3 py-2">
                      <StatusDot status={c.status ?? "idle"} />
                      <div className="grid min-w-0 flex-1">
                        <span className="text-sm font-medium">{c.name}</span>
                        <TruncatedText text={c.command} className="font-mono text-xs text-muted-foreground" />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!!submitting}
                        onClick={() => start({ root: info.root, clientCwd: info.root, name: c.name }, c.name)}
                      >
                        {submitting === c.name ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
                        {c.status === "running" ? "Show" : "Start"}
                      </Button>
                    </div>
                  ))}
                </div>
              </FieldSet>
            )}

            {ready && (
              <>
                <Field data-invalid={!nameValid && name ? true : undefined}>
                  <FieldLabel htmlFor="ns-name">Name</FieldLabel>
                  <Input
                    id="ns-name"
                    value={name}
                    onChange={(e) => {
                      touched.current.name = true
                      setName(e.target.value)
                    }}
                    aria-invalid={!nameValid && name ? true : undefined}
                  />
                  {!nameValid && name ? (
                    <FieldError>Use letters, digits, dots, dashes or underscores.</FieldError>
                  ) : nameTaken ? (
                    <FieldDescription>
                      {info.project} already has a server called {name} ({nameTaken.status}). Starting reuses it.
                    </FieldDescription>
                  ) : (
                    <FieldDescription>Unique within {info.project}; agents refer to it by this name.</FieldDescription>
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor="ns-command">Command</FieldLabel>
                  <Input
                    id="ns-command"
                    value={command}
                    onChange={(e) => {
                      touched.current.command = true
                      setCommand(e.target.value)
                    }}
                    placeholder="npm run dev"
                    className="font-mono"
                    spellCheck={false}
                  />
                  <FieldDescription>
                    {info.detected
                      ? `Detected from the ${info.detected.kind}.`
                      : "No dev script found here. Enter the command that starts the server; {port} is replaced with the assigned port."}
                  </FieldDescription>
                </Field>
                <Field data-invalid={!portValid ? true : undefined}>
                  <FieldLabel htmlFor="ns-port">Port</FieldLabel>
                  <Input
                    id="ns-port"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="Let the server choose"
                    className="font-mono"
                    aria-invalid={!portValid ? true : undefined}
                  />
                  {portValid ? (
                    <FieldDescription>A port number, or auto for a free one. Sets $PORT.</FieldDescription>
                  ) : (
                    <FieldError>Enter a port between 1 and 65535, or auto.</FieldError>
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor="ns-hostname">Custom URL (optional)</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <InputGroupText>http://</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      id="ns-hostname"
                      value={hostname}
                      onChange={(e) => setHostname(e.target.value)}
                      placeholder={`${info.project}.localhost`}
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </InputGroup>
                  <FieldDescription>Reach it at a name instead of a port. Names ending in .localhost work without any setup.</FieldDescription>
                </Field>
                {info.install && (
                  <Field orientation="horizontal">
                    <Checkbox
                      id="ns-install"
                      checked={install}
                      onCheckedChange={(v) => {
                        touched.current.install = true
                        setInstall(v)
                      }}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor="ns-install">Install dependencies first</FieldLabel>
                      <FieldDescription>
                        Runs <code className="font-mono">{info.install.command.split(" --")[0]}</code> in{" "}
                        <code className="font-mono">{tildify(info.install.dir)}</code> ({info.install.reason.replace(/\/Users\/[^/]+/g, "~")}).{" "}
                        <span className={info.install.state === "missing" || info.install.state === "stale" ? "text-foreground" : undefined}>
                          {info.install.detail}
                        </span>
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                )}
              </>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!canSubmit}>
              {submitting === "new" && <Spinner data-icon="inline-start" />}
              Start server
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function tildify(p: string) {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~")
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

function describeRepo(info: Inspection): string {
  const servers = info.configured?.length ?? 0
  const profiles = info.profiles ?? []
  const parts = [servers ? plural(servers, "server") : "", profiles.length ? `${plural(profiles.length, "shared profile")} (${profiles.join(", ")})` : ""]
  return `It defines ${parts.filter(Boolean).join(" and ")}.`
}
