import * as React from "react"

import { CLIENT_ID, api, type LayoutItem, type Profile } from "@/lib/api"

export const TILE = { w: 6, h: 9, minW: 3, minH: 4 }

/** Reading order (top to bottom, left to right) is also a profile's start order. */
export function readingOrder(items: LayoutItem[]): string[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x).map((it) => it.i)
}

/** Keep saved tiles for `ids`, then place missing ones two to a row at the bottom. */
export function mergeLayout(saved: LayoutItem[], ids: string[]): LayoutItem[] {
  const byId = new Map(saved.map((it) => [it.i, it]))
  const kept = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
  const fresh = ids.filter((id) => !byId.has(id))
  const bottom = kept.reduce((y, it) => Math.max(y, it.y + it.h), 0)
  return [...kept, ...fresh.map((id, k) => ({ i: id, x: (k % 2) * TILE.w, y: bottom + Math.floor(k / 2) * TILE.h, w: TILE.w, h: TILE.h }))]
}

const key = (items: LayoutItem[]) => JSON.stringify(items.map(({ i, x, y, w, h, mode }) => [i, x, y, w, h, mode ?? "logs"]))

/**
 * The custom grid's tiles. Without a profile it's the unsaved "draft" grid; with one of yours,
 * tiles are the profile's servers and changes save to it (membership and start order included).
 * A shared profile's grid is your own layout of it (reset goes back to the repo's).
 */
export function useCustomGrid(profile: Profile | undefined, externalChange?: { scope: string; at: number } | null) {
  const scope = profile ? `profile:${profile.id}` : "draft"
  const [items, setItems] = React.useState<LayoutItem[] | null>(null)
  /**
   * Bumped whenever the layout is replaced wholesale (loaded, or changed elsewhere). The grid
   * component remounts on it: react-grid-layout keeps its own copy of positions and would otherwise
   * report the old ones back, undoing the change.
   */
  const [version, setVersion] = React.useState(0)
  // Someone else (an agent, the CLI, another tab) changed this grid: reload it.
  const reloadKey = externalChange?.scope === scope ? externalChange.at : 0
  const saved = React.useRef("")
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const members = profile?.servers.join(",")
  // Latest profile for async callbacks, and the membership the grid last reflected.
  const profileRef = React.useRef(profile)
  React.useLayoutEffect(() => {
    profileRef.current = profile
  }, [profile])
  const lastMembers = React.useRef<string[]>(profile?.servers ?? [])

  // A different scope starts empty until its layout loads; an outside change reloads in place.
  const loadKey = `${scope}|${reloadKey}`
  const [loading, setLoading] = React.useState(loadKey)
  if (loading !== loadKey) {
    setLoading(loadKey)
    if (!reloadKey) setItems(null)
  }

  React.useEffect(() => {
    let cancelled = false
    api<{ items: LayoutItem[] | null }>(`/api/layouts?${new URLSearchParams({ scope })}`)
      .catch(() => ({ items: null }))
      .then((r) => {
        if (cancelled) return
        // Tiles used to have a preview mode; previews now live in Single view.
        const base = (r.items ?? []).map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
        // Keep every saved tile: the saved layout may be newer than the profile this tab has seen
        // (an agent's set_grid saves the layout, then the profile). Add members without a tile.
        const current = profileRef.current
        const next = current ? mergeLayout(base, [...new Set([...base.map((it) => it.i), ...current.servers])]) : base
        lastMembers.current = current?.servers ?? []
        setVersion((v) => v + 1)
        saved.current = key(next)
        setItems(next)
      })
    return () => {
      cancelled = true
    }
    // The profile's membership is merged below; only the scope (or an outside change) reloads.
  }, [scope, reloadKey])

  // The profile was edited elsewhere (profile dialog, CLI, an agent): apply what changed, so a
  // layout that already reflects the change isn't undone by a stale member list.
  React.useEffect(() => {
    if (!profile) return
    const before = new Set(lastMembers.current)
    const after = new Set(profile.servers)
    lastMembers.current = profile.servers
    setItems((cur) => {
      if (!cur) return cur
      const kept = cur.filter((it) => after.has(it.i) || !before.has(it.i))
      const missing = profile.servers.filter((id) => !before.has(id) && !kept.some((it) => it.i === id))
      return missing.length || kept.length !== cur.length ? mergeLayout(kept, [...kept.map((it) => it.i), ...missing]) : cur
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members])

  const persist = React.useCallback(
    (next: LayoutItem[]) => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        const k = key(next)
        if (k === saved.current) return
        saved.current = k
        void api("/api/layouts", { scope, items: next, source: CLIENT_ID }).catch(() => {})
        const order = readingOrder(next)
        // Your profiles follow their grid (servers and start order). A shared one's servers are the
        // team's, in servedev.json; its grid is just your layout.
        if (profile?.kind === "local" && order.join(",") !== profile.servers.join(",")) {
          void api("/api/profiles/update", { id: profile.id, servers: order }).catch(() => {})
        }
      }, 400)
    },
    [scope, profile]
  )

  const update = React.useCallback(
    (fn: (cur: LayoutItem[]) => LayoutItem[]) =>
      setItems((cur) => {
        const next = fn(cur ?? [])
        persist(next)
        return next
      }),
    [persist]
  )

  return {
    scope,
    items,
    version,
    ids: React.useMemo(() => new Set((items ?? []).map((it) => it.i)), [items]),
    /** Add a tile, at a dropped position or at the bottom. */
    add: (id: string, at?: { x: number; y: number }) =>
      update((cur) => {
        if (cur.some((it) => it.i === id)) return cur
        if (at) return [...cur, { i: id, x: at.x, y: at.y, w: TILE.w, h: TILE.h }]
        return mergeLayout(cur, [...cur.map((it) => it.i), id])
      }),
    remove: (id: string) => update((cur) => cur.filter((it) => it.i !== id)),
    /**
     * Positions after a drag, resize, or compaction by the grid. Only moves tiles: the grid's
     * report can lag behind a tile that was just added (e.g. right after a drop), so it must not
     * decide which tiles exist.
     */
    applyLayout: (layout: readonly { i: string; x: number; y: number; w: number; h: number }[]) =>
      update((cur) => {
        const pos = new Map(layout.map((l) => [l.i, l]))
        return cur.map((it) => {
          const l = pos.get(it.i)
          return l ? { ...it, x: l.x, y: l.y, w: l.w, h: l.h } : it
        })
      }),
    clear: () => update(() => []),
  }
}
