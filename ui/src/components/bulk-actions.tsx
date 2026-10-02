import * as React from "react"
import { PlayIcon, SquareIcon } from "@/components/icons"
import { toast } from "sonner"

import { Hint, TruncatedText } from "@/components/hint"
import { StatusDot } from "@/components/status-dot"
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
import { ACTIVE, api, type Server } from "@/lib/api"
import { MachineTag } from "@/components/machine-ui"
import { useMachines } from "@/hooks/use-machines"

const plural = (n: number) => `${n} ${n === 1 ? "server" : "servers"}`

/**
 * Start all / Stop all for whatever the dashboard is showing: every server, a profile (in its
 * start order), or a custom grid. Both confirm first and list the servers they'll touch.
 */
export function BulkActions({ servers, scope, profileId }: { servers: Server[]; scope: string; profileId?: string }) {
  const [confirm, setConfirm] = React.useState<"start" | "stop" | null>(null)
  // Servers on a machine that isn't connected are left out (and named in the dialog).
  const machines = useMachines()
  const unreachable = servers.filter((s) => s.machine && (s.stale || machines.get(s.machine)?.state !== "connected"))
  const reachable = servers.filter((s) => !unreachable.includes(s))
  const toStart = reachable.filter((s) => !ACTIVE.includes(s.status))
  const toStop = reachable.filter((s) => s.status === "running" || s.status === "starting")
  const skipped = [...new Set(unreachable.map((s) => s.machine!))]
  const severalMachines = new Set((confirm === "start" ? toStart : toStop).map((s) => s.machine ?? "")).size > 1
  const targets = confirm === "start" ? toStart : toStop
  // "all 4 running servers" or "the 2 running servers in Keel stack"
  const where = (n: number, state: string) =>
    scope === "all servers" ? `all ${n} ${state === "running" ? "running " : ""}${n === 1 ? "server" : "servers"}${state === "running" ? "" : ` ${state}`}` : `the ${plural(n)} in ${scope} ${state === "running" ? "that are running" : state}`

  async function run() {
    const action = confirm
    setConfirm(null)
    if (!action) return
    const ids = (action === "start" ? toStart : toStop).map((s) => s.id)
    try {
      if (action === "start") {
        await api("/api/servers/start", { ids, wait: false, profile: profileId })
        toast.success(`Starting ${plural(ids.length)}`, { description: "One at a time, each after the previous one is ready." })
      } else {
        await api("/api/servers/stop", { ids })
        toast.success(`Stopped ${plural(ids.length)}`)
      }
    } catch (e) {
      toast.error(`Couldn't ${action} ${scope}`, { description: (e as Error).message })
    }
  }

  return (
    <div className="flex gap-2 group-data-[collapsible=icon]:hidden">
      <Hint label={toStart.length ? `Start ${where(toStart.length, "that aren't running")}, one after another (asks first)` : scope === "all servers" ? "Every server is running" : `Everything in ${scope} is running`}>
        <span className="flex flex-1">
          <Button size="sm" variant="outline" className="flex-1" disabled={!toStart.length} onClick={() => setConfirm("start")}>
            <PlayIcon data-icon="inline-start" />
            Start all{toStart.length ? ` (${toStart.length})` : ""}
          </Button>
        </span>
      </Hint>
      <Hint label={toStop.length ? `Stop ${where(toStop.length, "running")}, with every process they started (asks first)` : scope === "all servers" ? "No server is running" : `Nothing in ${scope} is running`}>
      <span className="flex flex-1">
      <Button
        size="sm"
        variant="outline"
        className="flex-1 hover:border-destructive/40 hover:text-destructive"
        disabled={!toStop.length}
        onClick={() => setConfirm("stop")}
      >
        <SquareIcon data-icon="inline-start" />
        Stop all{toStop.length ? ` (${toStop.length})` : ""}
      </Button>
      </span>
      </Hint>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "start" ? "Start" : "Stop"}{" "}
              {scope === "all servers" ? `all ${plural(targets.length)}` : `${plural(targets.length)} in ${scope}`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "start"
                ? `They start one at a time, in this order, each after the previous one is ready${severalMachines ? (profileId ? ", each on its own machine" : " (each machine starts its own, alongside the others)") : ""}. Servers that are already running are left alone.`
                : "Each server and every process it started is shut down. Logs are kept, and you can start them again any time."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-60 overflow-auto rounded-lg border py-1 text-sm friendly:rounded-xl friendly:bg-card friendly:py-1.5">
            {targets.map((s) => (
              <li key={s.id} className="flex items-center gap-2 px-3 py-1 friendly:px-3.5 friendly:py-1.5">
                <StatusDot status={s.status} />
                <span className="font-medium">{s.name}</span>
                <TruncatedText text={s.project} className="text-muted-foreground" />
                {s.machine && machines.get(s.machine) && <MachineTag machine={machines.get(s.machine)!} className="ml-auto" />}
              </li>
            ))}
          </ul>
          {skipped.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Left out: the servers on {skipped.map((m) => `${m} (${machines.get(m)?.state ?? "offline"})`).join(", ")}, which can't be reached right now.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={confirm === "stop" ? "destructive" : "default"} onClick={run}>
              {confirm === "start" ? "Start" : "Stop"} {plural(targets.length)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
