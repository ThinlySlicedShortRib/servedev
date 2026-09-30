/**
 * Operations shared by the CLI and the MCP server. Each returns agent-friendly text
 * plus structured data; neither writes to stdout.
 */
import { api } from "./client";
import type { ProcessGroup, RunInfo, SearchResponse, StartResponse } from "./daemon";
import type { Preset } from "./logs";
import type { PublicServer, ReadyResult } from "./manager";
import { describeInstall } from "./install";
import { findRoot, loadConfig, type ReadySpec } from "./project";

export interface OpResult {
  ok: boolean;
  text: string;
  data?: unknown;
  /** Process exit code for the CLI. */
  code?: number;
}

export interface StartArgs {
  cwd: string;
  name?: string;
  command?: string;
  setup?: string;
  install?: boolean;
  hostname?: string;
  dir?: string;
  port?: number | "auto";
  ready?: ReadySpec;
  timeout?: number;
  wait?: boolean;
  restart?: boolean;
  env?: Record<string, string>;
  /** Profile whose accounts to use; "none" for this machine's. */
  profile?: string;
}

const SYMBOL: Record<string, string> = {
  running: "●",
  starting: "◌",
  stopping: "◌",
  stopped: "■",
  exited: "○",
  crashed: "✗",
  idle: "·",
};

export function ago(ms?: number): string {
  if (!ms) return "-";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

/** "current run" or "run #12, 3h ago, crashed (exit 1)" */
export function describeRun(r: RunInfo): string {
  const end = r.status === "crashed" || r.status === "exited" ? `${r.status} (exit ${r.exitCode ?? "?"})` : r.status;
  if (r.current) return `current run${r.id ? ` #${r.id}` : ""}, ${end}`;
  return `run #${r.id}, started ${ago(r.startedAt)} ago, ${end}`;
}

function where(s: PublicServer) {
  if (s.customUrl) return ` at ${s.customUrl}${s.url ? ` (→ ${s.url.replace("http://", "")})` : ""}`;
  return s.url ? ` at ${s.url}` : "";
}

function describeStart(r: StartResponse, label: string): OpResult {
  const s = r.server;
  const tail = r.logTail ? `\n\nLast log lines:\n${indent(r.logTail)}` : "";
  let detected = r.detected ? `\n(command detected from ${r.detected})` : "";
  if (r.install) detected += `\n(ran ${describeInstall(r.install)} first; ${r.install.detail.replace(/\.$/, "")})`;
  if (s.accounts) detected += `\n(accounts from profile ${s.accounts.profile.name}: ${describeSelections(s.accounts.selections)})`;
  if (r.accountsNote) detected += `\nnote: ${r.accountsNote}`;
  else if (r.installHint) detected += `\nnote: ${r.installHint.detail} If it fails with missing modules, restart with --install to run ${describeInstall(r.installHint)}.`;
  if (r.alreadyRunning && r.ready?.ok !== false) {
    return {
      ok: true,
      text: `✓ ${s.name} was already running${where(s)} (id ${s.id}, pid ${s.pid}, up ${ago(s.startedAt)}). Use restart to restart it.`,
      data: r,
    };
  }
  if (!r.ready) {
    return { ok: true, text: `◌ ${s.name} ${label} (id ${s.id}, pid ${s.pid}): ${s.command}${detected}`, data: r };
  }
  if (r.ready.ok) {
    const took = s.readyAt && s.startedAt ? ` in ${((s.readyAt - s.startedAt) / 1000).toFixed(1)}s` : "";
    let note = "";
    if (s.port && s.ports.length && !s.ports.includes(s.port)) {
      note = `\nnote: PORT=${s.port} was set but it listens on ${s.ports.join(", ")}`;
    } else if (!s.ports.length && s.ready.mode !== "none") {
      note = "\nnote: no listening TCP port detected in its process group";
    }
    return { ok: true, text: `✓ ${s.name} is ready${where(s)}${took} (id ${s.id}, pid ${s.pid})${note}${detected}`, data: r };
  }
  if (r.ready.timedOut) {
    return {
      ok: false,
      code: 2,
      text:
        `⚠ ${s.name} is still starting: ${r.ready.reason} (id ${s.id}, pid ${s.pid}). ` +
        `It is left running. If it never listens on a port, restart it with --ready-log <regex> or --ready none.${tail}`,
      data: r,
    };
  }
  return { ok: false, code: 1, text: `✗ ${s.name} failed: ${r.ready.reason}.${detected}${tail}`, data: r };
}

function indent(text: string) {
  return text
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}

export async function opStart(a: StartArgs): Promise<OpResult> {
  const r = await api<StartResponse>("/api/start", {
    root: findRoot(a.cwd),
    clientCwd: a.cwd,
    name: a.name,
    command: a.command,
    setup: a.setup,
    install: a.install,
    hostname: a.hostname,
    cwd: a.dir,
    port: a.port,
    ready: a.ready,
    timeout: a.timeout,
    wait: a.wait,
    restart: a.restart,
    vars: a.env,
    profile: a.profile === "none" ? null : a.profile,
  });
  return describeStart(r, "is starting");
}

export async function opRestart(a: { cwd: string; name?: string; wait?: boolean; timeout?: number; profile?: string }): Promise<OpResult> {
  const r = await api<StartResponse>("/api/restart", {
    root: findRoot(a.cwd),
    name: a.name,
    wait: a.wait,
    timeout: a.timeout,
    profile: a.profile === "none" ? null : a.profile,
  });
  return describeStart(r, "is restarting");
}

/** Start every server in servedev.json (or the named ones), respecting dependsOn. */
export async function opUp(a: { cwd: string; names?: string[]; timeout?: number }): Promise<OpResult> {
  const root = findRoot(a.cwd);
  const servers = loadConfig(root).servers ?? {};
  if (!Object.keys(servers).length) return opStart({ cwd: a.cwd, timeout: a.timeout });
  const order: string[] = [];
  const visit = (n: string, stack: string[]) => {
    if (order.includes(n)) return;
    if (stack.includes(n)) throw new Error(`dependency cycle: ${[...stack, n].join(" -> ")}`);
    if (!servers[n]) throw new Error(`"${n}" is not defined in servedev.json (have: ${Object.keys(servers).join(", ")})`);
    for (const d of servers[n].dependsOn ?? []) visit(d, [...stack, n]);
    order.push(n);
  };
  for (const n of a.names?.length ? a.names : Object.keys(servers)) visit(n, []);
  const lines: string[] = [];
  const data: unknown[] = [];
  for (const name of order) {
    const r = await opStart({ cwd: a.cwd, name, timeout: a.timeout });
    lines.push(r.text);
    data.push(r.data);
    if (!r.ok) return { ok: false, code: r.code, text: lines.join("\n") + `\nstopped bringing servers up at "${name}".`, data };
  }
  return { ok: true, text: lines.join("\n"), data };
}

export async function opStop(a: { cwd: string; names: string[]; all?: boolean }): Promise<OpResult> {
  const root = findRoot(a.cwd);
  let names = a.names;
  if (a.all) {
    const { servers } = await api<{ servers: PublicServer[] }>("/api/servers");
    names = servers.filter((s) => s.root === root && ["starting", "running"].includes(s.status)).map((s) => s.name);
    if (!names.length) return { ok: true, text: "nothing running in this project." };
  }
  if (!names.length) names = [""];
  const lines: string[] = [];
  const data: PublicServer[] = [];
  for (const name of names) {
    const { server } = await api<{ server: PublicServer }>("/api/stop", { root, name: name || undefined });
    lines.push(`■ ${server.name} stopped (id ${server.id})`);
    data.push(server);
  }
  return { ok: true, text: lines.join("\n"), data };
}

/** Forget every server in a project folder (stopping running ones). Files on disk are untouched. */
export async function opRemoveProject(a: { cwd: string; project?: string; path?: string }): Promise<OpResult> {
  const body = a.project ? { project: a.project } : { root: findRoot(a.path ? (a.path.startsWith("/") ? a.path : `${a.cwd}/${a.path}`) : a.cwd) };
  const r = await api<{ removed: string[]; root: string }>("/api/projects/remove", body);
  return {
    ok: true,
    text: `Removed ${r.removed.length} server${r.removed.length === 1 ? "" : "s"} in ${r.root} from servedev: ${r.removed.join(", ")}. Nothing on disk was deleted.`,
    data: r,
  };
}

export async function opRemove(a: { cwd: string; name: string }): Promise<OpResult> {
  const r = await api<{ removed: string }>("/api/remove", { root: findRoot(a.cwd), name: a.name });
  return { ok: true, text: `removed ${r.removed}`, data: r };
}

export async function opWait(a: { cwd: string; name?: string; timeout?: number }): Promise<OpResult> {
  const r = await api<{ server: PublicServer; ready: ReadyResult; logTail?: string }>("/api/wait", {
    root: findRoot(a.cwd),
    name: a.name,
    timeout: a.timeout,
  });
  return describeStart({ ...r, alreadyRunning: false }, "");
}

export async function opList(a: { cwd: string; all?: boolean }): Promise<OpResult> {
  const root = findRoot(a.cwd);
  const { servers, configured } = await api<{ servers: PublicServer[]; configured: { root: string; name: string; command: string; project: string }[] }>(
    "/api/servers",
  );
  const mine = a.all ? servers : servers.filter((s) => s.root === root);
  const idle = configured.filter((c) => a.all || c.root === root);
  const others = servers.filter((s) => s.root !== root && ["starting", "running"].includes(s.status));
  const rows: string[][] = [["", a.all ? "ID" : "NAME", "STATUS", "URL", "BRANCH", "PID", "UPTIME", "COMMAND"]];
  for (const s of mine) {
    const active = ["starting", "running", "stopping"].includes(s.status);
    const status =
      s.status + (s.exitCode != null && !active && s.status !== "stopped" ? ` (${s.exitCode})` : "") + (s.accountsStale ? " (accounts changed)" : "");
    rows.push([SYMBOL[s.status] ?? " ", (a.all ? s.id : s.name) + (s.pinned ? " (pinned)" : ""), status, (active && (s.customUrl ?? s.url)) || "-", s.branch ?? "-", active ? String(s.pid) : "-", active ? ago(s.startedAt) : "-", s.command]);
  }
  for (const c of idle) rows.push([SYMBOL.idle, a.all ? `${c.project}:${c.name}` : c.name, "not started", "-", "-", "-", "-", c.command]);
  let text = rows.length === 1 ? (a.all ? "no servers." : "no servers in this project.") : table(rows);
  if (!a.all && others.length) text += `\n(${others.length} more running in other projects; use --all)`;
  const stale = mine.filter((s) => s.accountsStale);
  if (stale.length) text += `\n(accounts changed: their profile picked other accounts since they started; restart ${stale.map((s) => (a.all ? s.id : s.name)).join(", ")} to apply)`;
  // Servers someone started outside servedev: shown so an agent knows why a port is taken.
  const outside = (await listOutside().catch(() => [])).filter((x) => a.all || x.root === root);
  if (outside.length) {
    text +=
      `\n\nRunning outside servedev (can't see their logs; take_over_server or the dashboard can take them over):\n` +
      table([
        ["ID", "PROJECT", "PORTS", "UP", "COMMAND"],
        ...outside.map((x) => [x.id + (x.orphaned ? " (folder deleted)" : ""), x.project, x.ports.join(","), x.startedAt ? ago(x.startedAt) : "-", x.command.slice(0, 70)]),
      ]);
  }
  return { ok: true, text, data: { servers: mine, configured: idle, outside } };
}

export async function opStatus(a: { cwd: string; name?: string }): Promise<OpResult> {
  const q = new URLSearchParams({ root: findRoot(a.cwd), ...(a.name ? { name: a.name } : {}) });
  const r = await api<{ server: PublicServer; lines: string[] }>(`/api/logs?${q}&tail=15`);
  const [{ runs }, { groups }] = await Promise.all([
    api<{ runs: (RunInfo & { id: number })[] }>(`/api/runs?${q}&limit=6`),
    api<{ groups: ProcessGroup[] }>(`/api/processes?${q}`),
  ]);
  const procCount = groups.reduce((n, g) => n + g.processes.length, 0);
  const s = r.server;
  const active = ["starting", "running", "stopping"].includes(s.status);
  const text = [
    `${SYMBOL[s.status]} ${s.id}: ${s.status}${s.exitCode != null && !active ? ` (exit code ${s.exitCode})` : ""}`,
    `  url:      ${s.url ?? "-"}`,
    ...(s.hostname ? [`  hostname: ${s.customUrl ?? `${s.hostname} (proxy not running)`}${s.url ? ` → ${s.url.replace("http://", "")}` : " (server not running)"}`] : []),
    `  ports:    ${s.ports.join(", ") || "-"}${s.port ? ` (assigned PORT=${s.port})` : ""}`,
    `  pid:      ${active ? s.pid : "-"}`,
    `  uptime:   ${active ? ago(s.startedAt) : `stopped ${ago(s.stoppedAt)} ago`}`,
    ...(s.setup ? [`  setup:    ${s.setup}`] : []),
    `  command:  ${s.command}`,
    `  cwd:      ${s.cwd}`,
    ...(s.branch ? [`  branch:   ${s.branch}`] : []),
    ...(s.vars?.length ? [`  env:      ${s.vars.map((v) => `${v.name}=${v.preview}`).join(" ")} (set on purpose; the rest comes from your login shell)`] : []),
    `  config:   ${s.config === "defined" ? "defined in servedev.json" : s.config === "differs" ? "differs from servedev.json (servedev save --force to update it)" : "not in servedev.json (servedev save to add it)"}`,
    ...(s.accounts
      ? [`  accounts: ${describeSelections(s.accounts.selections)} (from profile ${s.accounts.profile.name}${s.accountsStale ? "; the profile changed since, restart to apply" : ""})`]
      : []),
    `  log file: ${s.logFile}`,
    ...(s.error ? [`  error:    ${s.error}`] : []),
    ...(groups.length
      ? [
          "",
          `Processes: ${procCount} in ${groups.length} process group${groups.length === 1 ? "" : "s"} (stop and restart signal all of them):`,
          ...groups.flatMap((g) => [
            `  group ${g.pgid}, ${g.createdBy === "servedev" ? "started by servedev" : `created by ${g.createdBy}`}`,
            ...g.processes.map(
              (p) => `    ${"  ".repeat(p.depth)}${p.pid} ${p.command.length > 100 ? p.command.slice(0, 100) + "…" : p.command}${p.ports.length ? `  [listening on ${p.ports.join(", ")}]` : ""}`,
            ),
          ]),
        ]
      : []),
    ...(runs.length > 1
      ? ["", "Earlier runs (read with: servedev logs " + s.name + " --run <id>):", ...runs.filter((x) => !x.current).map((x) => `  ${describeRun(x)}`)]
      : []),
    "",
    "Recent logs:",
    indent(r.lines.join("\n") || "(empty)"),
  ].join("\n");
  return { ok: true, text, data: r };
}

export async function opLogs(a: {
  cwd: string;
  name?: string;
  tail?: number | "all";
  grep?: string;
  since?: string;
  prev?: boolean;
  run?: number;
}): Promise<OpResult> {
  const params = new URLSearchParams({ root: findRoot(a.cwd) });
  if (a.name) params.set("name", a.name);
  if (a.tail !== undefined) params.set("tail", String(a.tail));
  if (a.grep) params.set("grep", a.grep);
  if (a.since) params.set("since", a.since);
  if (a.prev) params.set("prev", "1");
  if (a.run) params.set("run", String(a.run));
  const r = await api<{ server: PublicServer; run: RunInfo; purged: boolean; lines: string[]; total: number; truncated: boolean }>(`/api/logs?${params}`);
  let text = r.lines.join("\n");
  if (!text) text = r.purged ? "(log deleted by retention)" : a.grep ? `(no lines matching /${a.grep}/)` : "(no output)";
  if (!r.run.current) text = `[${r.server.id}, ${describeRun(r.run)}]\n` + text;
  const shown = r.lines.length;
  if (r.total > shown) text = `[showing last ${shown} of ${r.total} ${a.grep ? "matching " : ""}lines${r.truncated ? ", output capped" : ""}]\n` + text;
  return { ok: true, text, data: r };
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows
    .map((r) =>
      r
        .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i])))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export interface SearchArgs {
  cwd: string;
  query?: string;
  preset?: Preset;
  servers?: string[];
  all?: boolean;
  since?: string;
  context?: number;
  limit?: number;
  runs?: "current" | "previous" | "both" | "all";
}

/** Log search across servers, formatted like grep -n -C: "120:" matches, "121-" context. */
export async function opSearch(a: SearchArgs): Promise<OpResult> {
  const r = await api<SearchResponse>("/api/search", {
    root: findRoot(a.cwd),
    all: a.all,
    servers: a.servers,
    query: a.query,
    preset: a.preset,
    since: a.since,
    context: a.context,
    limit: a.limit,
    runs: a.runs,
  });
  const runsLabel = { both: "current and previous runs", previous: "previous runs", all: "all kept runs", current: "current runs" }[a.runs ?? "current"];
  const window = a.since ? ` in the last ${a.since}` : "";
  if (!r.results.length) {
    return {
      ok: true,
      text: `No matches for ${r.pattern} in ${r.searched} log${r.searched === 1 ? "" : "s"} (${runsLabel}${window}).`,
      data: r,
    };
  }
  const total = r.results.reduce((n, x) => n + x.total, 0);
  const out: string[] = [
    `${total} match${total === 1 ? "" : "es"} for ${r.pattern} in ${r.results.length} of ${r.searched} log${r.searched === 1 ? "" : "s"} (${runsLabel}${window}).`,
  ];
  const MAX_CHARS = 20_000;
  let chars = out[0].length;
  let capped = false;
  for (const x of r.results) {
    const shown = x.blocks.reduce((n, b) => n + b.lines.filter((l) => l.match).length, 0);
    const status = describeRun(x.run);
    const header = `\n== ${x.id} (${status}): ${x.total} match${x.total === 1 ? "" : "es"}${shown < x.total ? `, showing last ${shown}` : ""} ==`;
    const body = x.blocks.map((b) => b.lines.map((l) => `${l.n}${l.match ? ":" : "-"}${l.text}`).join("\n")).join("\n--\n");
    if (chars + header.length + body.length > MAX_CHARS) {
      capped = true;
      out.push(`${header}\n(omitted: output limit reached)`);
      continue;
    }
    chars += header.length + body.length;
    out.push(header, body);
  }
  if (capped) out.push("\nOutput was capped. Narrow it with servers, since, or a lower limit.");
  return { ok: true, text: out.join("\n"), data: r };
}

export async function opRuns(a: { cwd: string; name?: string; limit?: number }): Promise<OpResult> {
  const q = new URLSearchParams({ root: findRoot(a.cwd), ...(a.name ? { name: a.name } : {}), limit: String(a.limit ?? 20) });
  const r = await api<{
    server: PublicServer;
    retentionDays: number;
    runs: (RunInfo & { id: number; command: string; port?: number; readyAt?: number; logSize: number })[];
  }>(`/api/runs?${q}`);
  const rows = [["RUN", "STARTED", "ENDED", "READY IN", "PORT", "LOG"]];
  for (const x of r.runs) {
    const ended = x.current && !x.stoppedAt ? x.status : `${x.status}${x.exitCode != null && x.status !== "stopped" ? ` (${x.exitCode})` : ""} ${ago(x.stoppedAt)} ago`;
    rows.push([
      `#${x.id}${x.current ? " *" : ""}`,
      x.startedAt ? `${ago(x.startedAt)} ago` : "-",
      ended,
      x.readyAt && x.startedAt ? `${((x.readyAt - x.startedAt) / 1000).toFixed(1)}s` : "-",
      x.port ? String(x.port) : "-",
      x.logSize ? `${Math.max(1, Math.round(x.logSize / 1024))} KB` : "deleted",
    ]);
  }
  const text =
    `${r.server.id}: ${r.runs.length} run${r.runs.length === 1 ? "" : "s"} (* current). Logs are kept ${r.retentionDays} days after a run stops.\n` +
    table(rows) +
    `\nRead one with: servedev logs ${r.server.name} --run <id>`;
  return { ok: true, text, data: r };
}

export async function opConfig(a: { key?: string; value?: string }): Promise<OpResult> {
  const r = a.value === undefined
    ? await api<{ settings: Record<string, { value: string; default: string; describe: string }> }>("/api/settings")
    : await api<{ settings: Record<string, { value: string; default: string; describe: string }> }>("/api/settings", { key: a.key, value: a.value });
  const entries = Object.entries(r.settings).filter(([k]) => !a.key || k === a.key);
  if (a.key && !entries.length) throw new Error(`unknown setting "${a.key}" (have: ${Object.keys(r.settings).join(", ")})`);
  const text = entries.map(([k, v]) => `${k} = ${v.value}${v.value === v.default ? " (default)" : ""}\n  ${v.describe}`).join("\n");
  return { ok: true, text, data: r.settings };
}

interface AutostartInfo {
  supported: boolean;
  installed: boolean;
  file: string;
}

export async function opPin(a: { cwd: string; name?: string; pinned: boolean }): Promise<OpResult> {
  const r = await api<{ server: PublicServer; autostart: AutostartInfo }>("/api/pin", { root: findRoot(a.cwd), name: a.name, pinned: a.pinned });
  let text = a.pinned
    ? `pinned ${r.server.id}; it starts automatically when you log in.`
    : `unpinned ${r.server.id}; it no longer starts at login.`;
  if (a.pinned && !r.autostart.supported) text = `pinned ${r.server.id}. Starting at login is only supported on macOS.`;
  return { ok: true, text, data: r };
}

export async function opAutostart(enable?: boolean): Promise<OpResult> {
  const r = enable === undefined ? await api<AutostartInfo>("/api/autostart") : await api<AutostartInfo>("/api/autostart", { enabled: enable });
  const text = !r.supported
    ? "Starting at login is only supported on macOS."
    : r.installed
      ? `On: the daemon starts at login and brings up pinned servers.\n  ${r.file}`
      : "Off: the daemon starts on first use; pinned servers don't start at login.";
  return { ok: true, text, data: r };
}

interface ProfileInfo {
  id: number;
  name: string;
  servers: string[];
  accounts: Record<string, Record<string, string>>;
}

/** "gcloud account=me@x.com project=p; github user=me" */
export function describeSelections(selections: Record<string, Record<string, string>>): string {
  return (
    Object.entries(selections)
      .map(([provider, sel]) => `${provider} ${Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(" ")}`)
      .join("; ") || "this machine's"
  );
}

export async function opProfiles(): Promise<OpResult> {
  const [{ profiles }, { servers }] = await Promise.all([
    api<{ profiles: ProfileInfo[] }>("/api/profiles"),
    api<{ servers: PublicServer[] }>("/api/servers"),
  ]);
  if (!profiles.length) return { ok: true, text: "No profiles yet. Create one with: servedev profile create <name> --running", data: profiles };
  const byId = new Map(servers.map((s) => [s.id, s]));
  const lines = profiles.map((p) => {
    const running = p.servers.filter((id) => ["running", "starting"].includes(byId.get(id)?.status ?? "")).length;
    const members = p.servers.map((id) => `${SYMBOL[byId.get(id)?.status ?? "stopped"] ?? " "} ${id}`).join("\n    ");
    const accounts = Object.keys(p.accounts ?? {}).length ? `\n    accounts: ${describeSelections(p.accounts)}` : "";
    return `${p.name} (${running}/${p.servers.length} running)${accounts}\n    ${members || "(no servers)"}`;
  });
  return { ok: true, text: lines.join("\n"), data: profiles };
}

export async function opProfile(a: {
  cwd: string;
  action: "create" | "add" | "remove" | "rename" | "delete" | "start" | "set" | "accounts";
  name: string;
  servers?: string[];
  running?: boolean;
  rename?: string;
  /** Account picks by provider; a provider set to null goes back to this machine's accounts. */
  accounts?: Record<string, Record<string, string> | null>;
}): Promise<OpResult> {
  const root = findRoot(a.cwd);
  switch (a.action) {
    case "accounts": {
      const { profile } = await api<{ profile: ProfileInfo }>("/api/profiles/update", { profile: a.name, mergeAccounts: a.accounts ?? {} });
      return {
        ok: true,
        text:
          `${profile.name} servers use: ${describeSelections(profile.accounts)}.\n` +
          `Applies when they next start; running ones show as needing a restart.`,
        data: profile,
      };
    }
    case "create": {
      const { profile } = await api<{ profile: ProfileInfo }>("/api/profiles", {
        root,
        name: a.name,
        servers: a.servers,
        running: a.running,
        accounts: a.accounts ?? undefined,
      });
      return { ok: true, text: `created profile ${profile.name} with ${profile.servers.length} server${profile.servers.length === 1 ? "" : "s"}: ${profile.servers.join(", ") || "none"}`, data: profile };
    }
    case "set": {
      const { profile } = await api<{ profile: ProfileInfo }>("/api/profiles/update", { root, profile: a.name, servers: a.servers ?? [] });
      return { ok: true, text: `${profile.name}: ${profile.servers.join(", ") || "no servers"} (start order)`, data: profile };
    }
    case "add":
    case "remove":
    case "rename": {
      const { profile } = await api<{ profile: ProfileInfo }>("/api/profiles/update", {
        root,
        profile: a.name,
        [a.action]: a.action === "rename" ? a.rename : a.servers,
      });
      return { ok: true, text: `${profile.name}: ${profile.servers.join(", ") || "no servers"}`, data: profile };
    }
    case "delete": {
      const r = await api<{ deleted: string }>("/api/profiles/delete", { profile: a.name });
      return { ok: true, text: `deleted profile ${r.deleted} (its servers are untouched)`, data: r };
    }
    case "start": {
      const r = await api<{ profile: ProfileInfo; results: { id: string; ok: boolean; alreadyRunning?: boolean; url?: string; reason?: string }[] }>(
        "/api/profiles/start",
        { profile: a.name },
      );
      const lines = r.results.map((x) =>
        x.alreadyRunning ? `✓ ${x.id} already running${x.url ? ` at ${x.url}` : ""}` : x.ok ? `✓ ${x.id} ready${x.url ? ` at ${x.url}` : ""}` : `✗ ${x.id}: ${x.reason}`,
      );
      const failed = r.results.filter((x) => !x.ok).length;
      return {
        ok: failed === 0,
        text: lines.length
          ? `${r.profile.name}:\n${lines.join("\n")}${failed ? `\n${failed} failed; see servedev logs <name>.` : ""}`
          : `${r.profile.name} has no servers yet. Add some with: servedev profile add "${r.profile.name}" <servers...>`,
        data: r,
      };
    }
  }
}

export async function opHostname(a: { cwd: string; name?: string; hostname?: string; clear?: boolean }): Promise<OpResult> {
  if (!a.name) {
    const r = await api<{ running: boolean; port?: number; error?: string; hostnames: { hostname: string; id: string; url?: string }[] }>("/api/proxy");
    if (!r.hostnames.length) return { ok: true, text: "No servers have a hostname. Set one with: servedev hostname <server> keel.localhost", data: r };
    const state = r.running ? `proxy on port ${r.port}` : `proxy not running${r.error ? `: ${r.error}` : ""}`;
    return { ok: true, text: `${state}\n` + table([["HOSTNAME", "SERVER", "URL"], ...r.hostnames.map((h) => [h.hostname, h.id, h.url ?? "-"])]), data: r };
  }
  if (!a.hostname && !a.clear) throw new Error("usage: servedev hostname <server> <hostname>  (or --clear)");
  const r = await api<{ server: PublicServer; proxy: { running: boolean; port?: number; error?: string }; note?: string }>("/api/hostname", {
    root: findRoot(a.cwd),
    name: a.name,
    hostname: a.clear ? null : a.hostname,
  });
  const s = r.server;
  let text = !s.hostname
    ? `${s.id} no longer has a hostname.`
    : `${s.id} is now ${s.customUrl ?? s.hostname}${s.url ? ` (→ ${s.url.replace("http://", "")})` : ""}.`;
  if (s.hostname && !r.proxy.running) text += `\nThe hostname proxy isn't running: ${r.proxy.error ?? "unknown error"}`;
  else if (s.hostname && r.proxy.port !== 80) {
    text += r.proxy.error
      ? `\nPort 80 was unavailable (${r.proxy.error}), so the proxy uses port ${r.proxy.port}.`
      : `\nThe proxy uses port ${r.proxy.port} (the proxy_port setting).`;
  }
  if (r.note) text += `\nnote: ${r.note}`;
  return { ok: true, text, data: r };
}

// ---------- shared helpers for the agent tools ----------

interface ServerRow extends PublicServer {}

/** Server names within the cwd's project, full ids ("project:name"), or globally unique names -> ids. */
async function resolveServerIds(cwd: string, refs: string[]): Promise<string[]> {
  const { servers } = await api<{ servers: ServerRow[] }>("/api/servers");
  const root = findRoot(cwd);
  return refs.map((ref) => {
    if (servers.some((s) => s.id === ref)) return ref;
    const local = servers.find((s) => s.root === root && s.name === ref);
    if (local) return local.id;
    const global = servers.filter((s) => s.name === ref);
    if (global.length === 1) return global[0].id;
    throw new Error(
      global.length
        ? `"${ref}" matches several servers (${global.map((s) => s.id).join(", ")}); use the full id`
        : `no server "${ref}". Known: ${servers.map((s) => s.id).join(", ") || "none"}`,
    );
  });
}

async function findProfile(name: string): Promise<ProfileInfo> {
  const { profiles } = await api<{ profiles: ProfileInfo[] }>("/api/profiles");
  const p = profiles.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) throw new Error(`no profile "${name}" (have: ${profiles.map((x) => x.name).join(", ") || "none"})`);
  return p;
}

// ---------- bulk ----------

export async function opBulk(a: { cwd: string; action: "start" | "stop"; profile?: string; servers?: string[]; all?: boolean }): Promise<OpResult> {
  let ids: string[];
  let scope: string;
  if (a.profile) {
    const p = await findProfile(a.profile);
    ids = p.servers;
    scope = `profile ${p.name}`;
  } else if (a.servers?.length) {
    ids = await resolveServerIds(a.cwd, a.servers);
    scope = `${ids.length} named server${ids.length === 1 ? "" : "s"}`;
  } else if (a.all) {
    ids = (await api<{ servers: ServerRow[] }>("/api/servers")).servers.map((s) => s.id);
    scope = "every tracked server";
  } else {
    throw new Error("say which servers: a profile, a list of servers, or all: true for every tracked server");
  }
  const { servers } = await api<{ servers: ServerRow[] }>("/api/servers");
  const byId = new Map(servers.map((s) => [s.id, s]));
  const active = (id: string) => ["running", "starting"].includes(byId.get(id)?.status ?? "");
  const targets = ids.filter((id) => (a.action === "stop" ? active(id) : !active(id)));
  if (!targets.length) return { ok: true, text: `Nothing to ${a.action} in ${scope}.`, data: { ids: [] } };
  if (a.action === "stop") {
    await api("/api/servers/stop", { ids: targets });
    return { ok: true, text: `Stopped ${targets.length} (${scope}): ${targets.join(", ")}`, data: { ids: targets } };
  }
  const r = await api<{ results: { id: string; ok: boolean; url?: string; reason?: string }[] }>("/api/servers/start", { ids: targets });
  const lines = r.results.map((x) => (x.ok ? `✓ ${x.id}${x.url ? ` at ${x.url}` : ""}` : `✗ ${x.id}: ${x.reason}`));
  return { ok: r.results.every((x) => x.ok), text: `Started ${scope}, in order:\n${lines.join("\n")}`, data: r };
}

// ---------- folders ----------

export async function opInspect(a: { cwd: string; path?: string }): Promise<OpResult> {
  const dir = a.path ? (a.path.startsWith("/") || a.path.startsWith("~") ? a.path : `${a.cwd}/${a.path}`) : a.cwd;
  const r = await api<any>(`/api/inspect?${new URLSearchParams({ dir })}`);
  if (!r.exists) return { ok: false, text: `No folder at ${r.dir}.`, data: r };
  const lines = [
    `${r.dir} belongs to project ${r.project}${r.root !== r.dir ? ` (root ${r.root})` : ""}.`,
    r.detected ? `Detected command: ${r.detected.command} (from the ${r.detected.kind})` : "No dev script detected; pass a command to start_server.",
    r.install ? `Dependencies: ${r.install.detail} Install would run ${r.install.command.split(" --")[0]} in ${r.install.dir} (${r.install.reason}).` : "",
    r.configured?.length ? `Defined in servedev.json: ${r.configured.map((c: any) => `${c.name} (${c.command})`).join(", ")}` : "",
    r.existing?.length ? `Already known here: ${r.existing.map((e: any) => `${e.name} (${e.status})`).join(", ")}` : "",
    `Suggested name: ${r.suggestedName}`,
  ].filter(Boolean);
  return { ok: true, text: lines.join("\n"), data: r };
}

// ---------- grid ----------

const GRID_COLS = 12;
const TILE_H = 9;

interface GridTile {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

async function gridScope(profile?: string): Promise<{ scope: string; profile?: ProfileInfo }> {
  if (!profile) return { scope: "draft" };
  const p = await findProfile(profile);
  return { scope: `profile:${p.id}`, profile: p };
}

const readingOrder = (items: GridTile[]) => [...items].sort((a, b) => a.y - b.y || a.x - b.x).map((t) => t.i);

/** Save tiles; for a profile's grid also make its servers (and start order) match the tiles. */
async function saveGrid(scope: string, profile: ProfileInfo | undefined, items: GridTile[]) {
  await api("/api/layouts", { scope, items });
  if (profile) await api("/api/profiles/update", { id: profile.id, servers: readingOrder(items) });
}

function describeGrid(label: string, items: GridTile[], statuses: Map<string, string>): string {
  if (!items.length) return `${label} is empty.`;
  const rows = [...items].sort((a, b) => a.y - b.y || a.x - b.x).map((t) => `  ${t.i} (${statuses.get(t.i) ?? "unknown"}): x=${t.x} y=${t.y} w=${t.w} h=${t.h}`);
  return `${label}, ${items.length} tile${items.length === 1 ? "" : "s"} on a ${GRID_COLS}-column grid (reading order = start order):\n${rows.join("\n")}`;
}

export async function opGetGrid(a: { profile?: string }): Promise<OpResult> {
  const { scope, profile } = await gridScope(a.profile);
  const [{ items }, { servers }] = await Promise.all([
    api<{ items: GridTile[] | null }>(`/api/layouts?${new URLSearchParams({ scope })}`),
    api<{ servers: ServerRow[] }>("/api/servers"),
  ]);
  const statuses = new Map(servers.map((s) => [s.id, s.status]));
  const label = profile ? `Grid of profile ${profile.name}` : "The unsaved grid";
  return { ok: true, text: describeGrid(label, items ?? [], statuses), data: { scope, items: items ?? [] } };
}

export async function opSetGrid(a: {
  cwd: string;
  profile?: string;
  servers?: string[];
  columns?: number;
  height?: number;
  tiles?: { server: string; x: number; y: number; w: number; h: number }[];
}): Promise<OpResult> {
  const { scope, profile } = await gridScope(a.profile);
  let items: GridTile[];
  if (a.tiles?.length) {
    const ids = await resolveServerIds(a.cwd, a.tiles.map((t) => t.server));
    items = a.tiles.map((t, k) => {
      if (![t.x, t.y, t.w, t.h].every((n) => Number.isInteger(n) && n >= 0) || t.w < 1 || t.h < 1 || t.x + t.w > GRID_COLS) {
        throw new Error(`tile for ${t.server}: x, y, w, h must be whole numbers with x + w <= ${GRID_COLS}`);
      }
      return { i: ids[k], x: t.x, y: t.y, w: t.w, h: t.h };
    });
  } else {
    const ids = await resolveServerIds(a.cwd, a.servers ?? []);
    const cols = Math.min(a.columns ?? Math.min(2, Math.max(ids.length, 1)), 4);
    if (![1, 2, 3, 4].includes(cols)) throw new Error("columns must be 1 to 4");
    const w = GRID_COLS / cols;
    const h = a.height ?? TILE_H;
    items = ids.map((id, k) => ({ i: id, x: (k % cols) * w, y: Math.floor(k / cols) * h, w, h }));
  }
  if (new Set(items.map((t) => t.i)).size !== items.length) throw new Error("each server can only be on the grid once");
  await saveGrid(scope, profile, items);
  return opGetGrid({ profile: a.profile });
}

export async function opUpdateGrid(a: {
  cwd: string;
  profile?: string;
  add?: string[];
  remove?: string[];
  move?: { server: string; x?: number; y?: number; w?: number; h?: number }[];
}): Promise<OpResult> {
  const { scope, profile } = await gridScope(a.profile);
  const { items: current } = await api<{ items: GridTile[] | null }>(`/api/layouts?${new URLSearchParams({ scope })}`);
  let items = (current ?? []).map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
  if (a.remove?.length) {
    const drop = new Set(await resolveServerIds(a.cwd, a.remove));
    items = items.filter((t) => !drop.has(t.i));
  }
  if (a.move?.length) {
    const ids = await resolveServerIds(a.cwd, a.move.map((m) => m.server));
    a.move.forEach((m, k) => {
      const t = items.find((x) => x.i === ids[k]);
      if (!t) throw new Error(`${ids[k]} isn't on this grid`);
      Object.assign(t, Object.fromEntries(Object.entries({ x: m.x, y: m.y, w: m.w, h: m.h }).filter(([, v]) => v !== undefined)));
      if (t.x + t.w > GRID_COLS) throw new Error(`${t.i}: x + w must be <= ${GRID_COLS}`);
    });
  }
  if (a.add?.length) {
    const ids = (await resolveServerIds(a.cwd, a.add)).filter((id) => !items.some((t) => t.i === id));
    const bottom = items.reduce((y, t) => Math.max(y, t.y + t.h), 0);
    ids.forEach((id, k) => items.push({ i: id, x: (k % 2) * 6, y: bottom + Math.floor(k / 2) * TILE_H, w: 6, h: TILE_H }));
  }
  await saveGrid(scope, profile, items);
  return opGetGrid({ profile: a.profile });
}

export async function opSaveGridAsProfile(a: { name: string }): Promise<OpResult> {
  const { items } = await api<{ items: GridTile[] | null }>("/api/layouts?scope=draft");
  if (!items?.length) throw new Error("the unsaved grid is empty; add servers with set_grid or update_grid first");
  const { profile } = await api<{ profile: ProfileInfo }>("/api/profiles", { name: a.name, layout: items });
  await api("/api/layouts", { scope: "draft", items: [] });
  return { ok: true, text: `Saved the grid as profile ${profile.name}: ${profile.servers.join(", ")}`, data: profile };
}

// ---------- servers running outside servedev ----------

interface OutsideServer {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  root: string;
  project: string;
  ports: number[];
  orphaned?: boolean;
  suggestedName: string;
  url?: string;
  startedAt?: number;
}

export async function listOutside(): Promise<OutsideServer[]> {
  return (await api<{ servers: OutsideServer[] }>("/api/external")).servers;
}

async function findOutside(ref: { id?: string; port?: number }): Promise<OutsideServer> {
  const all = await listOutside();
  const hit = ref.id ? all.find((x) => x.id === ref.id) : all.find((x) => ref.port !== undefined && x.ports.includes(ref.port));
  if (!hit) {
    throw new Error(
      `no server running outside servedev matches ${ref.id ?? `port ${ref.port}`}. Outside servers: ${all.map((x) => `${x.id} (:${x.ports.join(",")})`).join(", ") || "none"}`,
    );
  }
  return hit;
}

export async function opTakeOver(a: { id?: string; port?: number; name?: string; command?: string }): Promise<OpResult> {
  const x = await findOutside(a);
  if (x.orphaned) throw new Error(`${x.id} runs from ${x.cwd}, which was deleted; it can only be stopped (stop_outside_server)`);
  const r = await api<StartResponse>("/api/external/takeover", { id: x.id, name: a.name, command: a.command });
  const res = describeStart(r, "was taken over");
  return { ...res, text: `Took over ${x.id} (${x.command}).\n${res.text}` };
}

/** Stop dev servers still running from deleted folders (e.g. removed worktrees). */
export async function opStopHung(a: { ids?: string[] } = {}): Promise<OpResult> {
  const r = await api<{ stopped: OutsideServer[] }>("/api/external/stop-hung", a.ids ? { ids: a.ids } : {});
  if (!r.stopped.length) return { ok: true, text: "No hung servers: nothing is running from a deleted folder.", data: r };
  const lines = r.stopped.map((x) => `  ${x.project} / ${x.suggestedName} (:${x.ports.join(", :")}, pid ${x.pid})`);
  return { ok: true, text: `Stopped ${r.stopped.length} hung server${r.stopped.length === 1 ? "" : "s"} running from deleted folders:\n${lines.join("\n")}`, data: r };
}

export async function opStopOutside(a: { id?: string; port?: number }): Promise<OpResult> {
  const x = await findOutside(a);
  await api("/api/external/stop", { id: x.id });
  return { ok: true, text: `Stopped ${x.suggestedName} from ${x.project} (pid ${x.pid}, :${x.ports.join(", :")}).`, data: x };
}

// ---------- platform accounts ----------

interface FieldState {
  id: string;
  label: string;
  settable: boolean;
  freeform?: boolean;
  current?: string;
  options: { value: string; label?: string; detail?: string }[];
  error?: string;
}

interface ProviderState {
  id: string;
  name: string;
  description?: string;
  source: string;
  perProfile: boolean;
  fields: FieldState[];
  notices: { level: string; message: string; fix?: { action: string; label: string; args?: Record<string, string> } }[];
  actions: { id: string; label: string; description: string; interactive?: boolean }[];
}

function describeProvider(p: ProviderState): string {
  const lines = [`${p.name} (${p.id})${p.source === "built in" ? "" : ` from ${p.source}`}`];
  for (const f of p.fields) {
    const opts = f.options.map((o) => (o.value === f.current ? `*${o.value}` : o.value) + (o.detail ? ` (${o.detail})` : ""));
    lines.push(`  ${f.id}: ${f.current ?? "(not set)"}${f.settable ? "" : " [per profile only]"}`);
    if (opts.length > 1 || (opts.length === 1 && f.options[0].value !== f.current)) lines.push(`    options: ${opts.join(", ")}${f.freeform ? ", or any value" : ""}`);
    if (f.error) lines.push(`    error: ${f.error}`);
  }
  for (const n of p.notices) {
    lines.push(`  ${n.level === "warning" ? "⚠" : "i"} ${n.message}${n.fix ? ` Fix: servedev account action ${p.id} ${n.fix.action}${Object.entries(n.fix.args ?? {}).map(([k, v]) => ` ${k}=${v}`).join("")}` : ""}`);
  }
  if (p.actions.length) lines.push(`  actions: ${p.actions.map((a) => a.id).join(", ")}`);
  if (!p.perProfile) lines.push("  (profiles can't pick accounts for this one: it sets no environment variables)");
  return lines.join("\n");
}

export async function opAccounts(a: { provider?: string; refresh?: boolean } = {}): Promise<OpResult> {
  const r = await api<{ providers: ProviderState[]; errors: { file: string; message: string }[]; dir: string }>(`/api/accounts${a.refresh ? "?refresh=1" : ""}`);
  const providers = r.providers.filter((p) => !a.provider || p.id === a.provider);
  if (a.provider && !providers.length) throw new Error(`no available account provider "${a.provider}" (have: ${r.providers.map((p) => p.id).join(", ")})`);
  let text = providers.map(describeProvider).join("\n\n") || "No account providers available (none of their CLIs are installed).";
  if (r.errors.length) text += `\n\nProviders that failed to load:\n${r.errors.map((e) => `  ${e.file}: ${e.message}`).join("\n")}`;
  if (!a.provider) text += `\n\nThese are this machine's accounts. Profiles can pick others for their servers: servedev profile accounts <profile> gcloud.account=<email>.\nAdd platforms in ${r.dir} (see docs/providers.md).`;
  return { ok: true, text, data: r };
}

/** Switch machine-wide values: values maps field id to value. */
export async function opAccountUse(a: { provider: string; values: Record<string, string> }): Promise<OpResult> {
  if (!Object.keys(a.values).length) throw new Error("nothing to switch; pass field=value (e.g. account=me@example.com)");
  let state: ProviderState | undefined;
  for (const [field, value] of Object.entries(a.values)) {
    state = (await api<{ provider: ProviderState }>("/api/accounts/set", { provider: a.provider, field, value })).provider;
  }
  return {
    ok: true,
    text: `${describeProvider(state!)}\n\nServers read some credentials only when they start; restart the ones that use ${state!.name} if they should pick this up.`,
    data: state,
  };
}

export async function opAccountAction(a: { provider: string; action: string; args?: Record<string, string> }): Promise<OpResult> {
  const r = await api<{ message: string; provider: ProviderState }>("/api/accounts/action", { provider: a.provider, action: a.action, args: a.args ?? {} });
  return { ok: true, text: r.message, data: r };
}

// ---------- adding platforms ----------

interface CatalogEntry {
  spec: { id: string; name: string; description?: string; requires?: string; category?: string; install?: string; homepage?: string; tested?: boolean };
  installed: boolean;
  added: boolean;
}

export async function opAccountCatalog(): Promise<OpResult> {
  const r = await api<{ entries: CatalogEntry[]; dir: string }>("/api/accounts/catalog");
  const groups = new Map<string, CatalogEntry[]>();
  for (const e of r.entries) {
    const c = e.spec.category ?? "Other";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(e);
  }
  const lines: string[] = [];
  for (const [category, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(category);
    for (const e of entries.sort((a, b) => a.spec.name.localeCompare(b.spec.name))) {
      const state = e.added ? "added" : e.installed ? "CLI installed" : `needs ${e.spec.requires ?? "its CLI"}${e.spec.install ? ` (${e.spec.install})` : ""}`;
      lines.push(`  ${e.spec.id.padEnd(14)} ${e.spec.name} — ${state}${e.spec.tested === false ? " [untested]" : ""}`);
    }
  }
  const text = r.entries.length
    ? `${lines.join("\n")}\n\nAdd one: servedev account add <id>. Or write your own: servedev account add --file my-platform.json (see docs/providers.md).`
    : "The catalog is empty. Write your own provider: servedev account add --file my-platform.json (see docs/providers.md).";
  return { ok: true, text, data: r };
}

export async function opAccountAdd(a: { catalog?: string; spec?: unknown; replace?: boolean; override?: boolean }): Promise<OpResult> {
  const r = await api<{ spec: { id: string; name: string; requires?: string; install?: string }; file: string; replaced: boolean; installed: boolean }>(
    "/api/accounts/providers",
    { catalog: a.catalog, spec: a.spec, replace: a.replace, override: a.override },
  );
  let text = `${r.replaced ? "Updated" : "Added"} ${r.spec.name} (${r.spec.id}): ${r.file}`;
  text += r.installed
    ? `\nSee it with: servedev account ${r.spec.id}`
    : `\nIt shows up once ${r.spec.requires ?? "its CLI"} is installed${r.spec.install ? `: ${r.spec.install}` : ""}.`;
  return { ok: true, text, data: r };
}

export async function opAccountRemove(id: string): Promise<OpResult> {
  const r = await api<{ removed: string; file: string; restoredBuiltIn: boolean; clearedFrom: string[] }>("/api/accounts/providers/delete", { id });
  let text = `Removed ${r.removed} (deleted ${r.file}).`;
  if (r.restoredBuiltIn) text += ` The built-in ${r.removed} provider is back in use.`;
  if (r.clearedFrom.length) text += `\nCleared its account picks from profile${r.clearedFrom.length === 1 ? "" : "s"}: ${r.clearedFrom.join(", ")}.`;
  return { ok: true, text, data: r };
}

interface SpecTestResult {
  valid: boolean;
  error?: string;
  requires?: { command: string; found: boolean };
  fields: { id: string; label: string; current?: string; currentError?: string; options?: { value: string; label?: string }[]; optionsError?: string }[];
  env?: { name: string; preview: string }[];
  envError?: string;
  perProfile: boolean;
}

export async function opAccountTest(a: { spec: unknown; selection?: Record<string, string> }): Promise<OpResult> {
  const r = await api<SpecTestResult>("/api/accounts/test", { spec: a.spec, selection: a.selection ?? {} });
  if (!r.valid) return { ok: false, code: 1, text: `✗ Not a valid provider: ${r.error}`, data: r };
  const lines = ["✓ Valid provider (nothing was saved or switched)"];
  if (r.requires) lines.push(r.requires.found ? `✓ ${r.requires.command} is installed` : `✗ ${r.requires.command} isn't on PATH, so the provider stays hidden and nothing else ran`);
  for (const f of r.fields) {
    lines.push(`${f.label} (${f.id})`);
    lines.push(f.currentError ? `  ✗ current: ${f.currentError}` : `  current: ${f.current ?? "(nothing printed)"}`);
    if (f.optionsError) lines.push(`  ✗ list: ${f.optionsError}`);
    else if (f.options) lines.push(`  options (${f.options.length}): ${f.options.slice(0, 10).map((o) => o.value).join(", ")}${f.options.length > 10 ? ", …" : ""}`);
  }
  if (r.envError) lines.push(`✗ env: ${r.envError}`);
  else if (r.env) lines.push(`env for a profile's servers: ${r.env.map((e) => `${e.name}=${e.preview}`).join(", ") || "(none with these values)"}`);
  else if (!r.perProfile && r.requires?.found !== false) lines.push("No env: profiles can't pick accounts for it (switching machine-wide only).");
  const failed = !!r.requires && !r.requires.found || r.fields.some((f) => f.currentError || f.optionsError) || !!r.envError;
  return { ok: !failed, code: failed ? 1 : 0, text: lines.join("\n"), data: r };
}

// ---------- servedev.json ----------

interface ConfigPlanInfo {
  server: string;
  file: string;
  exists: boolean;
  state: "defined" | "differs" | "missing";
  entry: Record<string, unknown>;
  changes: { key: string; before?: unknown; after?: unknown }[];
  omittedSecrets: string[];
  removed: string[];
  rewritten: string[];
  warnings: string[];
  written?: boolean;
}

const show = (v: unknown) => (v === undefined ? "(none)" : JSON.stringify(v));

/** Write a server into its repo's servedev.json, so it travels with the code. */
export async function opSave(a: { cwd: string; name?: string; force?: boolean; includeSecrets?: boolean; dryRun?: boolean }): Promise<OpResult> {
  const root = findRoot(a.cwd);
  const { servers } = await api<{ servers: PublicServer[] }>("/api/servers");
  const mine = servers.filter((s) => s.root === root);
  const target = a.name
    ? servers.find((s) => s.id === a.name) ?? mine.find((s) => s.name === a.name)
    : mine.length === 1
      ? mine[0]
      : undefined;
  if (!target) {
    throw new Error(
      a.name ? `no server "${a.name}" in ${root}` : `which server? ${mine.length ? `this project has ${mine.map((s) => s.name).join(", ")}` : "no servers in this project"}`,
    );
  }
  const plan = await api<ConfigPlanInfo>(`/api/config?${new URLSearchParams({ id: target.id, includeSecrets: a.includeSecrets ? "1" : "0" })}`);
  let secrets = plan.omittedSecrets.length
    ? `\nLeft out (look like secrets; keep them in .env, or pass --include-secrets): ${plan.omittedSecrets.join(", ")}`
    : "";
  if (plan.removed.length) secrets += `\nRemoved from the command: ${plan.removed.join(", ")}. Servers get credentials from accounts/ADC or .env instead.`;
  if (plan.rewritten.length) secrets += `\nMade portable: ${plan.rewritten.join("; ")}`;
  if (plan.warnings.length) secrets += `\nMay not work on another machine: ${plan.warnings.join("; ")}`;
  if (plan.state === "defined") return { ok: true, text: `${target.id} is already defined in ${plan.file}; nothing to change.${secrets}`, data: plan };
  const preview = [`${plan.state === "missing" ? "Add" : "Update"} "${target.name}" in ${plan.file}${plan.exists ? "" : " (new file)"}:`];
  for (const c of plan.changes) {
    preview.push(c.before === undefined ? `  + ${c.key}: ${show(c.after)}` : c.after === undefined ? `  - ${c.key}: ${show(c.before)}` : `  ~ ${c.key}: ${show(c.before)} → ${show(c.after)}`);
  }
  if (a.dryRun) return { ok: true, text: preview.join("\n") + secrets + "\n(dry run: nothing written)", data: plan };
  if (plan.state === "differs" && !a.force) {
    return { ok: false, code: 1, text: preview.join("\n") + secrets + "\nservedev.json already defines it differently; run again with --force to replace it.", data: plan };
  }
  const r = await api<ConfigPlanInfo>("/api/config", { id: target.id, force: a.force, includeSecrets: a.includeSecrets });
  return { ok: true, text: `${preview.join("\n")}${secrets}\nSaved. Commit ${plan.file} to share it; teammates run \`servedev up\`.`, data: r };
}

