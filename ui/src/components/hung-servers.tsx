import * as React from "react"
import { BrushCleaningIcon } from "@/components/icons"
import { toast } from "sonner"

import { Hint } from "@/components/hint"
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
import { Spinner } from "@/components/ui/spinner"
import { ago, api, type ExternalServer } from "@/lib/api"

const plural = (n: number) => `${n} hung ${n === 1 ? "server" : "servers"}`

/**
 * Clears servers left running from deleted folders (removed worktrees): they can't be taken over,
 * only stopped. Stops exactly the servers listed in the confirmation.
 */
export function HungServers({ servers, onCleared }: { servers: ExternalServer[]; onCleared: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [working, setWorking] = React.useState(false)
  const hung = servers.filter((s) => s.orphaned)
  const [listed, setListed] = React.useState<ExternalServer[]>([])
  if (!hung.length) return null

  async function clear() {
    setWorking(true)
    try {
      const r = await api<{ stopped: ExternalServer[] }>("/api/external/stop-hung", { ids: listed.map((s) => s.id) })
      toast.success(`Stopped ${plural(r.stopped.length)}`, {
        description: `Freed ${r.stopped.flatMap((s) => s.ports).map((p) => `:${p}`).join(", ") || "their ports"}.`,
      })
      onCleared()
    } catch (e) {
      toast.error("Couldn't clear hung servers", { description: (e as Error).message })
    } finally {
      setWorking(false)
      setOpen(false)
    }
  }

  return (
    <>
      <Hint label="Stop servers still running from folders that were deleted (removed worktrees, most likely). They can't be restarted, only stopped.">
        <Button
          size="sm"
          variant="outline"
          className="w-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive group-data-[collapsible=icon]:hidden"
          onClick={() => {
            // Freeze the list being confirmed, so exactly these are stopped.
            setListed(hung)
            setOpen(true)
          }}
        >
          <BrushCleaningIcon data-icon="inline-start" />
          Clear hung servers ({hung.length})
        </Button>
      </Hint>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {plural(listed.length)}?</AlertDialogTitle>
            <AlertDialogDescription>
              These are still running from folders that no longer exist, so there's nothing to restart them from. Only their own processes are
              stopped; your other servers and the tools that started them aren't touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-72 overflow-auto rounded-lg border py-1 text-sm">
            {listed.map((s) => (
              <li key={s.id} className="flex items-baseline gap-2 px-3 py-1">
                <span className="font-medium">{s.suggestedName}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={s.project}>
                  {s.project}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">:{s.ports.join(", :")}</span>
                {s.startedAt && <span className="shrink-0 text-xs text-muted-foreground">up {ago(s.startedAt)}</span>}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={clear} disabled={working}>
              {working && <Spinner data-icon="inline-start" />}
              Stop {plural(listed.length)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
