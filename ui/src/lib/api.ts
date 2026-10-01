declare const __DEV_TOKEN__: string

export type Status = "starting" | "running" | "stopping" | "stopped" | "exited" | "crashed"

export interface Server {
  id: string
  name: string
  project: string
  root: string
  command: string
  cwd: string
  port?: number
  status: Status
  pid?: number
  exitCode?: number | null
  error?: string
  startedAt?: number
  readyAt?: number
  stoppedAt?: number
  ports: number[]
  url?: string
  logFile: string
  restarts: number
  runId?: number
  pinned?: boolean
  /** Custom hostname, e.g. keel.localhost. */
  hostname?: string
  /** The hostname as a URL through servedev's proxy, e.g. http://keel.localhost. */
  customUrl?: string
  /** Git branch checked out in its project folder. */
  branch?: string
  /** Accounts its current run started with, when a profile picked them. */
  accounts?: { profile: { id: string; name: string }; selections: Selections }
  /** Its profile picked different accounts since it started; a restart applies them. */
  accountsStale?: boolean
  /** How it compares to its repo's servedev.json. */
  config?: "defined" | "differs" | "missing"
  /** Variables set on purpose for it (values masked); the rest comes from the login shell. */
  vars?: { name: string; preview: string; secret: boolean }[]
  /** Where it's defined: the repo's servedev.json, your config.json, or both (your changes on top). */
  source?: { repo: boolean; local: boolean }
}

/** A problem in a config file (servedev keeps using the last version that parsed). */
export interface ConfigIssue {
  level: "error" | "warning"
  file: string
  line?: number
  column?: number
  message: string
}

export interface ConfigSummary {
  /** ~/.servedev/config.json */
  file: string
  issues: ConfigIssue[]
  files: { file: string; kind: "local" | "repo"; exists: boolean; error?: { line: number; column: number; message: string } }[]
}

/** What saving a server into servedev.json would do, from /api/config. */
export interface ConfigPlan {
  server: string
  file: string
  exists: boolean
  state: "defined" | "differs" | "missing"
  entry: Record<string, unknown>
  current?: Record<string, unknown>
  changes: { key: string; before?: unknown; after?: unknown }[]
  omittedSecrets: string[]
  /** Credentials taken out of the command. */
  removed: string[]
  /** Machine-specific paths made portable. */
  rewritten: string[]
  /** May not work on another machine. */
  warnings: string[]
  written?: boolean
}

/** Where to open a server: its custom URL if it has one, else its port. */
export function openUrl(s: Server | undefined): string | undefined {
  if (!s || !["starting", "running"].includes(s.status)) return undefined
  return s.customUrl ?? s.url
}

/** A process group of a server, from /api/processes. */
export interface ProcessGroup {
  pgid: number
  /** "servedev" for the group servedev started, else the program that created it, e.g. "turbo". */
  createdBy: string
  processes: { pid: number; ppid: number; depth: number; command: string; ports: number[] }[]
}

/** A named set of servers, possibly across projects, started together. */
/** Picks by provider id, then field id: { gcloud: { account: "me@x.com" } }. */
export type Selections = Record<string, Record<string, string>>

/**
 * A named set of servers started together. Yours ("local:<name>") live in ~/.servedev/config.json
 * and can mix any servers; shared ones ("<project>:<name>") live in a repo's servedev.json, one per
 * worktree, and everyone on the repo gets them.
 */
export interface Profile {
  id: string
  name: string
  kind: "local" | "shared"
  description?: string
  /** Server ids it starts, in order (skipped and missing ones left out). */
  servers: string[]
  /** Shared: servers you don't start with it (your choice, in your config). */
  skipped: string[]
  /** Every server it lists, skipped ones included, in start order. */
  members: string[]
  /** Listed but not defined (anymore). */
  missing: string[]
  /** What its servers get: the repo's needs with your picks on top. */
  accounts: Selections
  /** Shared: what servedev.json says the servers need. */
  needs?: Selections
  /** Shared: your own picks. */
  mine?: Selections
  project?: string
  root?: string
  branch?: string
  file: string
  /** Shared: servedev.json has changes git hasn't committed. */
  uncommitted?: boolean
  /** Version of its file, so an edit doesn't overwrite a newer one. */
  version: string
  grid: { source: "repo" | "override" | "local" | null; hasRepoDefault: boolean; hasOverride: boolean }
}

export interface AccountOption {
  value: string
  label?: string
  detail?: string
}

export interface AccountField {
  id: string
  label: string
  description?: string
  freeform?: boolean
  /** The machine-wide value can be switched. */
  settable: boolean
  current?: string
  options: AccountOption[]
  error?: string
}

export interface AccountNotice {
  level: "info" | "warning"
  message: string
  fix?: { action: string; label: string; args?: Record<string, string> }
}

/** A platform (Google Cloud, GitHub, or one the user added) and this machine's accounts on it. */
export interface AccountProvider {
  id: string
  name: string
  description?: string
  /** "built in", or the file it was loaded from. */
  source: string
  /** Profiles can pick accounts for their servers. */
  perProfile: boolean
  fields: AccountField[]
  notices: AccountNotice[]
  actions: { id: string; label: string; description: string; interactive?: boolean }[]
  /** Added as a JSON file in the providers folder, so the dashboard can edit and remove it. */
  editable: boolean
  removable: boolean
}

/** A provider written as JSON (see docs/providers.md); what "Add platform" creates. */
export interface ProviderSpec {
  id: string
  name: string
  description?: string
  requires?: string
  homepage?: string
  category?: string
  install?: string
  tested?: boolean
  fields: {
    id: string
    label: string
    description?: string
    freeform?: boolean
    list?: string
    options?: (string | AccountOption)[]
    current?: string
    set?: string
  }[]
  env?: Record<string, string | { command: string }>
  actions?: Record<string, { label: string; description: string; command: string; interactive?: boolean }>
}

export interface CatalogEntry {
  spec: ProviderSpec
  /** Its CLI is on PATH. */
  installed: boolean
  /** A provider with this id exists already. */
  added: boolean
}

/** What a dry run of a spec printed; nothing is saved or switched. */
export interface SpecTest {
  valid: boolean
  error?: string
  requires?: { command: string; found: boolean }
  fields: { id: string; label: string; current?: string; currentError?: string; options?: AccountOption[]; optionsError?: string }[]
  env?: { name: string; preview: string }[]
  envError?: string
  perProfile: boolean
}

/** One start of a server, from /api/runs. */
export interface RunEntry {
  id: number
  current: boolean
  status: Status
  exitCode?: number | null
  startedAt?: number
  stoppedAt?: number
  readyAt?: number
  command: string
  port?: number
  logSize: number
}

/** A server declared in servedev.json that has never been started. */
export interface Configured {
  root: string
  project: string
  name: string
  command: string
  branch?: string
}

export const ACTIVE: Status[] = ["starting", "running", "stopping"]

// The daemon injects the token into index.html; in `vite dev` it comes from ~/.servedev/token.
export const TOKEN =
  __DEV_TOKEN__ ||
  document.querySelector<HTMLMetaElement>('meta[name="servedev-token"]')?.content ||
  ""

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "x-servedev-token": TOKEN, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data as T
}

/** Identifies this tab, so it can ignore change notifications caused by its own saves. */
export const CLIENT_ID = Math.random().toString(36).slice(2)

export function streamUrl(path: string, params: Record<string, string> = {}) {
  return `${path}?${new URLSearchParams({ ...params, token: TOKEN })}`
}

export function ago(ms?: number, now = Date.now()) {
  if (!ms) return ""
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d`
}

export function statusLabel(s: Server) {
  if (s.status === "crashed") return s.exitCode != null ? `crashed (exit ${s.exitCode})` : "crashed"
  if (s.status === "exited") return s.exitCode != null ? `exited (${s.exitCode})` : "exited"
  return s.status
}

export function portOf(s: Server) {
  return s.url ? s.url.split(":").pop() : undefined
}

/** How servedev would install dependencies for a folder, and whether they look current. */
export interface InstallPlan {
  pm: "pnpm" | "yarn" | "bun" | "npm"
  dir: string
  command: string
  reason: string
  state: "missing" | "stale" | "ok" | "unknown"
  detail: string
}

/** Result of /api/inspect: what servedev can tell about a folder before starting a server there. */
export interface Inspection {
  dir: string
  exists: boolean
  root?: string
  project?: string
  detected?: { command: string; kind: string } | null
  install?: InstallPlan
  configured?: { name: string; command: string; status?: Status }[]
  existing?: { name: string; status: Status }[]
  suggestedName?: string
  configError?: string
  /** servedev already tracks this project (its servedev.json servers and profiles show up). */
  tracked?: boolean
  /** Shared profiles in the repo's servedev.json. */
  profiles?: string[]
}

/** A tile in the dashboard grid (server id, grid position and size, and what it shows). */
export interface LayoutItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  mode?: "logs" | "preview"
}

/** A dev server running outside servedev (from /api/external). */
export interface ExternalServer {
  id: string
  pid: number
  pgid: number
  command: string
  cwd: string
  serverCwd?: string
  root: string
  project: string
  ports: number[]
  pids: number[]
  startedAt?: number
  /** Its folder was deleted (e.g. a removed worktree): it can be stopped but not taken over. */
  orphaned?: boolean
  suggestedName: string
  url?: string
  branch?: string
}
