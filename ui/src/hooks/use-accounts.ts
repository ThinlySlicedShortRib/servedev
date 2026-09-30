import * as React from "react"

import { api, type AccountOption, type AccountProvider, type Selections } from "@/lib/api"

interface AccountsState {
  providers: AccountProvider[] | null
  errors: { file: string; message: string }[]
  /** Added providers whose CLI isn't installed. */
  hidden: { id: string; name: string; source: string; removable: boolean }[]
  dir: string
  loading: boolean
  refresh: (hard?: boolean) => Promise<void>
}

/**
 * This machine's platform accounts. Refetches when the daemon says they changed and when the tab
 * regains focus (someone may have run `gcloud config set account` in a terminal).
 */
export function useAccounts(version: number): AccountsState {
  const [state, setState] = React.useState<Omit<AccountsState, "refresh" | "loading">>({ providers: null, hidden: [], errors: [], dir: "" })
  const [loading, setLoading] = React.useState(false)

  // Only a hard refresh (the Reload button) shows a spinner; background refetches are silent.
  const refresh = React.useCallback(async (hard = false) => {
    if (hard) setLoading(true)
    try {
      setState(await api(`/api/accounts${hard ? "?refresh=1" : ""}`))
    } catch {
      // keep what we had; the daemon banner covers a lost connection
    } finally {
      if (hard) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    api<typeof state>("/api/accounts")
      .then((r) => !cancelled && setState(r))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [version])

  React.useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [refresh])

  return { ...state, loading, refresh }
}

/** A field's options for a selection of the other fields (projects depend on the account). */
export function useFieldOptions(provider: string, field: string, selection: Selections[string], initial: AccountOption[], enabled = true) {
  const [options, setOptions] = React.useState(initial)
  const key = JSON.stringify(selection)
  React.useEffect(() => {
    if (!enabled) return
    let cancelled = false
    api<{ options: AccountOption[] }>(`/api/accounts/options?${new URLSearchParams({ provider, field, selection: key })}`)
      .then((r) => !cancelled && setOptions(r.options))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [provider, field, key, enabled])
  return options
}

/** The profile the dashboard is showing; starts from the dashboard use its accounts. */
export const ActiveProfileContext = React.createContext<{ id: string; servers: string[] } | undefined>(undefined)

/** Profile to start a server with: the one on screen when it's a member, else the daemon decides. */
export function useStartProfile(serverId: string | undefined): string | undefined {
  const p = React.useContext(ActiveProfileContext)
  return p && serverId && p.servers.includes(serverId) ? p.id : undefined
}

export const AccountsContext = React.createContext<AccountsState | null>(null)

export function useAccountsContext() {
  const ctx = React.useContext(AccountsContext)
  if (!ctx) throw new Error("useAccountsContext outside AccountsContext")
  return ctx
}
