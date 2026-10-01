/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

/**
 * The dashboard's visual style, independent of light/dark. The active one is set as
 * `data-style` on <html>, so CSS can scope to it (`[data-style="terminal"] ...`) and Tailwind
 * classes can use the matching variants (`terminal:rounded-none`, `friendly:dark:bg-…`).
 * Components that render something different per style (icons, decorations) use `useStyle()`.
 */
export const STYLES = [
  { id: "classic", label: "Classic", description: "The original look" },
  { id: "studio", label: "Studio", description: "Calm and precise" },
  { id: "terminal", label: "Terminal", description: "Black and green, like a TUI" },
  { id: "friendly", label: "Friendly", description: "Warm and approachable" },
] as const

export type StyleId = (typeof STYLES)[number]["id"]

export const STYLE_STORAGE_KEY = "servedev:style"
const DEFAULT_STYLE: StyleId = "classic"

function isStyle(value: unknown): value is StyleId {
  return STYLES.some((s) => s.id === value)
}

function storedStyle(): StyleId {
  try {
    const v = localStorage.getItem(STYLE_STORAGE_KEY)
    return isStyle(v) ? v : DEFAULT_STYLE
  } catch {
    return DEFAULT_STYLE
  }
}

/** Set before the first paint (index.html does the same inline), so a reload doesn't flash Classic. */
function applyStyle(style: StyleId) {
  const root = document.documentElement
  if (root.dataset.style === style) return
  // Switching styles shouldn't animate every color and radius on the page.
  const freeze = document.createElement("style")
  freeze.textContent = "*,*::before,*::after{transition:none!important}"
  document.head.appendChild(freeze)
  root.dataset.style = style
  window.getComputedStyle(document.body)
  requestAnimationFrame(() => requestAnimationFrame(() => freeze.remove()))
}

type StyleState = { style: StyleId; setStyle: (style: StyleId) => void }

const StyleContext = React.createContext<StyleState | undefined>(undefined)

export function StyleProvider({ children }: { children: React.ReactNode }) {
  const [style, setStyleState] = React.useState<StyleId>(storedStyle)

  const setStyle = React.useCallback((next: StyleId) => {
    try {
      localStorage.setItem(STYLE_STORAGE_KEY, next)
    } catch {
      // private window: the choice lasts until reload
    }
    setStyleState(next)
  }, [])

  React.useLayoutEffect(() => applyStyle(style), [style])

  // Another tab switched styles.
  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STYLE_STORAGE_KEY && isStyle(e.newValue)) setStyleState(e.newValue)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const value = React.useMemo(() => ({ style, setStyle }), [style, setStyle])
  return <StyleContext.Provider value={value}>{children}</StyleContext.Provider>
}

export function useStyle(): StyleState {
  const ctx = React.useContext(StyleContext)
  if (!ctx) throw new Error("useStyle must be used within a StyleProvider")
  return ctx
}

/**
 * The active style id, or "classic" outside a StyleProvider. For presentational code
 * (icons, decorations) that must never throw.
 */
export function useStyleId(): StyleId {
  return React.useContext(StyleContext)?.style ?? DEFAULT_STYLE
}
