import * as React from "react"
import { ExternalLinkIcon } from "@/components/icons"

import { Badge } from "@/components/ui/badge"
import { Hint, TruncatedText } from "@/components/hint"
import { ScrollArea } from "@/components/ui/scroll-area"
import { api, type ProcessGroup } from "@/lib/api"
import { useStyleId } from "@/components/style-provider"

/** Live process groups for a server; polls while `enabled`. */
export function useProcessGroups(serverId: string | undefined, enabled: boolean, intervalMs = 2000) {
  const [groups, setGroups] = React.useState<ProcessGroup[] | null>(null)
  React.useEffect(() => {
    setGroups(null)
    if (!serverId || !enabled) return
    let cancelled = false
    const load = () =>
      api<{ groups: ProcessGroup[] }>(`/api/processes?${new URLSearchParams({ id: serverId })}`)
        .then((r) => !cancelled && setGroups(r.groups))
        .catch(() => {})
    void load()
    const t = setInterval(load, intervalMs)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [serverId, enabled, intervalMs])
  return groups
}

function explain(groups: ProcessGroup[]): string {
  if (groups.length <= 1) {
    return "All of this server's processes are in the one process group servedev started, so Stop and Restart reach every one of them."
  }
  const creators = [...new Set(groups.filter((g) => g.createdBy !== "servedev").map((g) => g.createdBy))]
  const extra = groups.length - 1
  return (
    `servedev started this server in one process group, and ${creators.join(" and ")} created ${extra} more for ${extra === 1 ? "its task" : "its tasks"}. ` +
    "servedev adopts every group started inside this server, so it finds their ports, and Stop and Restart reach all of them."
  )
}

export function ProcessView({ groups, running }: { groups: ProcessGroup[] | null; running: boolean }) {
  const terminal = useStyleId() === "terminal"
  if (!running) return <p className="px-4 py-6 text-sm text-muted-foreground md:px-6 friendly:px-5 friendly:md:px-7">No processes. The server isn't running.</p>
  if (!groups) return <p className="px-4 py-6 text-sm text-muted-foreground md:px-6 friendly:px-5 friendly:md:px-7">Loading processes…</p>

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 px-4 py-4 md:px-6 friendly:px-5 friendly:md:px-7">
        <p className="max-w-prose text-sm text-muted-foreground">{explain(groups)}</p>
        {groups.map((g) => (
          <section key={g.pgid} className="rounded-lg border studio:overflow-hidden studio:bg-card friendly-rise friendly:overflow-hidden friendly:rounded-2xl friendly:bg-card friendly:shadow-xs" aria-label={`Process group ${g.pgid}`}>
            <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm studio:bg-muted/30 friendly:bg-muted/50 friendly:px-4 friendly:py-2.5">
              <Badge variant={g.createdBy === "servedev" ? "secondary" : "outline"} className="font-mono">
                group {g.pgid}
              </Badge>
              <span>{g.createdBy === "servedev" ? "Started by servedev" : `Created by ${g.createdBy}`}</span>
              <span className="ml-auto text-xs text-muted-foreground studio:tabular-nums">
                {g.processes.length} {g.processes.length === 1 ? "process" : "processes"}
              </span>
            </header>
            <ul className="flex flex-col py-1 friendly:py-1.5">
              {g.processes.map((p) => (
                <li key={p.pid} className="flex min-w-0 items-center gap-3 px-3 py-1 text-xs studio:transition-colors studio:hover:bg-muted/40 friendly:px-4 friendly:py-1.5">
                  <span className="w-12 shrink-0 font-mono text-muted-foreground tabular-nums">{p.pid}</span>
                  <span className="flex min-w-0 flex-1 font-mono" style={{ paddingLeft: `${p.depth * 16}px` }}>
                    {p.depth > 0 && <span className="shrink-0 text-muted-foreground">{terminal ? "└─" : "└"}&nbsp;</span>}
                    <TruncatedText text={p.command} />
                  </span>
                  {p.ports.map((port) => (
                    <Hint key={port} label={`Open http://localhost:${port} in a new tab`}>
                      <a
                        href={`http://localhost:${port}`}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono tabular-nums hover:bg-muted studio:rounded-sm studio:text-[11px] studio:text-muted-foreground studio:hover:text-foreground friendly:rounded-full friendly:bg-card friendly:px-2 friendly:transition-colors friendly:hover:border-primary/40 friendly:hover:bg-accent friendly:hover:text-accent-foreground"
                      >
                        :{port}
                        <ExternalLinkIcon className="size-3" />
                      </a>
                    </Hint>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </ScrollArea>
  )
}
