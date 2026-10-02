import * as React from "react"
import {
  ExternalLinkIcon,
  LinkIcon,
  LockIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  RotateCwIcon,
  SaveIcon,
  SquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "@/components/icons"
import { toast } from "sonner"

import { AccountTag } from "@/components/account-tag"
import { StatusDot, statusTagClass } from "@/components/status-dot"
import { ProjectAvatar } from "@/components/friendly-decor"
import { useStyleId } from "@/components/style-provider"
import { useStatusFx } from "@/hooks/use-status-fx"
import { cn } from "@/lib/utils"
import { useStartProfile } from "@/hooks/use-accounts"
import { BranchTag } from "@/components/branch-tag"
import { Hint } from "@/components/hint"
import { HostnameDialog } from "@/components/hostname-dialog"
import { SaveConfigDialog } from "@/components/save-config-dialog"
import { AppPreview } from "@/components/app-preview"
import { LogView } from "@/components/log-view"
import { ProcessView, useProcessGroups } from "@/components/process-view"
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Spinner } from "@/components/ui/spinner"
import { MachineIcon, RetryButton } from "@/components/machine-ui"
import { useMachines } from "@/hooks/use-machines"
import { localPortOf, machineKind, remotePortOf } from "@/lib/machines"
import { ACTIVE, ago, api, openUrl, statusLabel, type Server } from "@/lib/api"
import type { Entry } from "@/lib/entries"

type Action = "start" | "restart" | "stop" | "remove"

const warnText = "text-amber-700 dark:text-amber-400 terminal:text-warning studio:text-warning-foreground friendly:text-status-starting-foreground"

function tildify(p: string) {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~")
}

export function ServerDetail({ entry, now }: { entry: Entry; now: number }) {
  const s = entry.server
  const active = !!s && ACTIVE.includes(s.status)
  const [busy, setBusy] = React.useState<Action | null>(null)
  const startProfile = useStartProfile(s?.id)
  const styleId = useStyleId()
  const terminal = styleId === "terminal"
  const studio = styleId === "studio"
  const friendly = styleId === "friendly"
  // Friendly style: the status pill pops when the server becomes ready and shakes once when it crashes.
  const statusFx = useStatusFx(s?.status, friendly)
  const [tab, setTab] = React.useState<"logs" | "processes" | "preview">("logs")
  const [editingHost, setEditingHost] = React.useState(false)
  const [savingConfig, setSavingConfig] = React.useState(false)
  // On another machine: while it isn't connected this is the last known state, and actions wait.
  const machine = useMachines().get(s?.machine)
  const down = !!s?.machine && (s.stale || (!!machine && machine.state !== "connected"))
  const locked = !!busy || down
  const href = down ? undefined : openUrl(s)
  const remotePort = s?.machine ? remotePortOf(s) : undefined
  const localPort = s?.machine ? localPortOf(s) : undefined
  const groups = useProcessGroups(
    s?.id,
    active && !down,
    tab === "processes" ? 2000 : 5000
  )
  const processCount = groups?.reduce((n, g) => n + g.processes.length, 0) ?? 0

  async function run(action: Action) {
    setBusy(action)
    try {
      if (action === "start") {
        if (s)
          await api("/api/start", { id: s.id, clientCwd: s.cwd, wait: false, profile: startProfile })
        else
          await api("/api/start", {
            root: entry.configured!.root,
            clientCwd: entry.configured!.root,
            name: entry.name,
            wait: false,
          })
      } else if (action === "restart") {
        await api("/api/restart", { id: s!.id, wait: false })
      } else if (action === "stop") {
        await api("/api/stop", { id: s!.id })
      } else {
        await api("/api/remove", { id: s!.id, fromRepo: !!s!.source?.repo })
        toast.success(`Removed ${entry.name} from servedev`)
      }
    } catch (e) {
      toast.error(`Couldn't ${action} ${entry.name}`, {
        description: (e as Error).message,
      })
    } finally {
      setBusy(null)
    }
  }

  async function togglePin() {
    if (!s) return
    try {
      const r = await api<{ autostart: { supported: boolean } }>("/api/pin", {
        id: s.id,
        pinned: !s.pinned,
      })
      if (s.machine)
        toast.success(`${s.pinned ? "Unpinned" : "Pinned"} ${s.name} on ${s.machine}`, {
          description: s.pinned ? `It no longer starts when servedev starts on ${s.machine}.` : `It starts when servedev starts on ${s.machine}.`,
        })
      else if (s.pinned)
        toast.success(`Unpinned ${s.name}`, {
          description: "It no longer starts when you log in.",
        })
      else
        toast.success(`Pinned ${s.name}`, {
          description: r.autostart?.supported
            ? "It starts automatically when you log in."
            : "Starting at login is only supported on macOS.",
        })
    } catch (e) {
      toast.error(`Couldn't ${s.pinned ? "unpin" : "pin"} ${s.name}`, {
        description: (e as Error).message,
      })
    }
  }

  const statusVariant = !s
    ? "outline"
    : s.status === "crashed"
      ? "destructive"
      : s.status === "running"
        ? "secondary"
        : "outline"
  const command = s?.command ?? entry.configured?.command

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-col gap-4 p-4 md:p-6 friendly:@container/detail friendly:p-5 friendly:md:px-7 friendly:md:pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 friendly:min-w-0">
            {friendly && <ProjectAvatar name={entry.project} className="size-10 rounded-xl text-base shadow-xs" />}
            <h1 className="text-xl font-semibold terminal:flex terminal:items-baseline terminal:gap-2 terminal:text-lg studio:text-lg studio:tracking-tight friendly:text-2xl friendly:font-extrabold friendly:tracking-tight">
              <span aria-hidden className="hidden text-primary select-none terminal:inline">❯</span>
              {entry.name}
            </h1>
            <Badge variant={statusVariant} className={cn(statusTagClass(s?.status), "studio:gap-1.5 studio:font-normal", statusFx === "crash" && "friendly-shake", statusFx === "ready" && "friendly-pop")}>
              {studio && <StatusDot status={entry.status} className="size-1.5" />}
              {friendly && <StatusDot status={s?.status ?? "idle"} />}
              {terminal && s && (s.status === "starting" || s.status === "stopping") && <StatusDot status={s.status} />}
              {s ? (down ? `last known: ${statusLabel(s)}` : statusLabel(s)) : "not started"}
            </Badge>
            {s?.machine && (
              <Hint label={`It runs on ${s.machine}${machine?.os ? ` (${machine.os})` : ""}; servedev here reaches it over SSH`}>
                <span className={cn("flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground", machine?.state === "offline" && "opacity-70")}>
                  <MachineIcon machine={machine} className="size-3.5 shrink-0" />
                  <span className="truncate">
                    on {s.machine}
                    {machine && machineKind(machine) ? ` · ${machineKind(machine)}` : ""}
                  </span>
                </span>
              </Hint>
            )}
          </div>
          <div className={cn("flex flex-wrap gap-2 studio:gap-1.5", down && "opacity-60")} aria-disabled={down || undefined}>
            {s && (
              <Hint
                label={
                  s.machine
                    ? s.pinned
                      ? `Unpin on ${s.machine}: stop starting it when servedev starts there`
                      : `Pin on ${s.machine}: start it whenever servedev starts there`
                    : s.pinned
                      ? "Unpin: move it back into its project and stop starting it when you log in"
                      : "Pin: keep it at the top of the list and start it automatically when you log in"
                }
              >
                <Button
                  variant="ghost"
                  disabled={locked}
                  onClick={togglePin}
                  aria-pressed={!!s.pinned}
                >
                  {s.pinned ? (
                    <PinOffIcon data-icon="inline-start" />
                  ) : (
                    <PinIcon data-icon="inline-start" />
                  )}
                  {s.pinned ? "Unpin" : "Pin"}
                </Button>
              </Hint>
            )}
            {href && (
              <Hint label={`Open ${href} in a new browser tab (shortcut: O)`}>
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={<a href={href} target="_blank" rel="noopener" />}
                >
                  <ExternalLinkIcon data-icon="inline-start" />
                  Open in new tab
                </Button>
              </Hint>
            )}
            {active ? (
              <>
                <Hint label="Restart: stop it and start it again with the same command. Earlier runs' logs are kept.">
                  <Button
                    variant="outline"
                    onClick={() => run("restart")}
                    disabled={locked}
                  >
                    <RotateCwIcon data-icon="inline-start" />
                    {busy === "restart" ? "Restarting…" : "Restart"}
                  </Button>
                </Hint>
                <Hint label="Stop the server and every process it started. It stays in the list so you can start it again.">
                  <Button
                    variant="destructive"
                    onClick={() => run("stop")}
                    disabled={locked}
                  >
                    <SquareIcon data-icon="inline-start" />
                    {busy === "stop" ? "Stopping…" : "Stop"}
                  </Button>
                </Hint>
              </>
            ) : (
              <>
                <Hint label="Start it with its saved command, folder and environment">
                  <Button onClick={() => run("start")} disabled={locked}>
                    <PlayIcon data-icon="inline-start" />
                    {busy === "start" ? "Starting…" : "Start"}
                  </Button>
                </Hint>
              </>
            )}
            {s && (
              <AlertDialog>
                <Hint label="Remove it from servedev: stops it if it's running and deletes its logs and run history. Nothing on disk is deleted. (Asks first.)">
                  <AlertDialogTrigger
                    render={<Button variant="ghost" disabled={locked} />}
                  >
                    <Trash2Icon data-icon="inline-start" />
                    Remove
                  </AlertDialogTrigger>
                </Hint>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Remove {entry.name} from servedev?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {active ? "It's stopped first. " : ""}Its logs and run
                      history are deleted, and it's taken off any profiles and
                      grids.{" "}
                      {s?.source?.repo
                        ? "It's defined in the repo's servedev.json, so it's also taken out of that file and its shared profiles. Commit that change to remove it for everyone, or discard it to undo. To stop starting it only for yourself, skip it in a profile instead."
                        : "The project folder and its files aren't touched, so you can start it again later."}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => run("remove")}
                    >
                      {s?.source?.repo ? "Remove from servedev.json" : "Remove"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm studio:gap-x-8 studio:gap-y-2 studio:leading-5 friendly-rise friendly:items-baseline friendly:gap-y-2 friendly:rounded-2xl friendly:border friendly:bg-card friendly:px-5 friendly:py-3.5 friendly:shadow-xs friendly:@2xl/detail:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] friendly:@4xl/detail:gap-x-8 friendly:[&_dt]:text-[13px] friendly:[&_dt]:font-semibold">
          {s?.machine && (s.url || s.customUrl || (down && remotePort)) && (
            <>
              <dt className="text-muted-foreground">URL</dt>
              <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {/* Its name here, through this machine's proxy, then where that goes on its own machine. */}
                {href ? (
                  <a href={href} target="_blank" rel="noopener" className="font-mono underline-offset-4 hover:underline studio:text-xs">
                    {href}
                  </a>
                ) : (
                  <span className="font-mono text-muted-foreground studio:text-xs">{s.localHostname ? `http://${s.localHostname}` : "not reachable now"}</span>
                )}
                {remotePort && (
                  <Hint
                    label={
                      down
                        ? `It listened on ${s.machine}:${remotePort}; forwarding resumes when ${s.machine} reconnects`
                        : localPort && localPort !== remotePort
                          ? `${remotePort} is busy here, so servedev forwards ${s.machine}:${remotePort} to localhost:${localPort}. The name stays the same.`
                          : `Forwarded from ${s.machine}:${remotePort} to the same port here`
                    }
                  >
                    <span className="font-mono text-muted-foreground studio:text-xs">
                      → {s.machine}:{remotePort}
                      {!down && localPort && localPort !== remotePort && <span className={warnText}> at localhost:{localPort} here</span>}
                    </span>
                  </Hint>
                )}
              </dd>
            </>
          )}
          {s && !s.machine && (s.url || s.hostname) && (
            <>
              <dt className="text-muted-foreground">URL</dt>
              <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {s.hostname && (
                  <a
                    href={s.customUrl ?? `http://${s.hostname}`}
                    target="_blank"
                    rel="noopener"
                    className="font-mono underline-offset-4 hover:underline studio:text-xs"
                  >
                    {s.customUrl ?? `http://${s.hostname}`}
                  </a>
                )}
                {s.url && (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener"
                    className={
                      s.hostname
                        ? "font-mono text-muted-foreground underline-offset-4 hover:underline studio:text-xs"
                        : "font-mono underline-offset-4 hover:underline studio:text-xs"
                    }
                    title={
                      s.hostname
                        ? "The server's own port; the custom URL is proxied here"
                        : undefined
                    }
                  >
                    {s.hostname ? `→ ${s.url.replace("http://", "")}` : s.url}
                  </a>
                )}
                <Hint label="Reach it at a name like keel.localhost instead of a port number">
                  <Button
                    variant="link"
                    size="xs"
                    className="h-auto px-0"
                    onClick={() => setEditingHost(true)}
                  >
                    <LinkIcon data-icon="inline-start" />
                    {s.hostname ? "Edit custom URL" : "Add custom URL"}
                  </Button>
                </Hint>
              </dd>
            </>
          )}
          {s && (
            <>
              <dt className="text-muted-foreground">Defined in</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <Hint label={definedHint(s)}>
                  <span className="text-sm">{definedLabel(s)}</span>
                </Hint>
                {s.config !== "defined" && (
                  <Hint
                    label={
                      s.config === "differs"
                        ? "Update the repo's servedev.json to match how this server runs now (shows the changes first)"
                        : "Write how to run it into the repo's servedev.json, so it's shared through git and works on any machine"
                    }
                  >
                    <Button size="xs" variant="outline" onClick={() => setSavingConfig(true)}>
                      <SaveIcon data-icon="inline-start" />
                      {s.config === "differs" ? "Update servedev.json" : "Save to servedev.json"}
                    </Button>
                  </Hint>
                )}
              </dd>
            </>
          )}
          {s?.vars && s.vars.length > 0 && (
            <>
              <dt className="text-muted-foreground">Variables</dt>
              <dd className="flex min-w-0 flex-wrap gap-1.5">
                {s.vars.map((v) => (
                  <Hint key={v.name} label={`${v.name} is set for this server on purpose${v.secret ? " (looks like a secret)" : ""}. Everything else comes from your login shell at each start.`}>
                    <span className="inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-xs studio:bg-muted/40 studio:text-[11px] friendly:rounded-full friendly:bg-muted/60 friendly:px-2.5">
                      {v.secret && <LockIcon className="size-3 shrink-0 text-muted-foreground" aria-label="secret" />}
                      <span className="truncate">
                        {v.name}=<span className="text-muted-foreground">{v.preview}</span>
                      </span>
                    </span>
                  </Hint>
                ))}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Command</dt>
          <dd className="font-mono break-all studio:text-xs studio:leading-5">{command}</dd>
          {(s?.branch ?? entry.configured?.branch) && (
            <>
              <dt className="text-muted-foreground">Branch</dt>
              <dd>
                <BranchTag
                  branch={(s?.branch ?? entry.configured?.branch)!}
                  className="text-xs"
                />
              </dd>
            </>
          )}
          {s?.accounts && (
            <>
              <dt className="text-muted-foreground">Accounts</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-2">
                <AccountTag server={s} className="text-xs" />
                {s.accountsStale && (
                  <Button size="xs" variant="outline" onClick={() => run("restart")} disabled={!!busy}>
                    Restart to apply {s.accounts.profile.name}'s new accounts
                  </Button>
                )}
              </dd>
            </>
          )}
          {(s?.cwd ?? entry.configured?.root) && (
            <>
              <dt className="text-muted-foreground">Directory</dt>
              <dd className="font-mono break-all studio:text-xs studio:leading-5">
                {tildify(s?.cwd ?? entry.configured!.root)}
                {s?.machine && <span className="font-sans text-muted-foreground"> on {s.machine}</span>}
              </dd>
            </>
          )}
          {active && !down && (
            <>
              <dt className="text-muted-foreground">PID</dt>
              <dd className="font-mono studio:text-xs studio:leading-5">{s.pid}</dd>
              <dt className="text-muted-foreground">Uptime</dt>
              <dd className="studio:tabular-nums">{ago(s.startedAt, now)}</dd>
            </>
          )}
          {active && groups && groups.length > 0 && (
            <>
              <dt className="text-muted-foreground">Processes</dt>
              <dd>
                <Hint label="Show its process groups and which process owns which port">
                  <button
                    type="button"
                    onClick={() => setTab("processes")}
                    className="underline-offset-4 hover:underline"
                  >
                    {processCount} in {groups.length} process{" "}
                    {groups.length === 1 ? "group" : "groups"}
                  </button>
                </Hint>
              </dd>
            </>
          )}
          {active && s.ports.length > 1 && (
            <>
              <dt className="text-muted-foreground">Ports</dt>
              <dd className="font-mono studio:text-xs studio:leading-5">{s.ports.join(", ")}</dd>
            </>
          )}
          {s && !active && s.stoppedAt && (
            <>
              <dt className="text-muted-foreground">Stopped</dt>
              <dd className="studio:tabular-nums">{ago(s.stoppedAt, now)} ago</dd>
            </>
          )}
        </dl>

        {s?.machine && down && machine?.state === "offline" && (
          <Alert className="friendly-rise">
            <TriangleAlertIcon />
            <AlertTitle>{s.machine} is offline</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                This is what servedev last saw{machine.lastSeen ? `, ${ago(machine.lastSeen, now)} ago` : ""}. Start, stop and new logs come back when it
                reconnects.
              </span>
              <RetryButton machine={machine} label="Retry now" />
            </AlertDescription>
          </Alert>
        )}
        {s?.machine && down && machine?.state !== "offline" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner className="size-3.5" />
            {machine?.state === "connecting" ? "Connecting" : "Reconnecting"} to {s.machine}… actions are paused until it's back.
          </p>
        )}
        {s && !active && s.status === "crashed" && (
          <Alert variant="destructive" className="friendly-rise">
            <TriangleAlertIcon />
            <AlertTitle>
              {statusLabel(s)[0].toUpperCase() + statusLabel(s).slice(1)}
            </AlertTitle>
            <AlertDescription>
              {s.error ??
                "The process exited with an error. Check the log below for the cause."}
            </AlertDescription>
          </Alert>
        )}
      </div>

      {s && (
        <HostnameDialog
          server={s}
          open={editingHost}
          onOpenChange={setEditingHost}
        />
      )}
      {s && <SaveConfigDialog server={s} open={savingConfig} onOpenChange={setSavingConfig} />}
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "logs" | "processes" | "preview")}
        className="flex min-h-0 flex-1 flex-col gap-0 border-t friendly:border-t-0"
      >
        <div className="px-4 pt-2 md:px-6 friendly:px-5 friendly:pt-1 friendly:md:px-7">
          <TabsList>
            <Hint label="Live output, run history and search">
              <TabsTrigger value="logs">Logs</TabsTrigger>
            </Hint>
            <Hint label="Every process it started, grouped by process group, with their ports">
              <TabsTrigger value="processes" disabled={!s}>
                Processes
                {active && groups && (
                  <span className="text-muted-foreground tabular-nums studio:rounded-[4px] studio:bg-foreground/[0.06] studio:px-1 studio:text-[11px] studio:leading-4 friendly:rounded-full friendly:bg-muted-foreground/12 friendly:px-1.5 friendly:text-xs friendly:leading-5">
                    {processCount}
                    {groups.length > 1 ? ` in ${groups.length} groups` : ""}
                  </span>
                )}
              </TabsTrigger>
            </Hint>
            <Hint label="The running app itself, inside this page">
              <TabsTrigger value="preview" disabled={!s}>
                Preview
              </TabsTrigger>
            </Hint>
          </TabsList>
        </div>
        <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col">
          <LogView
            key={entry.key}
            serverId={s?.id}
            command={s?.command}
            runId={s?.runId}
            status={s?.status}
            placeholder={
              s
                ? undefined
                : "This server is defined in servedev.json but hasn't been started."
            }
          />
        </TabsContent>
        <TabsContent value="processes" className="flex min-h-0 flex-1 flex-col">
          <ProcessView groups={groups} running={active} />
        </TabsContent>
        <TabsContent value="preview" className="flex min-h-0 flex-1 flex-col">
          {s && tab === "preview" && <AppPreview server={s} />}
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** Where a server's definition comes from: the repo (shared), your config.json, or both. */
function definedLabel(s: Server): string {
  if (s.source?.repo && s.source.local) return "servedev.json, with your changes"
  if (s.source?.repo) return s.config === "differs" ? "servedev.json (running differently)" : "servedev.json (shared)"
  return "Your config only"
}

function definedHint(s: Server): string {
  if (s.source?.repo && s.source.local)
    return "The repo's servedev.json defines it for everyone; ~/.servedev/config.json changes some of it just for you."
  if (s.source?.repo) return "The repo's servedev.json defines it, so everyone who clones the repo gets it."
  return "Only in ~/.servedev/config.json. Save it to servedev.json to share it through git."
}
