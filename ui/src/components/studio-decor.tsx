/**
 * Studio style's decorations: the logo mark and the line-art empty-state illustrations.
 * Rendered only when the Studio style is active (callers check useStyleId()).
 */
import * as React from "react"

import { useStyleId } from "@/components/style-provider"
import { cn } from "@/lib/utils"

/**
 * The servedev mark: two stacked server units in an accent tile, the top one "live".
 * Purely decorative; the wordmark next to it carries the name.
 */
export function StudioLogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-5 shrink-0", className)}>
      <rect width="24" height="24" rx="6" className="fill-primary" />
      <rect x="1" y="1" width="22" height="22" rx="5" fill="none" stroke="white" strokeOpacity="0.14" />
      <rect x="5.5" y="6" width="13" height="5" rx="1.5" className="fill-primary-foreground" />
      <rect x="5.5" y="13" width="13" height="5" rx="1.5" className="fill-primary-foreground" fillOpacity="0.45" />
      <circle cx="8.25" cy="8.5" r="1.1" className="fill-primary" />
      <rect x="11" y="7.9" width="5" height="1.2" rx="0.6" className="fill-primary" fillOpacity="0.35" />
    </svg>
  )
}

/*
 * Small line-art illustrations for empty states. They draw with currentColor (muted) and pick out
 * one detail in the accent, so they sit quietly in both themes.
 */

const base = "shrink-0 text-muted-foreground/70"

/** A grid with one tile being dropped in. */
export function GridIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 80" fill="none" aria-hidden className={cn(base, "h-20 w-30", className)}>
      <rect x="4.5" y="4.5" width="52" height="32" rx="5" stroke="currentColor" strokeOpacity="0.55" />
      <rect x="63.5" y="4.5" width="52" height="32" rx="5" stroke="currentColor" strokeOpacity="0.55" />
      <rect x="4.5" y="43.5" width="52" height="32" rx="5" stroke="currentColor" strokeOpacity="0.55" />
      <path d="M11 13h18M11 19h28M11 25h14" stroke="currentColor" strokeOpacity="0.4" strokeLinecap="round" />
      <path d="M70 13h22M70 19h14M70 25h26" stroke="currentColor" strokeOpacity="0.4" strokeLinecap="round" />
      <path d="M11 52h24M11 58h16M11 64h30" stroke="currentColor" strokeOpacity="0.4" strokeLinecap="round" />
      <rect x="63.5" y="43.5" width="52" height="32" rx="5" className="stroke-primary" strokeDasharray="3 3" />
      <path d="M89.5 53.5v12M83.5 59.5h12" className="stroke-primary" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** A short rack of servers, the top one live. */
export function ServersIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 80" fill="none" aria-hidden className={cn(base, "h-20 w-24", className)}>
      <rect x="12.5" y="8.5" width="71" height="18" rx="4.5" stroke="currentColor" strokeOpacity="0.6" />
      <rect x="12.5" y="31.5" width="71" height="18" rx="4.5" stroke="currentColor" strokeOpacity="0.45" />
      <rect x="12.5" y="54.5" width="71" height="18" rx="4.5" stroke="currentColor" strokeOpacity="0.3" strokeDasharray="3 3" />
      <circle cx="22" cy="17.5" r="2.5" className="fill-primary" />
      <circle cx="22" cy="40.5" r="2.5" stroke="currentColor" strokeOpacity="0.45" />
      <path d="M31 17.5h22M31 40.5h16" stroke="currentColor" strokeOpacity="0.45" strokeLinecap="round" />
      <path d="M48 59.5v8M44 63.5h8" stroke="currentColor" strokeOpacity="0.5" strokeLinecap="round" />
    </svg>
  )
}

/** A magnifier over an empty list. */
export function NoMatchIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 48" fill="none" aria-hidden className={cn(base, "h-12 w-16", className)}>
      <path d="M6 9h26M6 17h18M6 25h22M6 33h12" stroke="currentColor" strokeOpacity="0.35" strokeLinecap="round" />
      <circle cx="42" cy="24" r="9.5" stroke="currentColor" strokeOpacity="0.7" />
      <path d="m49 31 7 7" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M38.5 24h7" className="stroke-primary" strokeLinecap="round" />
    </svg>
  )
}

/** The logo mark as a favicon, swapped in while Studio is active. */
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#465ec6"/><rect x="5.5" y="6" width="13" height="5" rx="1.5" fill="#fff"/><rect x="5.5" y="13" width="13" height="5" rx="1.5" fill="#fff" fill-opacity=".45"/><circle cx="8.25" cy="8.5" r="1.1" fill="#465ec6"/></svg>`
  )

/** App-level Studio decorations (the favicon). Mount once. */
export function StudioDecor() {
  const studio = useStyleId() === "studio"
  React.useEffect(() => {
    if (!studio) return
    const link = document.createElement("link")
    link.rel = "icon"
    link.type = "image/svg+xml"
    link.href = FAVICON
    document.head.appendChild(link)
    return () => link.remove()
  }, [studio])
  return null
}
