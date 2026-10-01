import * as React from "react"
import { LayoutGridIcon } from "@/components/icons"
import ReactGridLayout, { useContainerWidth, type Layout } from "react-grid-layout"
import "react-grid-layout/css/styles.css"

import { DRAG_HANDLE, NO_DRAG, ServerTile } from "@/components/server-tile"
import { useStyleId } from "@/components/style-provider"
import { EmptyGridArt } from "@/components/friendly-decor"
import { GridIllustration } from "@/components/studio-decor"
import { useMultiLogStream } from "@/hooks/use-multi-log"
import { TILE } from "@/hooks/use-custom-grid"
import { SERVER_MIME } from "@/lib/drag"
import type { LayoutItem, Server } from "@/lib/api"

const COLS = 12
const ROW_HEIGHT = 32
/** Below this width the grid is a plain stack; dragging tiles on a phone isn't useful. */
const STACK_BELOW = 640
/** react-grid-layout's id for the placeholder shown while dragging something in from outside. */
const DROPPING = "__dropping-elem__"

/** Grid cell under a pointer event, for a drop without a position from the grid. */
function cellAt(e: DragEvent, width: number) {
  const grid = (e.currentTarget as HTMLElement | null) ?? document.querySelector<HTMLElement>(".react-grid-layout")
  const rect = grid?.getBoundingClientRect() ?? { left: 0, top: 0 }
  const colWidth = (width - 12 * (COLS - 1)) / COLS
  const x = Math.floor((e.clientX - rect.left) / (colWidth + 12))
  return { x: Math.max(0, Math.min(COLS - TILE.w, x)), y: Math.max(0, Math.floor((e.clientY - rect.top) / (ROW_HEIGHT + 12))) }
}

export function GridView({
  items,
  version,
  servers,
  selected,
  onLayout,
  onDropServer,
  onRemove,
  onOpenDetails,
}: {
  items: LayoutItem[]
  /** Changes when the layout was replaced from outside; the grid then starts fresh from `items`. */
  version: number
  servers: Map<string, Server>
  selected: string | null
  onLayout: (layout: Layout) => void
  onDropServer: (id: string, at: { x: number; y: number }) => void
  onRemove: (id: string) => void
  onOpenDetails: (id: string) => void
}) {
  const { width, containerRef, mounted } = useContainerWidth()
  const styleId = useStyleId()
  const terminal = styleId === "terminal"
  const studio = styleId === "studio"
  const friendly = styleId === "friendly"
  const shown = React.useMemo(() => items.filter((it) => servers.has(it.i)), [items, servers])
  // Stable across renders (logs stream in constantly); the grid compares it to its own state.
  const layout = React.useMemo(() => shown.map((it) => ({ ...it, minW: TILE.minW, minH: TILE.minH })), [shown])
  const logs = useMultiLogStream(shown.map((it) => it.i))

  // Selecting a server in the sidebar brings its tile into view.
  React.useEffect(() => {
    if (selected) document.querySelector(`[data-tile-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [selected])

  const tile = (it: LayoutItem) => {
    const s = servers.get(it.i)!
    return (
      <ServerTile
        server={s}
        onRemove={() => onRemove(s.id)}
        log={logs[s.id] ?? ""}
        selected={selected === s.id}
        onOpenDetails={() => onOpenDetails(s.id)}
      />
    )
  }

  const empty = shown.length === 0 && (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center terminal:inset-3 terminal:border terminal:border-dashed terminal:border-input studio:animate-in studio:fade-in-0 studio:slide-in-from-bottom-1 studio:duration-500">
      {terminal && (
        // Decorative: an empty 2x2 tmux layout.
        <pre aria-hidden className="mb-2 text-[10px] leading-[1.15] text-muted-foreground select-none">
          {"┌────────┬────────┐\n│        │        │\n│ $ _    │        │\n├────────┼────────┤\n│        │        │\n│        │        │\n└────────┴────────┘"}
        </pre>
      )}
      {studio ? <GridIllustration className="mb-2" /> : friendly ? <EmptyGridArt className="mb-2 friendly-rise" /> : <LayoutGridIcon className="size-6 text-muted-foreground terminal:size-4 terminal:text-primary" />}
      <p className="phosphor-glow text-sm font-medium terminal:font-semibold studio:tracking-tight friendly:text-lg friendly:font-extrabold friendly:tracking-tight">
        Build your grid
        {terminal && <span aria-hidden className="term-cursor ml-1" />}
      </p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Drag servers here from the list on the left, or click the + next to one. Drag tiles by their header and resize them from the corner.
      </p>
    </div>
  )

  return (
    <div className="min-h-0 flex-1 overflow-auto p-2 md:p-3">
      {/* Measured without the padding, so the grid gets exactly the width it can use. */}
      <div ref={containerRef} className="relative min-h-full">
        {empty}
        {mounted && width < STACK_BELOW && (
          <div className="flex flex-col gap-3">
            {shown.map((it) => (
              <div key={it.i} data-tile-id={it.i} className="h-80">
                {tile(it)}
              </div>
            ))}
          </div>
        )}
        {mounted && width >= STACK_BELOW && (
          <ReactGridLayout
            key={version}
            width={width}
            // An empty grid still needs room to be a drop target.
            className="min-h-[calc(100svh-6rem)]"
            layout={layout}
            gridConfig={{ cols: COLS, rowHeight: ROW_HEIGHT, margin: [12, 12], containerPadding: [0, 0] }}
            dragConfig={{ handle: `.${DRAG_HANDLE}`, cancel: `.${NO_DRAG}` }}
            resizeConfig={{ handles: ["se"] }}
            dropConfig={{
              enabled: true,
              defaultItem: { w: TILE.w, h: TILE.h },
              // Only servers dragged from the sidebar (ones already on the grid aren't draggable there).
              onDragOver: (e) => (e.dataTransfer?.types.includes(SERVER_MIME) ? { w: TILE.w, h: TILE.h } : false),
            }}
            onDrop={(_layout, item, e) => {
              const ev = e as DragEvent
              const id = ev.dataTransfer?.getData(SERVER_MIME)
              if (!id) return
              // The grid only reports a position if its placeholder is in the layout it tracks; since
              // this grid is controlled, fall back to the cell under the pointer.
              onDropServer(id, item ? { x: item.x, y: item.y } : cellAt(ev, width))
            }}
            // While something is dragged in from the sidebar the grid holds a placeholder item;
            // writing that layout back (without the placeholder) would erase it before the drop.
            onLayoutChange={(l) => {
              if (!l.some((it) => it.i === DROPPING)) onLayout(l)
            }}
          >
            {shown.map((it) => (
              <div key={it.i} data-tile-id={it.i}>
                {tile(it)}
              </div>
            ))}
          </ReactGridLayout>
        )}
      </div>
    </div>
  )
}
