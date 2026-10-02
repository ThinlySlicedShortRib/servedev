#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ApiError, api, daemonStatus, ensureDaemon, stopDaemon } from "./client";
import { runDaemon } from "./daemon";
import { AGENT_INSTRUCTIONS } from "./instructions";
import { runMcp } from "./mcp";
import {
  opAutostart,
  opConfig,
  opHostname,
  opStopHung,
  opList,
  opLogs,
  opPin,
  opProfile,
  opProfiles,
  opConfigStatus,
  opWhere,
  opResetGrid,
  opGetGrid,
  opSetup,
  opAddProject,
  opSave,
  opAccounts,
  opAccountUse,
  opAccountAction,
  opAccountAdd,
  opAccountCatalog,
  opAccountRemove,
  opAccountTest,
  opRemove,
  opRemoveProject,
  opRestart,
  opRuns,
  opSearch,
  opStart,
  opStatus,
  opStop,
  opUp,
  opWait,
  type OpResult,
} from "./ops";
import { clean } from "./logs";
import { opRemoteAdd, opRemoteBoot, opRemoteList, opRemoteReconnect, opRemoteRemove } from "./remote/ops";
import { DAEMON_LOG, DAEMON_URL, VERSION, getToken } from "./paths";
import { findRoot, type ReadySpec } from "./project";

const HELP = `servedev ${VERSION} — manage local dev servers (built for coding agents)

Usage:
  servedev start [name] [-- <command...>]   start a server and wait until it's ready (idempotent)
  servedev up [names...]                    start servers from servedev.json in dependency order
  servedev ls [--all]                       list servers (this project, or all)
  servedev status [name]                    details + recent logs
  servedev logs [name] [-n N] [--grep RE] [--since 2m] [--prev | --run ID] [-f]
  servedev runs [name]                      run history: when each run started, how it ended, its log
  servedev search [regex] [--errors|--warnings] [-C N] [--server NAME] [--since 5m] [--prev|--both|--history] [--all]
                                            search logs across servers (grep -n -C style)
  servedev restart [name]
  servedev stop [names...] [--all]          stop servers (--all: every server in this project)
  servedev down                             stop every server in this project
  servedev wait [name]                      block until a starting server is ready
  servedev save [name] [--force] [--dry-run]
                                            write the server into its repo's servedev.json (shared through git)
  servedev rm <name>                        stop and forget a server
  servedev remove-project [path]            stop and forget every server in a project folder (files stay)
  servedev pin <name> / unpin <name>        pinned servers stay on top and start at login
  servedev hostname [name] [host|--clear]   custom URL like http://keel.localhost (proxied to the real port)
  servedev cleanup                          stop hung servers: ones still running from deleted folders (e.g. removed worktrees)
  servedev autostart [on|off]               the login item that starts pinned servers
  servedev add [path]                       track a folder: its servedev.json's servers and shared profiles appear
  servedev profile [ls]                     profiles: yours (any servers) and shared ones from repos' servedev.json
  servedev profile create <profile> [servers...] [--running] [--shared [--project p]]
  servedev profile share <profile>          move one of yours into its repo's servedev.json (commit to share)
  servedev profile duplicate <profile> [new-name]   copy a shared profile as one of yours
  servedev profile skip <shared profile> [servers...]   servers of a shared profile you don't start
  servedev profile needs <shared profile> gcloud.project=<id>   what its servers need (no personal accounts)
  servedev profile add|remove <profile> <servers...>
  servedev profile rename <profile> <new-name>
  servedev profile start <profile>          start its servers in order (others keep running)
  servedev profile delete <profile>
  servedev profile accounts <profile> gcloud.account=me@x.com [gcloud.project=p] [github=none]
                                            accounts this profile's servers use instead of the machine's
  servedev account [provider]               this machine's platform accounts (Google Cloud, GitHub, ...)
  servedev account use <provider> <value> [field=value...]
                                            switch machine-wide, e.g. account use gcloud me@x.com project=my-proj
  servedev account action <provider> <action> [key=value...]
                                            e.g. account action gcloud sign-in-apps account=me@x.com
  servedev account catalog                  platforms you can add (AWS, Docker, ...)
  servedev account add <id> | --file x.json add one from the catalog, or your own JSON provider (--replace to update)
  servedev account test --file x.json       dry-run a provider: runs its list/current commands, never switches
  servedev account remove <provider>        remove a platform you added
  servedev ui                               open the web dashboard
  servedev mcp                              run as an MCP server over stdio
  servedev instructions                     print a snippet for CLAUDE.md / AGENTS.md
  servedev config [key] [value]             settings, e.g. servedev config log_retention_days 14
  servedev config status                    config files (~/.servedev/config.json, servedev.json) and problems in them
  servedev config where <server|profile>    which file defines it
  servedev grid [profile] / grid reset <profile>   show a grid / drop your layout of a shared profile's grid
  servedev setup [dirs...] [--apply] [--map project=path]   new machine: find your projects' repos by git remote
  servedev daemon [status|stop|restart]

Other machines (this one is the hub; each machine runs its own servedev, reached over SSH):
  servedev remote add <name> <user@host>    connect one and check it step by step (SSH, OS, servedev, token, API)
  servedev remote ls                        machines: connected / reconnecting / offline, versions, servers
  servedev remote rm <name>                 disconnect and forget it (nothing changes on that machine)
  servedev remote reconnect <name>          reconnect now, re-reading its token
  servedev remote boot <name> [--install]   Windows/WSL: start servedev at logon and keep WSL running
  Their servers' ids start with the machine: pc/demo:api. Use them anywhere a server name goes, or add
  --on <machine> to start, stop, restart, logs, status, search and ls (e.g. servedev logs api --on pc).

Start options:
  --port <n|auto>       set $PORT (and {port} in the command); auto picks a free one
  --ready-log <regex>   ready when the log matches
  --ready-url <url>     ready when this URL or path (e.g. /health) answers < 500
  --ready none          don't wait for a port (workers, watchers)
  --timeout <sec>       how long to wait for readiness (default 60, or 300 with a setup step)
  --install             run the package manager install first (e.g. pnpm install)
  --setup <cmd>         run a setup command before the server, on every start
  --cwd <dir>           working directory for the command
  --hostname <host>     custom hostname, e.g. keel.localhost
  --env KEY=VALUE       environment variable kept with the server (repeatable; KEY= removes one).
                        Everything else comes from a new login shell, not the terminal you run this in
  --no-wait             return immediately after spawning
  --restart             restart if already running
  --profile <profile>   use that profile's accounts (start/restart); "none" for this machine's

Global: --json for machine-readable output.
Servers are scoped to the project (nearest dir with servedev.json or .git).`;

function readSpecFile(file: string): unknown {
  const full = path.resolve(file);
  let text: string;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch {
    throw new Error(`can't read ${full}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${full} isn't valid JSON: ${(e as Error).message}`);
  }
}

function splitKv(kv: string): [string, string] {
  const i = kv.indexOf("=");
  if (i <= 0) throw new Error(`expected key=value, got "${kv}"`);
  return [kv.slice(0, i), kv.slice(i + 1)];
}

/** gcloud.account=x gcloud.project=y github=none → { gcloud: { account, project }, github: null } */
function parseAccountPicks(args: string[]): Record<string, Record<string, string> | null> {
  const picks: Record<string, Record<string, string> | null> = {};
  for (const arg of args) {
    const [key, value] = splitKv(arg);
    const [provider, field] = key.split(".");
    if (!field) {
      if (value !== "none") throw new Error(`"${arg}": use ${provider}.<field>=<value>, or ${provider}=none for this machine's accounts`);
      picks[provider] = null;
    } else {
      picks[provider] = { ...(picks[provider] ?? {}), [field]: value };
    }
  }
  return picks;
}

/** "me@x.com project=p": a bare first value is the provider's first field. */
async function fieldValues(provider: string, args: string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const [i, arg] of args.entries()) {
    if (i === 0 && !/^[\w-]+=/.test(arg)) {
      const state = (await opAccounts({ provider })).data as { providers: { fields: { id: string }[] }[] };
      values[state.providers[0].fields[0].id] = arg;
    } else {
      const [k, v] = splitKv(arg);
      values[k] = v;
    }
  }
  return values;
}

async function main() {
  const argv = process.argv.slice(2);
  const dd = argv.indexOf("--");
  const own = dd === -1 ? argv : argv.slice(0, dd);
  const rest = dd === -1 ? [] : argv.slice(dd + 1);

  const { values: o, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      all: { type: "boolean", short: "a" },
      port: { type: "string", short: "p" },
      "ready-log": { type: "string" },
      "ready-url": { type: "string" },
      ready: { type: "string" },
      timeout: { type: "string", short: "t" },
      cwd: { type: "string" },
      setup: { type: "string" },
      hostname: { type: "string" },
      clear: { type: "boolean" },
      install: { type: "boolean" },
      env: { type: "string", short: "e", multiple: true },
      "no-wait": { type: "boolean" },
      restart: { type: "boolean" },
      lines: { type: "string", short: "n" },
      grep: { type: "string", short: "g" },
      since: { type: "string", short: "s" },
      prev: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      "no-open": { type: "boolean" },
      errors: { type: "boolean" },
      warnings: { type: "boolean" },
      context: { type: "string", short: "C" },
      limit: { type: "string" },
      server: { type: "string", multiple: true },
      both: { type: "boolean" },
      history: { type: "boolean" },
      running: { type: "boolean" },
      autostart: { type: "boolean" },
      run: { type: "string" },
      profile: { type: "string" },
      force: { type: "boolean" },
      "include-secrets": { type: "boolean" },
      "dry-run": { type: "boolean" },
      refresh: { type: "boolean" },
      file: { type: "string" },
      replace: { type: "boolean" },
      override: { type: "boolean" },
      shared: { type: "boolean" },
      project: { type: "string" },
      description: { type: "string" },
      apply: { type: "boolean" },
      map: { type: "string", multiple: true },
      on: { type: "string" },
    },
  });

  const [cmd, ...args] = positionals;
  if (o.version) return console.log(VERSION);
  if (o.help || !cmd || cmd === "help") return console.log(HELP);

  const cwd = process.cwd();
  const timeout = o.timeout ? Number(o.timeout) : undefined;
  let result: OpResult;
  /** A server name, on the machine given with --on: "api" -> "pc/api". */
  const on = (name: string | undefined): string | undefined => {
    if (!o.on) return name;
    if (!name) throw new Error(`pass a server name with --on: servedev ${cmd} <name> --on ${o.on}`);
    return name.includes("/") ? name : `${o.on}/${name}`;
  };

  switch (cmd) {
    case "start":
    case "run": {
      const command = rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : rest.map(shellQuote).join(" ");
      const port = o.port === undefined ? undefined : o.port === "auto" ? "auto" : Number(o.port);
      if (port !== undefined && port !== "auto" && !(port > 0 && port < 65536)) throw new Error(`invalid --port ${o.port}`);
      if (o.ready && !["none", "port"].includes(o.ready)) throw new Error(`--ready must be "none" or "port" (use --ready-log / --ready-url for patterns)`);
      const ready: ReadySpec | undefined =
        o.ready || o["ready-log"] || o["ready-url"]
          ? { mode: o.ready as ReadySpec["mode"], log: o["ready-log"], url: o["ready-url"] }
          : undefined;
      // Only the variables given here are sent and kept; a new terminal's environment supplies the rest.
      const env = o.env ? parseEnv(o.env) : undefined;
      result = await opStart({
        cwd,
        name: on(args[0]),
        command,
        setup: o.setup,
        install: o.install,
        hostname: o.hostname,
        dir: o.cwd,
        port,
        ready,
        timeout,
        wait: !o["no-wait"],
        restart: o.restart,
        env,
        profile: o.profile,
      });
      break;
    }
    case "up":
      result = await opUp({ cwd, names: args, timeout });
      break;
    case "ls":
    case "list":
    case "ps":
      result = await opList({ cwd, all: o.all, machine: o.on });
      break;
    case "status":
      result = await opStatus({ cwd, name: on(args[0]) });
      break;
    case "logs":
    case "log":
      if (o.follow) return follow(cwd, on(args[0]));
      result = await opLogs({
        cwd,
        name: on(args[0]),
        tail: o.lines === "all" ? "all" : o.lines ? Number(o.lines) : undefined,
        grep: o.grep,
        since: o.since,
        prev: o.prev,
        run: o.run ? Number(o.run) : undefined,
      });
      break;
    case "search":
    case "grep": {
      if (!args[0] && !o.errors && !o.warnings) throw new Error("usage: servedev search <regex> | --errors | --warnings");
      result = await opSearch({
        cwd,
        query: args[0],
        preset: o.errors ? "errors" : o.warnings ? "warnings" : undefined,
        servers: o.server,
        machine: o.on,
        all: o.all,
        since: o.since,
        context: o.context ? Number(o.context) : undefined,
        limit: o.limit ? Number(o.limit) : undefined,
        runs: o.history ? "all" : o.both ? "both" : o.prev ? "previous" : "current",
      });
      break;
    }
    case "remove-project":
      result = await opRemoveProject({ cwd, path: args[0] });
      break;
    case "cleanup":
      result = await opStopHung();
      break;
    case "hostname":
    case "host":
      result = await opHostname({ cwd, name: args[0], hostname: args[1], clear: o.clear });
      break;
    case "pin":
    case "unpin":
      result = await opPin({ cwd, name: args[0], pinned: cmd === "pin" });
      break;
    case "autostart":
      if (args[0] && !["on", "off"].includes(args[0])) throw new Error("usage: servedev autostart [on|off]");
      result = await opAutostart(args[0] === undefined ? undefined : args[0] === "on");
      break;
    case "profile":
    case "profiles": {
      const [action, name, ...rest] = args;
      if (!action || action === "ls" || action === "list") {
        result = await opProfiles();
        break;
      }
      if (action === "accounts") {
        if (!name) throw new Error("usage: servedev profile accounts <profile> <provider.field=value | provider=none>...");
        result = await opProfile({ cwd, action: "accounts", name, accounts: parseAccountPicks(rest) });
        break;
      }
      if (action === "needs") {
        if (!name) throw new Error("usage: servedev profile needs <shared profile> gcloud.project=<id> ...");
        result = await opProfile({ cwd, action: "needs", name, accounts: parseAccountPicks(rest) });
        break;
      }
      const actions = ["create", "add", "remove", "rename", "delete", "start", "up", "accounts", "needs", "skip", "share", "duplicate"];
      if (!actions.includes(action) || !name) throw new Error(`usage: servedev profile ${actions.join("|")} <profile> ...`);
      if (action === "rename" && !rest[0]) throw new Error("usage: servedev profile rename <profile> <new-name>");
      result = await opProfile({
        cwd,
        action: (action === "up" ? "start" : action) as "create",
        name,
        servers: rest,
        running: o.running,
        rename: rest[0],
        shared: o.shared,
        project: o.project,
        description: o.description,
      });
      break;
    }
    case "account":
    case "accounts": {
      const [sub, provider, ...more] = args;
      if (sub === "use" || sub === "switch") {
        if (!provider || !more.length) throw new Error("usage: servedev account use <provider> <value> [field=value...]");
        result = await opAccountUse({ provider, values: await fieldValues(provider, more) });
      } else if (sub === "action") {
        const [action, ...kv] = more;
        if (!provider || !action) throw new Error("usage: servedev account action <provider> <action> [key=value...]");
        result = await opAccountAction({ provider, action, args: Object.fromEntries(kv.map(splitKv)) });
      } else if (sub === "catalog") {
        result = await opAccountCatalog();
      } else if (sub === "add") {
        if (!provider && !o.file) throw new Error("usage: servedev account add <catalog-id> | --file my-platform.json [--replace] [--override]");
        result = await opAccountAdd({ catalog: o.file ? undefined : provider, spec: o.file ? readSpecFile(o.file) : undefined, replace: o.replace, override: o.override });
      } else if (sub === "remove" || sub === "rm") {
        if (!provider) throw new Error("usage: servedev account remove <provider>");
        result = await opAccountRemove(provider);
      } else if (sub === "test") {
        if (!o.file) throw new Error("usage: servedev account test --file my-platform.json [field=value...]");
        result = await opAccountTest({ spec: readSpecFile(o.file), selection: Object.fromEntries([provider, ...more].filter(Boolean).map(splitKv)) });
      } else {
        result = await opAccounts({ provider: sub, refresh: o.refresh });
      }
      break;
    }
    case "runs":
    case "history":
      result = await opRuns({ cwd, name: args[0], limit: o.limit ? Number(o.limit) : undefined });
      break;
    case "config":
      if (args[0] === "status" || args[0] === "check") result = await opConfigStatus();
      else if (args[0] === "where") {
        if (!args[1]) throw new Error("usage: servedev config where <server or profile>");
        result = await opWhere({ cwd, name: args[1] });
      } else result = await opConfig({ key: args[0], value: args[1] });
      break;
    case "grid":
      if (args[0] === "reset" && args[1]) result = await opResetGrid({ profile: args[1] });
      else result = await opGetGrid({ profile: args[0] });
      break;
    case "setup":
      result = await opSetup({ apply: o.apply, map: Object.fromEntries((o.map ?? []).map(splitKv)), roots: args });
      break;
    case "add":
      result = await opAddProject({ cwd, path: args[0] });
      break;
    case "restart":
      result = await opRestart({ cwd, name: on(args[0]), wait: !o["no-wait"], timeout, profile: o.profile });
      break;
    case "stop":
    case "kill":
      if (o.on && !o.all && !args.length) throw new Error(`pass server names with --on (or --all for everything running on ${o.on})`);
      if (o.on && o.all) result = await opStop({ cwd, names: [], all: true, machine: o.on });
      else result = await opStop({ cwd, names: o.on ? args.map((n) => on(n)!) : args, all: o.all });
      break;
    case "down":
      result = await opStop({ cwd, names: [], all: true });
      break;
    case "wait":
      result = await opWait({ cwd, name: args[0], timeout });
      break;
    case "save":
      result = await opSave({ cwd, name: args[0], force: o.force, includeSecrets: o["include-secrets"], dryRun: o["dry-run"] });
      break;
    case "rm":
    case "remove":
      if (!args[0]) throw new Error("usage: servedev rm <name>");
      result = await opRemove({ cwd, name: args[0] });
      break;
    case "remote":
    case "machine":
    case "machines": {
      const [sub, name, target] = args;
      if (sub === "add") {
        if (!name || !target) throw new Error("usage: servedev remote add <name> <user@host>");
        result = await opRemoteAdd({ name, ssh: target });
      } else if (!sub || sub === "ls" || sub === "list") result = await opRemoteList();
      else if (sub === "rm" || sub === "remove") {
        if (!name) throw new Error("usage: servedev remote rm <name>");
        result = await opRemoteRemove(name);
      } else if (sub === "reconnect") {
        if (!name) throw new Error("usage: servedev remote reconnect <name>");
        result = await opRemoteReconnect(name);
      } else if (sub === "boot") {
        if (!name) throw new Error("usage: servedev remote boot <name> [--install]");
        result = await opRemoteBoot({ name, install: o.install });
      } else throw new Error("usage: servedev remote add|ls|rm|reconnect|boot ...");
      break;
    }
    case "ui":
    case "dashboard": {
      await ensureDaemon();
      console.log(`servedev dashboard: ${DAEMON_URL}`);
      if (!o["no-open"]) Bun.spawn(["open", DAEMON_URL], { stdout: "ignore", stderr: "ignore" });
      return;
    }
    case "mcp":
      return runMcp();
    case "instructions":
      return console.log(AGENT_INSTRUCTIONS);
    case "daemon": {
      const sub = args[0] ?? "status";
      if (sub === "run") return runDaemon({ autostart: o.autostart });
      if (sub === "stop") return console.log((await stopDaemon()) ? "daemon stopped (servers keep running)" : "daemon not running");
      if (sub === "restart") {
        await stopDaemon();
        await ensureDaemon();
      }
      const h = await daemonStatus();
      return console.log(h ? `daemon ${h.version} running (pid ${h.pid}) at ${DAEMON_URL}; log: ${DAEMON_LOG}` : "daemon not running");
    }
    default:
      throw new Error(`unknown command "${cmd}". Run servedev --help.`);
  }

  if (o.json) console.log(JSON.stringify(result.data ?? {}, null, 2));
  else console.log(result.text);
  process.exitCode = result.ok ? 0 : (result.code ?? 1);
}

async function follow(cwd: string, name?: string) {
  const r = await api<{ server: { id: string } }>(`/api/logs?${new URLSearchParams({ root: findRoot(cwd), ...(name ? { name } : {}), tail: "0" })}`);
  const res = await fetch(`${DAEMON_URL}/api/stream/logs?id=${encodeURIComponent(r.server.id)}&token=${getToken()}`);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (event === "data" && data) process.stdout.write(clean(JSON.parse(data)));
    }
  }
}

function parseEnv(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) throw new Error(`--env expects KEY=VALUE, got "${p}"`);
    env[p.slice(0, i)] = p.slice(i + 1);
  }
  return env;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

main().catch((e) => {
  const msg = e instanceof ApiError || e instanceof Error ? e.message : String(e);
  console.error(`servedev: ${msg}`);
  process.exit(1);
});
