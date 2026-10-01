import * as React from "react"
import { ExternalLinkIcon, RotateCwIcon } from "@/components/icons"

import { Hint, TruncatedText } from "@/components/hint"
import { useStyleId } from "@/components/style-provider"
import { Button } from "@/components/ui/button"
import { ACTIVE, api, openUrl, type Server } from "@/lib/api"

type FrameCheck = { frameable: boolean; reason?: string }
const frameChecks = new Map<string, Promise<FrameCheck>>()

/** Ask the daemon whether the app allows being framed, before showing it (cached per URL for a minute). */
function useFrameCheck(url: string | undefined): FrameCheck | null {
  const [result, setResult] = React.useState<FrameCheck | null>(null)
  React.useEffect(() => {
    setResult(null)
    if (!url) return
    let cancelled = false
    if (!frameChecks.has(url)) {
      frameChecks.set(
        url,
        api<FrameCheck>(
          `/api/frame-check?${new URLSearchParams({ url })}`
        ).catch(() => ({ frameable: true }))
      )
      setTimeout(() => frameChecks.delete(url), 60_000)
    }
    void frameChecks.get(url)!.then((r) => !cancelled && setResult(r))
    return () => {
      cancelled = true
    }
  }, [url])
  return result
}

/** The running app in a frame, or why it can't be shown there. */
export function AppPreview({ server: s }: { server: Server }) {
  const active = ACTIVE.includes(s.status)
  const href = openUrl(s)
  const studio = useStyleId() === "studio"
  const frame = useFrameCheck(active ? href : undefined)
  const [reloadKey, setReloadKey] = React.useState(0)

  if (!active || !href) {
    return (
      <p className="m-auto px-4 text-center text-sm text-muted-foreground">
        {active
          ? "Waiting for the server to listen on a port…"
          : "Start the server to see a preview."}
      </p>
    )
  }
  if (!frame)
    return (
      <p className="m-auto text-sm text-muted-foreground">
        Checking whether it can be shown here…
      </p>
    )
  if (!frame.frameable) {
    return (
      <div className="m-auto flex max-w-md flex-col items-center gap-3 px-4 text-center">
        <p className="text-sm font-medium">
          {s.name} can't be shown inside another page
        </p>
        <p className="text-sm text-muted-foreground">
          The app forbids it with{" "}
          <code className="font-mono">{frame.reason}</code>, a standard
          protection against clickjacking. Open it in its own tab instead.
        </p>
        <Hint label={`Open ${href} in a new browser tab`}>
          <Button
            size="sm"
            nativeButton={false}
            render={<a href={href} target="_blank" rel="noopener" />}
          >
            <ExternalLinkIcon data-icon="inline-start" />
            Open in new tab
          </Button>
        </Hint>
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-1.5 text-xs text-muted-foreground md:px-6 studio:bg-surface-sunken">
        {/* Studio style: a hint of browser chrome around the address. */}
        {studio && (
          <span aria-hidden className="mr-1 flex shrink-0 gap-1.5">
            <span className="size-2 rounded-full bg-foreground/10" />
            <span className="size-2 rounded-full bg-foreground/10" />
            <span className="size-2 rounded-full bg-foreground/10" />
          </span>
        )}
        <TruncatedText text={href} className="font-mono studio:min-w-0 studio:rounded-md studio:border studio:bg-card studio:px-2 studio:py-0.5 studio:text-[11px] studio:shadow-xs" />
        <Hint label="Reload the preview (the server keeps running)">
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            <RotateCwIcon data-icon="inline-start" />
            Reload
          </Button>
        </Hint>
        <Hint label={`Open ${href} in a new browser tab`}>
          <Button
            variant="ghost"
            size="xs"
            nativeButton={false}
            render={<a href={href} target="_blank" rel="noopener" />}
          >
            <ExternalLinkIcon data-icon="inline-start" />
            Open in new tab
          </Button>
        </Hint>
      </div>
      <iframe
        key={`${href}#${reloadKey}`}
        src={href}
        title={`${s.name} preview`}
        className="min-h-0 flex-1 bg-white studio:animate-in studio:fade-in-0 studio:duration-300"
      />
    </div>
  )
}
