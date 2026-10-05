/**
 * The Machines sheet (header button next to Accounts): this machine and the other machines whose
 * servers it shows, with their state and per-machine actions; plus the Add machine dialog and
 * the Windows boot task dialog.
 */
import * as React from "react"
import {
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  CopyIcon,
  EllipsisIcon,
  ListFilterIcon,
  MonitorIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  RotateCwIcon,
  TerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "@/components/icons"
import { toast } from "sonner"

import { Hint } from "@/components/hint"
import { MachineIcon, MachineStateBadge, RetryButton } from "@/components/machine-ui"
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
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { retryMachine, showOnlyMachine, useMachines, useRetrying } from "@/hooks/use-machines"
import { useNow } from "@/hooks/use-servedev"
import { ACTIVE, ago, api, type Machine, type MachineUpdate, type Server, type SetupStep } from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import { MACHINE_NAME, machineKind, suggestMachineName, worstState } from "@/lib/machines"
import { cn } from "@/lib/utils"

const warnText = "text-amber-700 dark:text-amber-400 terminal:text-warning studio:text-warning-foreground friendly:text-status-starting-foreground"
const okText = "text-emerald-600 dark:text-emerald-400 terminal:text-success studio:text-success-foreground friendly:text-status-running-foreground"
const box = "rounded-md border bg-muted/40 terminal:rounded-none friendly:rounded-xl"

async function copy(text: string, what: string) {
  try {
    await copyText(text)
    toast.success(`Copied ${what}`, { description: text })
  } catch (e) {
    toast.error("Couldn't copy", { description: (e as Error).message })
  }
}

/** Header button and the sheet listing machines. */
export function MachinesSheet({ servers }: { servers: Map<string, Server> }) {
  const machines = useMachines()
  const now = useNow()
  const [open, setOpen] = React.useState(false)
  const [adding, setAdding] = React.useState(false)
  const [removing, setRemoving] = React.useState<Machine | null>(null)
  const [booting, setBooting] = React.useState<Machine | null>(null)
  const [updating, setUpdating] = React.useState<Machine | null>(null)
  const worst = worstState(machines.list)
  const local = [...servers.values()].filter((s) => !s.machine)
  // This servedev's version (each machine's summary carries it too).
  const [ownVersion, setOwnVersion] = React.useState<string>()
  React.useEffect(() => {
    if (open && !ownVersion && !machines.list.length)
      api<{ version: string }>("/api/health")
        .then((r) => setOwnVersion(r.version))
        .catch(() => {})
  }, [open, ownVersion, machines.list.length])
  const hubVersion = machines.list[0]?.hubVersion ?? ownVersion

  async function remove(m: Machine) {
    setRemoving(null)
    try {
      await api("/api/machines/remove", { name: m.name })
      toast.success(`Removed ${m.name}`, { description: `Its servers keep running there; they're just not shown here anymore.` })
    } catch (e) {
      toast.error(`Couldn't remove ${m.name}`, { description: (e as Error).message })
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <Hint
          label={
            machines.hasRemotes
              ? `Machines: ${machines.localName.replace(/^This/, "this")} and the ones it connects to over SSH${worst ? ` (${machines.list.filter((m) => m.state !== "connected").map((m) => `${m.name} ${m.state}`).join(", ")})` : ""}`
              : "Run and watch dev servers on another machine too (a PC, a Linux box), over SSH"
          }
        >
          <SheetTrigger render={<Button variant="outline" size="sm" className="relative" />}>
            <MonitorIcon data-icon="inline-start" />
            <span className="max-sm:hidden">Machines</span>
            {worst && (
              <span
                className={cn(
                  "absolute -top-1 -right-1 size-2 rounded-full ring-2 ring-background terminal:rounded-[1px]",
                  worst === "reconnecting"
                    ? "animate-pulse bg-amber-500 motion-reduce:animate-none terminal:bg-warning studio:bg-warning friendly:bg-status-starting"
                    : "border border-muted-foreground bg-background"
                )}
                aria-label={worst === "reconnecting" ? "A machine is reconnecting" : "A machine is offline"}
              />
            )}
          </SheetTrigger>
        </Hint>
        <SheetContent className="gap-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Machines</SheetTitle>
            <SheetDescription>
              {machines.localName} runs the dashboard and connects to servedev on your other machines over SSH. Their servers show up in the sidebar,
              and their ports open here at names like <span className="font-mono">api.pc.localhost</span>.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-5 px-4 pb-4">
              <LocalCard servers={local} version={hubVersion} />
              {machines.list.map((m) => (
                <React.Fragment key={m.name}>
                  <Separator />
                  <MachineCard
                    m={m}
                    now={now}
                    onRemove={() => setRemoving(m)}
                    onBoot={() => setBooting(m)}
                    onUpdate={() => setUpdating(m)}
                    onShowOnly={() => {
                      showOnlyMachine(m.name, machines.list.map((x) => x.name))
                      setOpen(false)
                    }}
                  />
                </React.Fragment>
              ))}
              {!machines.hasRemotes && (
                <Empty className="border border-dashed p-6 md:p-6 terminal:rounded-none">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MonitorIcon />
                    </EmptyMedia>
                    <EmptyTitle>No other machines yet</EmptyTitle>
                    <EmptyDescription>
                      Add a PC or a Linux box that runs servedev. You start, stop and read the logs of its servers from here, and open them on{" "}
                      {machines.localName.replace(/^This/, "this")}.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button size="sm" onClick={() => setAdding(true)}>
                      <PlusIcon data-icon="inline-start" />
                      Add machine
                    </Button>
                  </EmptyContent>
                </Empty>
              )}
            </div>
          </ScrollArea>
          {machines.hasRemotes && (
            <SheetFooter className="border-t">
              <p className="text-xs text-muted-foreground">
                Or in a terminal: <span className="font-mono">servedev remote add pc you@host</span>
              </p>
              <Button size="sm" onClick={() => setAdding(true)}>
                <PlusIcon data-icon="inline-start" />
                Add machine
              </Button>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>
      <AddMachineDialog open={adding} onOpenChange={setAdding} />
      <BootDialog machine={booting} onOpenChange={(o) => !o && setBooting(null)} />
      <UpdateDialog machine={updating} onOpenChange={(o) => !o && setUpdating(null)} />
      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              servedev here disconnects from {removing?.name} and forgets its address, token and last known servers. Nothing changes on{" "}
              {removing?.name}: its servers keep running there. You can add it again any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && remove(removing)}>
              Remove machine
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function CardHead({ machine, title, badge, sub, menu }: { machine?: Machine; title: string; badge: React.ReactNode; sub?: string; menu?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground terminal:rounded-none friendly:rounded-xl">
        <MachineIcon machine={machine} className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {badge}
        </h3>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
      {menu}
    </div>
  )
}

function serverCounts(servers: Server[]) {
  const running = servers.filter((s) => ACTIVE.includes(s.status)).length
  const crashed = servers.filter((s) => s.status === "crashed").length
  return `${running} of ${servers.length} running${crashed ? `, ${crashed} crashed` : ""}`
}

function LocalCard({ servers, version }: { servers: Server[]; version?: string }) {
  const { localName } = useMachines()
  const now = useNow()
  return (
    <section className="flex flex-col gap-2" aria-label={localName}>
      <CardHead title={localName} badge={<MachineStateBadge now={now} />} sub="Runs the dashboard (the hub)" />
      <dl className="ml-11 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        {version && (
          <>
            <dt className="text-muted-foreground">servedev</dt>
            <dd>{version}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Servers</dt>
        <dd>{serverCounts(servers)}</dd>
      </dl>
    </section>
  )
}

function MachineCard({
  m,
  now,
  onRemove,
  onBoot,
  onUpdate,
  onShowOnly,
}: {
  m: Machine
  now: number
  onRemove: () => void
  onBoot: () => void
  onUpdate: () => void
  onShowOnly: () => void
}) {
  const retrying = useRetrying(m.name)
  const up = m.state === "connected"
  const { running, total, crashed } = m.counts
  return (
    <section className={cn("flex flex-col gap-2", m.state === "offline" && "[&_.dim]:opacity-60")} aria-label={m.name}>
      <CardHead
        machine={m}
        title={m.name}
        badge={<MachineStateBadge machine={m} now={now} />}
        sub={m.os ?? machineKind(m)}
        menu={
          <DropdownMenu>
            <Hint label={`More ${m.name} actions`}>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More ${m.name} actions`} />}>
                <EllipsisIcon />
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem disabled={retrying} onClick={() => void retryMachine(m.name)}>
                <RefreshCwIcon />
                <div className="grid leading-tight">
                  <span>Reconnect now</span>
                  <span className="text-xs text-muted-foreground">{up ? "Runs the connection checks again" : "Instead of waiting for the next retry"}</span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onShowOnly}>
                <ListFilterIcon />
                Show only its servers
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void copy(`ssh ${m.ssh}`, "the SSH command")}>
                <TerminalIcon />
                Copy SSH command
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!up} onClick={onUpdate}>
                <RotateCwIcon />
                <div className="grid leading-tight">
                  <span>Update servedev…</span>
                  <span className="text-xs text-muted-foreground">{up ? "Pull its checkout and restart it there" : "Needs it connected"}</span>
                </div>
              </DropdownMenuItem>
              {m.kind === "wsl" && (
                <DropdownMenuItem disabled={!up} onClick={onBoot}>
                  <PowerIcon />
                  <div className="grid leading-tight">
                    <span>Start with Windows…</span>
                    <span className="text-xs text-muted-foreground">{up ? "Keep servedev running when you log in" : "Needs it connected"}</span>
                  </div>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                <Trash2Icon />
                <div className="grid leading-tight">
                  <span>Remove machine…</span>
                  <span className="text-xs text-muted-foreground">Its servers keep running there</span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <dl className="ml-11 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Address</dt>
        <dd className="dim truncate font-mono">{m.ssh}</dd>
        <dt className="text-muted-foreground">servedev</dt>
        <dd className="dim">
          {m.version ?? "unknown"}
          {m.versionMismatch && (
            <Hint label="Some things may not work between different versions. Update servedev on one side so they match.">
              <span className={warnText}> · {m.hubVersion} here</span>
            </Hint>
          )}
          {m.versionMismatch && up && (
            <Button size="xs" variant="outline" className="ml-2 align-middle" onClick={onUpdate}>
              <RotateCwIcon data-icon="inline-start" />
              Update {m.name}
            </Button>
          )}
        </dd>
        <dt className="text-muted-foreground">Servers</dt>
        <dd className="dim">
          {up ? "" : "last known: "}
          {running} of {total} running
          {crashed > 0 && <span className="text-destructive">, {crashed} crashed</span>}
        </dd>
        <dt className="text-muted-foreground">Opens at</dt>
        <dd className="dim font-mono">*.{m.name}.localhost</dd>
        {up && m.forwards.length > 0 && (
          <>
            <dt className="text-muted-foreground">Ports</dt>
            <dd className="flex flex-col gap-0.5 font-mono">
              {m.forwards.map((f) => (
                <Hint key={f.remotePort} label={`${[...f.serverIds, ...(f.outside ?? []).map((c) => `${c} (started outside servedev)`)].join(", ")}: ${m.name}:${f.remotePort} forwarded to localhost:${f.localPort} here`}>
                  <span className="truncate">
                    {m.name}:{f.remotePort}
                    <span className="text-muted-foreground"> → </span>
                    {f.localPort === f.remotePort ? "same port here" : `localhost:${f.localPort}`}
                  </span>
                </Hint>
              ))}
            </dd>
          </>
        )}
      </dl>
      {up && !!m.otherHubs?.length && (
        <div className={cn("ml-11 flex flex-col gap-1.5 p-2.5 text-xs", box)} role="status">
          <p className="flex items-start gap-1.5">
            <TriangleAlertIcon className={cn("mt-px size-3.5 shrink-0", warnText)} />
            <span className="min-w-0 break-words">
              {m.otherHubs.length === 1 ? (
                <>
                  Another hub, <span className="font-medium">{m.otherHubs[0]}</span>, is connected to {m.name} too.
                </>
              ) : (
                <>
                  Other hubs (<span className="font-medium">{m.otherHubs.join(", ")}</span>) are connected to {m.name} too.
                </>
              )}
            </span>
          </p>
          <p className="text-muted-foreground">
            Each forwards its servers' ports, so here some may have other port numbers than on {m.name}. Remove {m.name} on the other one if you don't
            need both.
          </p>
        </div>
      )}
      {!up && (m.lastError || m.state === "offline") && (
        <div className={cn("ml-11 flex flex-col gap-1.5 p-2.5 text-xs", box)}>
          <p className="flex items-start gap-1.5">
            <TriangleAlertIcon className={cn("mt-px size-3.5 shrink-0", m.state === "offline" ? "text-muted-foreground" : warnText)} />
            <span className="min-w-0 break-words">
              {m.lastError ?? `Can't reach ${m.name}.`}
              {m.lastSeen ? <span className="text-muted-foreground"> Last seen {ago(m.lastSeen, now)} ago.</span> : null}
            </span>
          </p>
          {m.hint && <p className="whitespace-pre-wrap text-muted-foreground">{m.hint}</p>}
          <div className="flex items-center gap-3 text-muted-foreground">
            {m.nextRetryAt && m.nextRetryAt > now && !retrying && <span>Next try in {ago(now, m.nextRetryAt) || "a moment"}</span>}
            <RetryButton machine={m} label="Retry now" className="ml-auto" />
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// Add machine
// ---------------------------------------------------------------------------------------------

/** The checklist's steps, in order (the daemon's src/remote/setup.ts). */
const STEPS: { id: SetupStep["id"]; label: string }[] = [
  { id: "ssh", label: "SSH connection" },
  { id: "os", label: "Operating system" },
  { id: "servedev", label: "servedev installed and running" },
  { id: "token", label: "API token" },
  { id: "api", label: "servedev API through the tunnel" },
]

type Result = { ok: boolean; steps: SetupStep[]; machine?: Machine }

export function AddMachineDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted only while open, so each opening starts with an empty form. */}
        <AddMachineForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function AddMachineForm({ onDone }: { onDone: () => void }) {
  const machines = useMachines()
  const [ssh, setSsh] = React.useState("")
  const [name, setName] = React.useState("")
  const [phase, setPhase] = React.useState<"form" | "running" | "done">("form")
  const [result, setResult] = React.useState<Result | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  // Ignore an answer that comes back after a retry started.
  const run = React.useRef(0)

  const finalName = name.trim() || suggestMachineName(ssh)
  const nameError = !finalName
    ? undefined
    : !MACHINE_NAME.test(finalName)
      ? "Use lowercase letters, digits and dashes (it becomes part of hostnames)"
      : machines.get(finalName)
        ? `There's already a machine called ${finalName}`
        : undefined
  const sshError = ssh.trim() && /\s/.test(ssh.trim()) ? "One destination, like you@100.64.0.2 or a Host from ~/.ssh/config" : undefined
  const canConnect = !!ssh.trim() && !!finalName && !nameError && !sshError

  async function connect() {
    if (!canConnect) return
    const mine = ++run.current
    setPhase("running")
    setResult(null)
    setError(null)
    try {
      const r = await api<Result>("/api/machines/add", { name: finalName, ssh: ssh.trim() })
      if (run.current !== mine) return
      setResult(r)
    } catch (e) {
      if (run.current !== mine) return
      setError((e as Error).message)
    }
    setPhase("done")
  }

  const ok = phase === "done" && result?.ok
  const failed = phase === "done" && !ok

  return (
    <>
    <DialogHeader>
      <DialogTitle>Add machine</DialogTitle>
      <DialogDescription>
        Connect to servedev on another computer over SSH. Its servers appear in the sidebar, and you start, stop and open them from here.
      </DialogDescription>
    </DialogHeader>
    {phase === "form" ? (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void connect()
        }}
        className="flex flex-col gap-6"
      >
        <FieldGroup>
          <Field data-invalid={!!sshError || undefined}>
            <FieldLabel htmlFor="am-ssh">SSH address</FieldLabel>
            <Input
              id="am-ssh"
              value={ssh}
              onChange={(e) => setSsh(e.target.value)}
              placeholder="you@100.64.0.2, or a Host from ~/.ssh/config"
              className="font-mono"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!!sshError || undefined}
            />
            {sshError ? (
              <FieldError>{sshError}</FieldError>
            ) : (
              <FieldDescription>
                Anything <span className="font-mono">ssh</span> accepts. servedev uses your SSH keys (it must connect without a password) and stores no
                password. For a Windows PC, its OpenSSH server; servers run in WSL.
              </FieldDescription>
            )}
          </Field>
          <Field data-invalid={!!nameError || undefined}>
            <FieldLabel htmlFor="am-name">Name</FieldLabel>
            <Input
              id="am-name"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder={suggestMachineName(ssh) || "pc"}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!!nameError || undefined}
            />
            {nameError ? (
              <FieldError>{nameError}</FieldError>
            ) : (
              <FieldDescription>
                Shown in the sidebar and in its servers' addresses here: <span className="font-mono">api.{finalName || "pc"}.localhost</span>
              </FieldDescription>
            )}
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
          <Button type="submit" disabled={!canConnect}>
            Connect
          </Button>
        </DialogFooter>
      </form>
    ) : (
      <div className="flex flex-col gap-5">
        <ol className="flex flex-col gap-2.5" aria-live="polite" aria-busy={phase === "running"}>
          {STEPS.map((def) => (
            <StepRow key={def.id} label={def.label} step={result?.steps.find((s) => s.id === def.id)} />
          ))}
        </ol>
        {phase === "running" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner className="size-4" />
            Connecting to <span className="font-mono">{ssh.trim()}</span> and checking each step…
          </p>
        )}
        {error && (
          <p className={cn("p-3 text-sm text-destructive", box)} role="alert">
            {error}
          </p>
        )}
        {ok && (
          <p className="text-sm" role="status">
            <span className="font-medium">{finalName} is connected.</span>{" "}
            <span className="text-muted-foreground">
              {result?.machine?.counts.total
                ? `Its ${result.machine.counts.total} ${result.machine.counts.total === 1 ? "server is" : "servers are"} in the sidebar under ${finalName}.`
                : `Its servers show up in the sidebar under ${finalName}.`}
            </span>
          </p>
        )}
        <DialogFooter>
          {failed ? (
            <>
              <Button variant="outline" onClick={() => setPhase("form")}>
                Back
              </Button>
              <Button onClick={() => void connect()}>
                <RefreshCwIcon data-icon="inline-start" />
                Try again
              </Button>
            </>
          ) : (
            <>
              {phase === "running" && (
                <Hint label="Closes this window; servedev finishes checking in the background">
                  <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
                </Hint>
              )}
              <Button disabled={!ok} onClick={onDone}>
                Done
              </Button>
            </>
          )}
        </DialogFooter>
      </div>
    )}
    </>
  )
}

/** One line of the checklist: not run yet (or skipped after a failure), ok, a warning, or failed. */
function StepRow({ label, step }: { label: string; step?: SetupStep }) {
  const st = step?.status
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {st === "ok" ? (
          <CircleCheckIcon className={cn("size-4", okText)} aria-label="done" />
        ) : st === "warning" ? (
          <TriangleAlertIcon className={cn("size-4", warnText)} aria-label="warning" />
        ) : st === "failed" ? (
          <CircleXIcon className="size-4 text-destructive" aria-label="failed" />
        ) : (
          <CircleIcon className="size-4 text-muted-foreground/40" aria-label={st === "skipped" ? "not checked" : "pending"} />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={cn(!st || st === "skipped" ? "text-muted-foreground" : undefined, st === "failed" && "font-medium text-destructive")}>
          {label}
          {step?.detail && st !== "failed" && <span className="text-muted-foreground">: {step.detail}</span>}
        </span>
        {st === "failed" && step?.detail && <span className="text-xs break-words text-destructive/90">{step.detail}</span>}
        {(st === "failed" || st === "warning") && step?.hint && (
          <p className={cn("p-2.5 text-xs whitespace-pre-wrap text-muted-foreground", box)}>{step.hint}</p>
        )}
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------------------------
// Start with Windows (a logon task that starts servedev in WSL and keeps WSL up)
// ---------------------------------------------------------------------------------------------

interface BootInfo {
  supported: boolean
  script?: string
  powershell?: string
  installed?: boolean
  output?: string
  note?: string
}

function BootDialog({ machine: m, onOpenChange }: { machine: Machine | null; onOpenChange: (open: boolean) => void }) {
  const [info, setInfo] = React.useState<BootInfo | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [installing, setInstalling] = React.useState(false)
  const name = m?.name
  // Another machine (or closing) starts over.
  const [shownName, setShownName] = React.useState(name)
  if (shownName !== name) {
    setShownName(name)
    setInfo(null)
    setError(null)
  }

  React.useEffect(() => {
    if (!name) return
    let cancelled = false
    // Writes the boot script on the machine (harmless to repeat) and gives the task command.
    api<BootInfo>("/api/machines/boot", { name })
      .then((r) => !cancelled && setInfo(r))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [name])

  async function install() {
    if (!name) return
    setInstalling(true)
    try {
      const r = await api<BootInfo>("/api/machines/boot", { name, install: true })
      setInfo(r)
      if (r.installed) toast.success(`servedev starts with Windows on ${name}`, { description: "At your next Windows logon, with its pinned servers." })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Dialog open={!!m} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start servedev with Windows on {name}</DialogTitle>
          <DialogDescription>
            WSL shuts down when nothing on Windows holds it open, and takes the servers with it. A logon task starts servedev (and its pinned servers) when
            you log in to Windows and keeps WSL running, even when this machine isn't connected.
          </DialogDescription>
        </DialogHeader>
        {!info && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Preparing the script on {name}…
          </p>
        )}
        {error && (
          <p className={cn("p-3 text-sm text-destructive", box)} role="alert">
            {error}
          </p>
        )}
        {info && !info.supported && <p className="text-sm text-muted-foreground">{info.note}</p>}
        {info?.supported && (
          <div className="flex flex-col gap-3 text-sm">
            {info.installed ? (
              <p className="flex items-center gap-2">
                <CircleCheckIcon className={cn("size-4", okText)} />
                The task is registered. servedev starts at your next Windows logon.
              </p>
            ) : (
              <>
                <p className="text-muted-foreground">
                  servedev wrote <span className="font-mono text-foreground">{info.script}</span> on {name}. Register the task over SSH, or run this in
                  PowerShell on {name} yourself:
                </p>
                <div className={cn("flex items-start gap-2 p-2 font-mono text-xs", box)}>
                  <span className="max-h-32 min-w-0 flex-1 overflow-auto break-all whitespace-pre-wrap">{info.powershell}</span>
                  <Hint label="Copy the PowerShell command">
                    <Button size="icon-xs" variant="ghost" aria-label="Copy the PowerShell command" onClick={() => void copy(info.powershell ?? "", "the command")}>
                      <CopyIcon />
                    </Button>
                  </Hint>
                </div>
                {info.installed === false && info.output && (
                  <p className="text-xs whitespace-pre-wrap text-destructive">Registering it didn't work: {info.output}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  It runs when you log in, not at boot; to start before anyone logs in, set "Run whether user is logged on or not" in Task Scheduler.
                </p>
              </>
            )}
          </div>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{info?.installed ? "Done" : "Close"}</DialogClose>
          {info?.supported && !info.installed && (
            <Button onClick={() => void install()} disabled={installing}>
              {installing ? <Spinner data-icon="inline-start" /> : <PowerIcon data-icon="inline-start" />}
              Register the task
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------
// Update servedev on a machine (git pull there, install or build, restart its daemon)
// ---------------------------------------------------------------------------------------------

function UpdateDialog({ machine: m, onOpenChange }: { machine: Machine | null; onOpenChange: (open: boolean) => void }) {
  const [phase, setPhase] = React.useState<"confirm" | "running" | "done">("confirm")
  const [result, setResult] = React.useState<MachineUpdate | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const name = m?.name
  // Ignore an answer that comes back after the dialog was closed or reopened.
  const run = React.useRef(0)
  React.useEffect(() => {
    run.current++
  }, [name])
  // Opened for another machine (or again): start over.
  const [shownFor, setShownFor] = React.useState(name)
  if (name !== shownFor) {
    setShownFor(name)
    setPhase("confirm")
    setResult(null)
    setError(null)
  }

  async function update() {
    if (!name) return
    const mine = ++run.current
    setPhase("running")
    try {
      const r = await api<MachineUpdate>("/api/machines/update", { name })
      if (run.current !== mine) return
      setResult(r)
      if (r.ok && r.machine.state === "connected") toast.success(`Updated servedev on ${name}`, { description: `${r.before.version ?? "?"} → ${r.machine.version ?? r.after?.version ?? "?"}` })
    } catch (e) {
      if (run.current !== mine) return
      setError((e as Error).message)
    }
    setPhase("done")
  }

  const after = result?.machine.version ?? result?.after?.version
  return (
    <Dialog open={!!m} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Update servedev on {name}</DialogTitle>
          <DialogDescription>
            Pulls the git checkout servedev runs from on {name} (only when it can fast-forward and has no uncommitted changes), installs or builds what
            changed, and restarts its daemon. Its servers keep running.
          </DialogDescription>
        </DialogHeader>
        {phase === "confirm" && m && (
          <p className="text-sm text-muted-foreground">
            {name} runs servedev {m.version ?? "(unknown version)"}; this machine runs {m.hubVersion}.
          </p>
        )}
        {phase === "running" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner className="size-4" />
            Updating {name}; a build there can take a few minutes…
          </p>
        )}
        {error && (
          <p className={cn("p-3 text-sm text-destructive", box)} role="alert">
            {error}
          </p>
        )}
        {result && (
          <div className="flex flex-col gap-4 text-sm" aria-live="polite">
            <ul className="flex flex-col gap-1.5">
              {result.done.map((d) => (
                <li key={d} className="flex items-start gap-2">
                  <CircleCheckIcon className={cn("mt-0.5 size-4 shrink-0", okText)} />
                  <span className="min-w-0 break-words">{d}</span>
                </li>
              ))}
              {result.error && (
                <li className="flex items-start gap-2">
                  <CircleXIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="break-words whitespace-pre-wrap text-destructive">{result.error}</span>
                    {result.hint && <span className="text-xs text-muted-foreground">{result.hint}</span>}
                  </div>
                </li>
              )}
            </ul>
            {result.commits.length > 0 && (
              <div className={cn("max-h-32 overflow-auto p-2.5 font-mono text-xs", box)}>
                {result.commits.map((c) => (
                  <div key={c} className="truncate">
                    {c}
                  </div>
                ))}
              </div>
            )}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Commit</dt>
              <dd className="font-mono">
                {result.before.commit} → {result.after?.commit ?? result.before.commit}
                <span className="text-muted-foreground"> ({result.branch})</span>
              </dd>
              <dt className="text-muted-foreground">servedev</dt>
              <dd>
                {result.before.version ?? "?"} → {after ?? "?"}
                {after && after !== result.hubVersion ? (
                  <span className={warnText}> · {result.hubVersion} here</span>
                ) : (
                  <span className="text-muted-foreground"> · same as here</span>
                )}
              </dd>
            </dl>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">Reconnecting</p>
              <ol className="flex flex-col gap-2">
                {STEPS.map((def) => (
                  <StepRow key={def.id} label={def.label} step={result.steps.find((s) => s.id === def.id)} />
                ))}
              </ol>
            </div>
          </div>
        )}
        <DialogFooter>
          {phase === "confirm" ? (
            <>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button onClick={() => void update()}>
                <RotateCwIcon data-icon="inline-start" />
                Update and restart
              </Button>
            </>
          ) : (
            <DialogClose render={<Button variant={phase === "running" ? "outline" : "default"} />}>{phase === "running" ? "Close" : "Done"}</DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

