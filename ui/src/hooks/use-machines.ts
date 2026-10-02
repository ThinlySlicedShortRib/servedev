import * as React from "react"
import { toast } from "sonner"

import { api, type Machine, type SetupStep } from "@/lib/api"
import { localMachineName, sortMachines } from "@/lib/machines"

/** Other machines (a hub's remotes), for components deep in the tree. */
export interface MachinesInfo {
  /** Remote machines, by name. Empty without any: the dashboard then looks like it always did. */
  list: Machine[]
  get: (name: string | undefined) => Machine | undefined
  hasRemotes: boolean
  /** What to call this machine: "This Mac". */
  localName: string
}

const EMPTY: MachinesInfo = { list: [], get: () => undefined, hasRemotes: false, localName: localMachineName() }

export const MachinesContext = React.createContext<MachinesInfo>(EMPTY)

export function useMachines(): MachinesInfo {
  return React.useContext(MachinesContext)
}

export function useMachinesInfo(machines: Map<string, Machine>): MachinesInfo {
  return React.useMemo(() => {
    const list = sortMachines(machines.values())
    return { list, get: (name) => (name ? machines.get(name) : undefined), hasRemotes: list.length > 0, localName: EMPTY.localName }
  }, [machines])
}

// ---------------------------------------------------------------------------------------------
// Reconnecting now (Retry): one request that runs the checklist; shared so every Retry button
// for a machine shows it's busy.
// ---------------------------------------------------------------------------------------------

const pending = new Set<string>()
const listeners = new Set<() => void>()
let pendingVersion = 0
const notify = () => {
  pendingVersion++
  listeners.forEach((l) => l())
}

/** True while a Retry for this machine is running. */
export function useRetrying(name: string | undefined): boolean {
  React.useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => pendingVersion
  )
  return !!name && pending.has(name)
}

/** The step that stopped a checklist, for messages. */
export function failedStep(steps: SetupStep[] | undefined): SetupStep | undefined {
  return steps?.find((s) => s.status === "failed")
}

/** Reconnect now instead of waiting for the next retry; says why if it still can't. */
export async function retryMachine(name: string): Promise<boolean> {
  if (pending.has(name)) return false
  pending.add(name)
  notify()
  try {
    const r = await api<{ ok: boolean; steps: SetupStep[] }>("/api/machines/reconnect", { name })
    if (!r.ok) {
      const f = failedStep(r.steps)
      toast.error(`Couldn't reach ${name}`, {
        description: f ? `${f.label}: ${f.detail ?? "failed"}${f.hint ? `. ${f.hint}` : ""}` : "It's still not answering; servedev keeps retrying.",
        duration: 10_000,
      })
    }
    return r.ok
  } catch (e) {
    toast.error(`Couldn't reconnect to ${name}`, { description: (e as Error).message })
    return false
  } finally {
    pending.delete(name)
    notify()
  }
}

// ---------------------------------------------------------------------------------------------
// Which machines are folded in the sidebar (each on its own), kept across reloads.
// ---------------------------------------------------------------------------------------------

const FOLD_KEY = "servedev:machines-folded"
/** Key for this machine; can't collide with a machine name. */
const LOCAL = "\u0000local"
let folded: Record<string, boolean> = loadFolds()
let foldVersion = 0
const foldListeners = new Set<() => void>()

function loadFolds(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(FOLD_KEY) ?? "{}")
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

function setFolds(next: Record<string, boolean>) {
  folded = next
  foldVersion++
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(next))
  } catch {
    // storage unavailable
  }
  foldListeners.forEach((l) => l())
}

/** Show only one machine's servers: fold the others (this machine too) and unfold it. */
export function showOnlyMachine(name: string | undefined, all: string[]) {
  const next: Record<string, boolean> = { [LOCAL]: name !== undefined }
  for (const m of all) next[m] = m !== name
  setFolds(next)
}

export function useMachineFolds() {
  React.useSyncExternalStore(
    (l) => {
      foldListeners.add(l)
      return () => foldListeners.delete(l)
    },
    () => foldVersion
  )
  return {
    /** `name` undefined: this machine. */
    isFolded: (name: string | undefined) => !!folded[name ?? LOCAL],
    toggle: (name: string | undefined) => setFolds({ ...folded, [name ?? LOCAL]: !folded[name ?? LOCAL] }),
  }
}
