import * as React from "react"
import { CopyIcon } from "@/components/icons"
import { toast } from "sonner"

import { Hint } from "@/components/hint"
import { copyText } from "@/lib/clipboard"
import { entryBounds } from "@/lib/log-entries"
import { cn } from "@/lib/utils"

/**
 * Copy one log entry: hovering a line highlights its entry (the line plus continuation lines like
 * structured fields or a stack trace) and shows a copy button. Shift-click copies every entry from
 * the last one copied to this one. One element follows the pointer, however many lines there are.
 * `container` must be the positioned element holding the `[data-line]` rows.
 */
export function LineCopy({
  container,
  lines,
  className,
}: {
  container: React.RefObject<HTMLElement | null>
  lines: string[]
  className?: string
}) {
  const [hover, setHover] = React.useState<{
    start: number
    end: number
    top: number
    height: number
  } | null>(null)
  const linesRef = React.useRef(lines)
  linesRef.current = lines
  /** The entry copied last, for shift-click ranges. */
  const anchor = React.useRef<[number, number] | null>(null)

  React.useEffect(() => {
    const el = container.current
    if (!el) return
    const onMove = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-line-copy]")) return
      // In the margin beside the text (where the button sits) there's no row under the pointer;
      // use the row at the same height, so the button doesn't vanish on the way to it.
      const probe = () => {
        const box = el.getBoundingClientRect()
        return document
          .elementFromPoint(box.left + 24, e.clientY)
          ?.closest<HTMLElement>("[data-line]")
      }
      const row =
        (e.target as HTMLElement).closest<HTMLElement>("[data-line]") ?? probe()
      if (!row || !el.contains(row)) return
      const [start, end] = entryBounds(
        linesRef.current,
        Number(row.dataset.line)
      )
      const first = el.querySelector<HTMLElement>(`[data-line="${start}"]`)
      const last = el.querySelector<HTMLElement>(`[data-line="${end}"]`)
      if (!first || !last) return
      setHover((h) =>
        h?.start === start && h.end === end
          ? h
          : {
              start,
              end,
              top: first.offsetTop,
              height: last.offsetTop + last.offsetHeight - first.offsetTop,
            }
      )
    }
    const onLeave = () => setHover(null)
    el.addEventListener("mousemove", onMove)
    el.addEventListener("mouseleave", onLeave)
    return () => {
      el.removeEventListener("mousemove", onMove)
      el.removeEventListener("mouseleave", onLeave)
    }
  }, [container])

  // A new log (restart, other run) invalidates the shift-click anchor.
  React.useEffect(() => {
    anchor.current = null
  }, [lines.length === 0])

  if (!hover || hover.end >= lines.length) return null
  const size = hover.end - hover.start + 1

  async function copy(e: React.MouseEvent) {
    const { start, end } = hover!
    const prev = anchor.current
    const from = e.shiftKey && prev ? Math.min(prev[0], start) : start
    const to = e.shiftKey && prev ? Math.max(prev[1], end) : end
    anchor.current = [start, end]
    const text = lines.slice(from, to + 1).join("\n")
    try {
      await copyText(text)
      const n = to - from + 1
      toast.success(
        e.shiftKey && prev
          ? `Copied ${n} lines`
          : n === 1
            ? "Copied the log line"
            : `Copied the log entry (${n} lines)`,
        {
          description: text.split("\n")[0].slice(0, 120),
        }
      )
    } catch (err) {
      toast.error("Couldn't copy", { description: (err as Error).message })
    }
  }

  return (
    <>
      {size > 1 && (
        // Shows which lines belong to the entry that will be copied.
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 rounded-sm bg-primary/5 ring-1 ring-primary/10 friendly:rounded-lg friendly:bg-primary/6 friendly:ring-primary/15 studio:rounded-none studio:bg-primary/[0.05] studio:ring-0 studio:shadow-[inset_2px_0_0_color-mix(in_oklch,var(--primary)_55%,transparent)] studio:animate-in studio:fade-in-0 studio:duration-150"
          style={{ top: hover.top, height: hover.height }}
        />
      )}
      {/* Spans the entry; the button inside sticks to the top of the visible part while scrolling. */}
      <div
        className={cn("pointer-events-none absolute right-1 z-10", className)}
        style={{ top: hover.top, height: hover.height }}
      >
        <Hint
          label={`Copy this log entry${size > 1 ? ` (${size} lines)` : ""}. Shift-click another entry's copy button to copy everything in between.`}
          side="left"
        >
          <button
            type="button"
            data-line-copy
            onMouseDown={(e) => e.preventDefault()} // keep any text selection
            onClick={copy}
            aria-label={
              size > 1
                ? `Copy log entry (lines ${hover.start + 1}–${hover.end + 1})`
                : `Copy line ${hover.start + 1}`
            }
            className="pointer-events-auto sticky top-1 mt-px flex size-5 items-center justify-center rounded-sm border bg-background text-muted-foreground shadow-xs hover:text-foreground friendly:size-6 friendly:rounded-lg friendly:bg-card friendly:shadow-sm friendly:transition-colors friendly:hover:border-primary/40 friendly:hover:text-primary studio:rounded-[5px] studio:bg-card studio:shadow-sm studio:transition-colors studio:animate-in studio:fade-in-0 studio:zoom-in-90 studio:duration-150 studio:hover:border-ring/50"
          >
            <CopyIcon className="size-3" />
          </button>
        </Hint>
      </div>
    </>
  )
}
