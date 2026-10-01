/**
 * Purely decorative pieces of the Terminal style: the pixel logo, the CRT overlay,
 * the power-on flicker, the once-per-session boot sequence and the favicon. None of
 * them take clicks or focus, and all are hidden from assistive tech. Each renders
 * only while Terminal is the active style.
 */
import * as React from "react"

import { toPath } from "@/components/icons-terminal"
import { useStyleId } from "@/components/style-provider"
import { cn } from "@/lib/utils"

/** ">_" cut out of a lit 8x8 block. */
const LOGO = toPath([
  "########",
  "#.######",
  "##.#####",
  "###.####",
  "##.#####",
  "#.######",
  "####...#",
  "########",
])

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 8 8" shapeRendering="crispEdges" className={cn("pixel-logo shrink-0 text-primary", className)}>
      <path d={LOGO} fill="currentColor" />
    </svg>
  )
}

/** Scanlines and a vignette, dark mode only (see index.css). */
function CrtOverlay() {
  return <div aria-hidden className="crt-overlay" />
}

/** A brief flicker; mount it when the connection comes up and it plays once. */
export function CrtPower() {
  if (useStyleId() !== "terminal") return null
  return <div aria-hidden className="crt-power" />
}

const BOOT_KEY = "servedev:booted"
const BOOT_LINES = [
  "servedev ~ dashboard",
  "[  OK  ] tty0: 80x24 phosphor console",
  "[  OK  ] attaching to servedev daemon",
  "[  OK  ] tailing logs",
]

/** First Terminal load in a session: a few lines type out, then fade. Skipped under reduced motion. */
function BootScreen() {
  const [show] = React.useState(() => {
    try {
      if (sessionStorage.getItem(BOOT_KEY)) return false
      return !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    } catch {
      return false
    }
  })
  React.useEffect(() => {
    try {
      sessionStorage.setItem(BOOT_KEY, "1")
    } catch {
      // storage unavailable
    }
  }, [])
  if (!show) return null
  return (
    <div aria-hidden className="boot-screen font-mono">
      {BOOT_LINES.map((line, i) => (
        <div key={i} style={{ animationDelay: `${i * 110}ms` }} className={i === 0 ? "phosphor-glow font-bold" : undefined}>
          {line.startsWith("[  OK  ]") ? (
            <>
              [<span className="text-success">  OK  </span>]{line.slice(8)}
            </>
          ) : (
            line
          )}
        </div>
      ))}
      <div style={{ animationDelay: `${BOOT_LINES.length * 110}ms` }}>
        $ <span className="term-cursor" />
      </div>
    </div>
  )
}

/** ">_" favicon, swapped in while Terminal is active. */
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges"><rect width="8" height="8" fill="#000"/><path fill="#33ff66" d="${LOGO}"/></svg>`
  )

function Favicon() {
  React.useEffect(() => {
    const link = document.createElement("link")
    link.rel = "icon"
    link.type = "image/svg+xml"
    link.href = FAVICON
    document.head.appendChild(link)
    return () => link.remove()
  }, [])
  return null
}

/** App-level Terminal decorations: CRT overlay, boot sequence and favicon. Mount once. */
export function TerminalDecor() {
  if (useStyleId() !== "terminal") return null
  return (
    <>
      <CrtOverlay />
      <BootScreen />
      <Favicon />
    </>
  )
}
