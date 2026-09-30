import { toast } from "sonner"

import { api, type AccountProvider, type Selections } from "@/lib/api"

/** Run a provider action (e.g. gcloud "sign-in-apps"), with a toast that says what's happening. */
export async function runAccountAction(provider: AccountProvider, actionId: string, args: Record<string, string> = {}) {
  const action = provider.actions.find((a) => a.id === actionId)
  const label = action?.label ?? actionId
  const pending = toast.loading(`${provider.name}: ${label}`, {
    description: action?.interactive ? "Finish in the browser window that opened." : undefined,
  })
  try {
    const r = await api<{ message: string }>("/api/accounts/action", { provider: provider.id, action: actionId, args })
    toast.success(r.message, { id: pending, description: undefined })
  } catch (e) {
    toast.error(`${provider.name}: couldn't ${label.toLowerCase()}`, { id: pending, description: (e as Error).message })
  }
}

/** "gcloud: me@x.com, my-proj · github: me" */
export function describeSelections(selections: Selections, providers?: AccountProvider[] | null): string {
  return Object.entries(selections)
    .map(([id, sel]) => `${providers?.find((p) => p.id === id)?.name ?? id}: ${Object.values(sel).join(", ")}`)
    .join(" · ")
}
