/**
 * A folder navigator for machines without a native picker here: another machine's folders (through
 * the hub), or this one when no picker is installed. Lists subfolders only (GET /api/dirs), marking
 * the ones that look like projects.
 */
import * as React from "react"
import { ChevronRightIcon, ChevronUpIcon, FolderIcon, GitBranchIcon } from "@/components/icons"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { api, type DirListing } from "@/lib/api"
import { cn } from "@/lib/utils"

function Markers({ d }: { d: { package?: boolean; servedev?: boolean; git?: boolean } }) {
  return (
    <>
      {d.servedev && <Badge variant="secondary">servedev.json</Badge>}
      {d.package && <Badge variant="outline">package.json</Badge>}
      {d.git && (
        <span className="text-muted-foreground" title="git repository">
          <GitBranchIcon className="size-3.5" aria-label="git repository" />
        </span>
      )}
    </>
  )
}

export function FolderBrowser({
  machine,
  start,
  onPick,
}: {
  /** Another machine; undefined for this one. */
  machine?: string
  /** Folder to open first (default: home). */
  start?: string
  onPick: (path: string) => void
}) {
  const [path, setPath] = React.useState(start?.trim() || "~")
  const [hidden, setHidden] = React.useState(false)
  const [listing, setListing] = React.useState<DirListing | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const q = new URLSearchParams({ path, ...(machine ? { machine } : {}), ...(hidden ? { hidden: "1" } : {}) })
    api<DirListing>(`/api/dirs?${q}`)
      .then((r) => {
        if (cancelled) return
        setListing(r)
      })
      .catch((e) => {
        if (cancelled) return
        // A folder that's gone (or a typo): fall back to home once.
        if (/^no folder at/.test((e as Error).message) && path !== "~") setPath("~")
        else setError((e as Error).message)
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [path, machine, hidden])

  const shown = listing && !error ? listing : null
  const display = (p: string) => (shown && p.startsWith(shown.home) ? `~${p.slice(shown.home.length)}` : p)

  return (
    <div className="flex flex-col gap-2" data-slot="folder-browser">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Up one folder"
          disabled={!shown?.parent || loading}
          onClick={() => shown?.parent && setPath(shown.parent)}
        >
          <ChevronUpIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={shown?.path ?? path}>
          {shown ? display(shown.path) : path}
        </span>
        {loading && <Spinner className="size-3.5" />}
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <div
          role="list"
          aria-label={machine ? `Folders on ${machine}` : "Folders"}
          className={cn("flex max-h-64 flex-col overflow-y-auto rounded-md border", loading && "opacity-60")}
        >
          {shown?.dirs.map((d) => (
            <button
              key={d.path}
              type="button"
              role="listitem"
              onClick={() => setPath(d.path)}
              onDoubleClick={() => onPick(d.path)}
              className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              <Markers d={d} />
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          ))}
          {shown && !shown.dirs.length && <p className="px-2.5 py-3 text-sm text-muted-foreground">No folders in here.</p>}
          {shown?.truncated && <p className="px-2.5 py-1.5 text-xs text-muted-foreground">More folders than shown; type the path to go further.</p>}
        </div>
      )}

      {!error && (
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Checkbox id="fb-hidden" checked={hidden} onCheckedChange={(v) => setHidden(!!v)} />
          <Label htmlFor="fb-hidden" className="text-xs font-normal text-muted-foreground">
            Hidden folders{shown && !hidden && shown.hidden ? ` (${shown.hidden})` : ""}
          </Label>
        </div>
        <Button type="button" size="sm" disabled={!shown} onClick={() => shown && onPick(shown.path)}>
          Use this folder
        </Button>
      </div>
      )}
      {shown && (shown.package || shown.servedev || shown.git) && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          This folder has <Markers d={shown} />
        </div>
      )}
    </div>
  )
}
