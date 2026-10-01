/**
 * Friendly style's decorations: the logo mark, project avatars and the empty-state spot
 * illustrations. Rendered only when the Friendly style is active (callers check useStyleId()).
 */
import * as React from "react"

import { useStyleId } from "@/components/style-provider"
import { cn } from "@/lib/utils"

/** servedev's mark: a friendly rounded "server" with a little live light and a spark. */
export function FriendlyLogoMark({ className }: { className?: string }) {
  const id = React.useId()
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-7 shrink-0", className)}>
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8a7cf0" />
          <stop offset="1" stopColor="#5546c2" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill={`url(#${id}-g)`} />
      <rect x="7" y="8.5" width="18" height="6.5" rx="3.25" fill="white" fillOpacity="0.95" />
      <rect x="7" y="17" width="18" height="6.5" rx="3.25" fill="white" fillOpacity="0.55" />
      <circle cx="10.6" cy="11.75" r="1.6" fill="#34b368" />
      <rect x="14" y="11" width="7.5" height="1.5" rx="0.75" fill="#5546c2" fillOpacity="0.35" />
      <circle cx="10.6" cy="20.25" r="1.6" fill="#5546c2" fillOpacity="0.45" />
      <path d="M25.5 3.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" fill="#f7cf5c" />
    </svg>
  )
}

function hueOf(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % 360
}

/** A rounded square with the project's initial, colored by a hue derived from its name. */
export function ProjectAvatar({ name, className }: { name: string; className?: string }) {
  const initial = (name.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase()
  return (
    <span
      aria-hidden
      style={{ "--h": hueOf(name) } as React.CSSProperties}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[10.5px] leading-none font-extrabold",
        "bg-[oklch(0.92_0.055_var(--h))] text-[oklch(0.42_0.12_var(--h))] ring-1 ring-[oklch(0.42_0.12_var(--h)/0.12)] ring-inset",
        "dark:bg-[oklch(0.36_0.07_var(--h))] dark:text-[oklch(0.92_0.07_var(--h))] dark:ring-[oklch(0.92_0.07_var(--h)/0.1)]",
        className
      )}
    >
      {initial}
    </span>
  )
}

/** Spot illustration for "No servers yet": a server card waiting to be plugged in. */
export function EmptyServersArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 140" aria-hidden className={cn("h-32 w-auto", className)}>
      <ellipse cx="100" cy="76" rx="84" ry="58" className="fill-accent" />
      <g className="friendly-float">
        <rect x="52" y="36" width="96" height="62" rx="16" className="fill-card stroke-border" strokeWidth="2" />
        <rect x="64" y="50" width="72" height="14" rx="7" className="fill-muted" />
        <rect x="64" y="70" width="72" height="14" rx="7" className="fill-muted" />
        <circle cx="72" cy="57" r="3.5" className="fill-status-running" />
        <circle cx="72" cy="77" r="3.5" className="fill-none stroke-status-stopped" strokeWidth="1.6" strokeDasharray="2.5 2" />
        <rect x="82" y="55" width="30" height="4" rx="2" className="fill-muted-foreground/30" />
        <rect x="82" y="75" width="22" height="4" rx="2" className="fill-muted-foreground/20" />
      </g>
      <g transform="rotate(-6 146 104)">
        <path d="M124 90a5 5 0 0 1 5-5h11l5 5h17a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5h-33a5 5 0 0 1-5-5z" className="fill-primary" />
        <path d="M124 99h43v18a5 5 0 0 1-5 5h-33a5 5 0 0 1-5-5z" className="fill-[color-mix(in_oklch,var(--primary),white_18%)]" />
        <path d="M140 110.5l3 3 6-6.5" fill="none" className="stroke-primary-foreground" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <path d="M150 28l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" className="fill-status-starting" />
      <path d="M44 46l1.4 3.6 3.6 1.4-3.6 1.4-1.4 3.6-1.4-3.6-3.6-1.4 3.6-1.4z" className="fill-primary/70" />
      <circle cx="40" cy="104" r="3" className="fill-status-running/60" />
    </svg>
  )
}

/** Spot illustration for an empty custom grid: tiles, one waiting to be filled. */
export function EmptyGridArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 140" aria-hidden className={cn("h-32 w-auto", className)}>
      <ellipse cx="100" cy="74" rx="86" ry="58" className="fill-accent" />
      <rect x="44" y="30" width="54" height="40" rx="10" className="fill-card stroke-border" strokeWidth="2" />
      <circle cx="55" cy="41" r="3" className="fill-status-running" />
      <rect x="62" y="39" width="26" height="4" rx="2" className="fill-muted-foreground/30" />
      <rect x="52" y="50" width="38" height="3" rx="1.5" className="fill-muted-foreground/15" />
      <rect x="52" y="57" width="30" height="3" rx="1.5" className="fill-muted-foreground/15" />
      <rect x="104" y="30" width="54" height="40" rx="10" className="fill-card stroke-border" strokeWidth="2" />
      <rect x="111" y="38" width="6" height="6" rx="1.5" className="fill-status-stopped" />
      <rect x="122" y="39" width="26" height="4" rx="2" className="fill-muted-foreground/30" />
      <rect x="112" y="50" width="36" height="3" rx="1.5" className="fill-muted-foreground/15" />
      <rect x="44" y="76" width="114" height="40" rx="10" className="fill-primary/5 stroke-primary/50" strokeWidth="2" strokeDasharray="6 5" />
      <g className="friendly-float">
        <circle cx="101" cy="96" r="10" className="fill-primary" />
        <path d="M101 91v10M96 96h10" className="stroke-primary-foreground" strokeWidth="2.4" strokeLinecap="round" />
      </g>
      <path d="M164 22l1.6 4 4 1.6-4 1.6-1.6 4-1.6-4-4-1.6 4-1.6z" className="fill-status-starting" />
    </svg>
  )
}

/** The logo mark as a favicon, swapped in while Friendly is active. */
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8a7cf0"/><stop offset="1" stop-color="#5546c2"/></linearGradient></defs><rect x="1" y="1" width="30" height="30" rx="9" fill="url(#g)"/><rect x="7" y="8.5" width="18" height="6.5" rx="3.25" fill="#fff" fill-opacity=".95"/><rect x="7" y="17" width="18" height="6.5" rx="3.25" fill="#fff" fill-opacity=".55"/><circle cx="10.6" cy="11.75" r="1.6" fill="#34b368"/><circle cx="10.6" cy="20.25" r="1.6" fill="#5546c2" fill-opacity=".45"/><path d="M25.5 3.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" fill="#f7cf5c"/></svg>`
  )

/** App-level Friendly decorations (the favicon). Mount once. */
export function FriendlyDecor() {
  const friendly = useStyleId() === "friendly"
  React.useEffect(() => {
    if (!friendly) return
    const link = document.createElement("link")
    link.rel = "icon"
    link.type = "image/svg+xml"
    link.href = FAVICON
    document.head.appendChild(link)
    return () => link.remove()
  }, [friendly])
  return null
}
