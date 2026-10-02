# servedev

Local dev server manager built for coding agents (Claude Code, Cursor, Codex CLI), with a web dashboard for you.

Agents struggle with dev servers: running `npm run dev` in the foreground blocks them, `&` loses the logs and leaves orphans, they `sleep 5` and hope it's up, ports collide, and they start a second copy of a server that's already running. servedev fixes this:

- **Start is blocking-until-ready and idempotent.** `servedev start web` returns once the server is listening, with its URL. If it's already running you get the existing one. If it crashes you get the exit code and the last log lines.
- **Real ports, not guesses.** It watches which TCP ports the server's process group actually listens on (via `lsof`), so it works for Vite, Next.js, Django, Rails, Go, anything.
- **Bounded, filterable logs** (`--grep`, `--since 2m`, `-n`) so agents don't flood their context.
- **Clean shutdown** of the whole process tree; no orphaned `node` processes holding ports.
- **Servers outlive the agent session and the daemon.** Restarting the daemon re-adopts running servers.
- **Project-scoped names.** `web` in one repo/worktree doesn't collide with `web` in another.

## Install

Requires [Bun](https://bun.sh) to build; the result is a single binary with no runtime dependencies.

```sh
bun install
bun run build                       # -> dist/servedev
ln -s "$PWD/dist/servedev" /opt/homebrew/bin/servedev   # or anywhere on your PATH
```

## Use

```sh
servedev start                          # package.json "dev" script (or servedev.json)
servedev start api --port auto -- node server.js
servedev start worker --ready none -- npm run worker
servedev start --install                 # run pnpm/npm/yarn/bun install first
servedev start docs --ready-log "compiled successfully" -- npm run docs
servedev ls                             # this project; --all for everything
servedev logs web --grep error --since 5m
servedev search --errors                # errors across every server in the project, with context
servedev search "timeout" -C 5 --history  # a regex across all kept runs
servedev runs web                       # run history: started, ended, ready time, log size
servedev logs web --run 12              # an earlier run's log
servedev config log_retention_days 14   # keep logs longer (default 7)
servedev restart web
servedev down                           # stop everything in this project
servedev ui                             # open the dashboard (http://127.0.0.1:7777)
```

Readiness defaults to "the process group is listening on a TCP port". Alternatives: `--ready-log <regex>`, `--ready-url /health`, `--ready none`. `--port auto|N` exports `$PORT` and fills `{port}` in the command; for detected Vite/Next/Astro/etc. scripts it also passes `--port`.

A setup step (`--install`, `--setup "<cmd>"`, or `"setup"` in servedev.json) runs before the server in the same log and is repeated on restarts; if it fails, the server doesn't start.

`--install` picks the package manager from declared intent first (`"packageManager"` in package.json, then `pnpm-workspace.yaml`), then the nearest lockfile, and runs the install at the workspace root, so a pnpm/npm/yarn/bun monorepo package installs the whole workspace rather than creating a stray `node_modules`. servedev also checks whether dependencies are current (pnpm: the lockfile against `node_modules/.pnpm/lock.yaml`; npm/yarn: lockfile vs. install-record timestamps; bun keeps no record). A detected dev script with no `node_modules` installs automatically; a stale install gets a note suggesting `--install`.

Exit codes: `0` ready, `1` failed/crashed, `2` still starting after the timeout (left running).

### Single view and custom grid

The dashboard header switches between **Single** (one server with full details, logs, processes, run history and a live preview) and **Custom grid**, a board you build yourself: drag servers in from the list on the left or click **+** next to one, then move tiles by their header and resize them from the corner. Each tile shows a live log tail, with **open in new tab**, start/restart/stop, and **×** to take it off the grid (the server keeps running). A live **preview** of the app is a tab in Single view; apps that forbid being framed (`X-Frame-Options`, CSP `frame-ancestors`) get an explanation and an open-in-new-tab button instead.

A new grid is an unsaved draft (it survives reloads); **Save as profile** turns it into a profile with its layout. With a profile selected, the grid is that profile: adding, removing and rearranging tiles updates the profile, and tiles in reading order (top row first, left to right) are its start order. All tiles share one log stream, since browsers cap connections per host at about six. Built with [react-grid-layout](https://github.com/react-grid-layout/react-grid-layout).

### Custom URLs

```sh
servedev hostname dev keel.localhost    # http://keel.localhost -> whatever port the server uses
servedev start web --hostname app.localhost
servedev hostname                       # list hostnames and the proxy's status
servedev hostname dev --clear
```

Hostnames can also go in servedev.json (`"hostname": "keel.localhost"`) or be set from the dashboard. The daemon runs a small proxy that follows the server's current port across restarts, passes WebSockets (hot reload) and streaming through, and keeps the original `Host` header so apps build URLs and redirects with the custom name. `*.localhost` names resolve to this Mac everywhere with no setup; other names need an `/etc/hosts` entry.

The proxy listens on port 80 for port-less URLs. macOS lets normal users bind port 80 only on all interfaces, so the proxy rejects every request that doesn't come from this machine (403). It only runs while some server has a hostname, and falls back to port 7780 if 80 is taken (`servedev config proxy_port <port>` to choose).

### Pinning and profiles

```sh
servedev pin web                         # stays at the top of the dashboard and starts when you log in
servedev autostart off                   # remove the login item (macOS LaunchAgent)
servedev profile create "Full stack" api web   # a named set of servers, from any projects (yours only)
servedev profile create "Full stack" api web --shared   # ...or in the repo's servedev.json, for everyone
servedev profile create Review --running       # ...or from whatever is running now
servedev profile start "Full stack"      # start them in order; nothing else is stopped
servedev profile ls
```

Pinning a server installs `~/Library/LaunchAgents/dev.servedev.daemon.plist` (once). At login it starts the daemon with `--autostart`, which starts every pinned server that isn't running, using its saved command and environment. Only at login: restarting the daemon doesn't bring back a pinned server you stopped. In the dashboard, the switcher at the top of the sidebar changes between all servers and a profile's servers, with **Start all** for the stopped ones. Agents can use the `start_profile` MCP tool.

### Accounts (Google Cloud, GitHub, ...)

```sh
servedev account                                   # what this machine is signed in as, per platform, with warnings
servedev account use gcloud me@work.com project=work-dev   # switch machine-wide (every terminal)
servedev account action gcloud sign-in-apps        # save app credentials (ADC) for an account, via a browser sign-in
servedev profile accounts Work gcloud.account=me@work.com gcloud.project=work-dev github.user=me-work
servedev profile start Work                        # its servers run as those accounts; the machine stays as it is
servedev profile accounts Work gcloud=none         # back to the machine's accounts
```

A profile can pick accounts for its servers without switching your machine: at each start, servedev gives those processes environment variables such as `CLOUDSDK_CORE_ACCOUNT`, `GOOGLE_APPLICATION_CREDENTIALS` and `GH_TOKEN`. Tokens are fetched at start time and never stored. Google Cloud's CLI account and its app credentials (ADC, used by client libraries and cloud-sql-proxy) are tracked separately, since they often differ. In the dashboard, **Accounts** (top right) switches machine-wide values, and the profile dialog picks per-profile ones. Agents get `list_accounts`, `switch_account` and `run_account_action`, plus `accounts` on `create_profile`/`update_profile`.

Other platforms plug in as providers, each a JSON file in `~/.servedev/providers/`. Add them from the dashboard (**Accounts → Add platform**: a catalog with AWS, Azure, Cloudflare, DigitalOcean, Docker, Firebase, Kubernetes, 1Password, Stripe and Vercel, or a form for any other CLI, with a dry-run **Test**), or from the CLI:

```sh
servedev account catalog                # what can be added
servedev account add aws                # from the catalog
servedev account test --file fly.json   # dry-run your own: runs its list/current commands, never switches
servedev account add --file fly.json
servedev account remove fly
```

See [docs/providers.md](docs/providers.md) for the format.

### Other machines

```sh
servedev remote add pc me@100.68.42.78   # another computer running servedev (e.g. a Windows PC with servers in WSL)
servedev ls --all                        # its servers too: pc/demo:api
servedev logs api --on pc -f             # --on <machine>, or pc/<name> anywhere a name goes
curl http://api.pc.localhost:7780        # its ports, forwarded here
servedev start web --on pc --dir '~/code/app' -- npm run dev   # a new server there, defined on pc
```

This servedev becomes a hub: it keeps one SSH connection per machine and talks to that machine's own servedev through it, forwarding the ports its servers listen on. Machines show as connected, reconnecting or offline (with their last known servers). New servers can be created on a machine from the CLI, the dashboard's New server dialog (pick the machine, browse its folders) or agents (`start_server` with `machine` and `dir`). See [docs/remote.md](docs/remote.md), including starting servedev when a Windows PC boots.

### servedev.json (optional)

```json
{
  "servers": {
    "api": { "command": "bun run --watch src/server.ts", "setup": "bun install", "port": 4000, "ready": { "url": "/health" } },
    "web": { "command": "npm run dev", "cwd": "apps/web", "port": "auto", "dependsOn": ["api"] },
    "jobs": { "command": "npm run worker", "ready": "none", "env": { "QUEUE": "dev" } }
  }
}
```

`servedev up` starts all of them in dependency order. A `profiles` section adds shared profiles: everyone who clones the repo gets them, tagged **Shared** in the dashboard and kept in sync as the file changes. Your own profiles, account picks and grid tweaks live in `~/.servedev/config.json`. See [docs/config.md](docs/config.md) for both files, worktrees, and moving to a new machine (`servedev setup`).


### Sharing a server through git

A server started from the dashboard or with `servedev start -- <cmd>` lives only in your `~/.servedev/config.json`. To share it, write it into its repo's servedev.json:

```sh
servedev save api --dry-run   # show what would be written
servedev save api             # add it (asks for --force before replacing a different entry)
```

The dashboard has the same thing on a server's page ("Save to servedev.json", or "Update servedev.json" when the file has drifted). It writes the command, setup, folder (relative to the repo), port, ready check, hostname and the variables set on purpose; other servers and keys like `dependsOn` are kept. It never writes credentials: secret-looking variables are left out unless you pass `--include-secrets`, and credentials on the command line (`--token=…`, `ghp_…`, `sk_live_…`, passwords in URLs) are removed. Paths that only exist on this machine are made portable (`node /opt/homebrew/bin/pnpm dev` → `pnpm dev`, project paths become relative), and anything else machine-specific is pointed out.

### Environment

Every start gets a fresh login-shell environment (what a new terminal has: PATH, nvm, Homebrew…), then servedev.json's `env`, then the server's own variables (`--env KEY=VALUE`; `KEY=` removes one), then any profile account variables. The environment of the shell or agent you run `servedev` from is **not** passed on or saved, so session tokens and terminal/agent variables don't leak into servers or into servedev's database. `servedev status <name>` and the dashboard list a server's own variables with values masked.

## Hooking up agents

Add the instructions to your agent's memory file so it knows to use it:

```sh
servedev instructions >> CLAUDE.md      # or AGENTS.md, .cursor/rules/servedev.md
```

Every agent can use the CLI through its shell. Optionally add the MCP server too:

- **Claude Code:** `claude mcp add servedev -s user -- servedev mcp`
- **Cursor:** in `~/.cursor/mcp.json`: `{ "mcpServers": { "servedev": { "command": "servedev", "args": ["mcp"] } } }`
- **Codex CLI:** in `~/.codex/config.toml`:
  ```toml
  [mcp_servers.servedev]
  command = "servedev"
  args = ["mcp"]
  ```

MCP tools cover everything the dashboard can do, so you can ask an agent to "make a profile with Keel and the capcon API and lay them out side by side":

| Area | Tools |
|---|---|
| Servers | `start_server`, `list_servers` (includes servers running outside servedev), `server_status`, `restart_server`, `stop_server`, `remove_server`, `pin_server`, `set_hostname`, `inspect_folder` |
| Logs | `server_logs`, `search_logs` (all servers at once, `preset: "errors"`), `server_runs` |
| Several servers | `start_servers`, `stop_servers` (a profile, a list, or `all: true`) |
| Profiles | `list_profiles`, `create_profile`, `update_profile`, `delete_profile`, `start_profile` |
| Custom grid | `get_grid`, `set_grid` (servers + columns, or exact tiles), `update_grid`, `save_grid_as_profile`; an open dashboard updates live |
| Outside servers | `take_over_server`, `stop_outside_server` |
| Settings | `get_settings`, `update_settings` (log retention, proxy port, login autostart) |

## How it works

`servedev` auto-starts a small daemon (`127.0.0.1:7777`) that owns the processes. The CLI, the MCP server and the dashboard are all clients of its HTTP API. Each server runs as `sh -c <command>` in its own process group, with stdout/stderr going straight to a log file, so servers keep running if the daemon stops and a new daemon adopts them.

Some tools start work in process groups of their own: turbo, for one, runs every task in a new group. servedev follows the server's process tree and adopts any group a descendant creates, so it finds ports opened there, and stop/restart signal every group (otherwise `next dev` under turbo would be left running on its port). The groups are saved with each run; `servedev status` and the dashboard's **Processes** tab show them.

Configuration lives in JSON: each repo's `servedev.json` (shared) and `~/.servedev/config.json` (yours); see [docs/config.md](docs/config.md). State lives in SQLite (`~/.servedev/servedev.db`): one row per **run** (every start/restart), what it started with, and write-time marks so `--since` survives daemon restarts. Log text stays in files, one per run: `~/.servedev/logs/<project>_<name>/<run-id>.log`. Logs of runs that stopped more than `log_retention_days` (default 7) ago are deleted hourly; a stopped server keeps its row, so you still see how it last ended. Older installs' `state.json` is imported on first start and kept as `state.json.migrated`.

The API requires a token (`~/.servedev/token`) and rejects foreign `Host`/`Origin` headers, so web pages can't use it to run commands.

Environment: `SERVEDEV_HOME` (default `~/.servedev`), `SERVEDEV_PORT` (default `7777`).

## Development

```sh
bun src/cli.ts <command>    # run the CLI from source
bun run ui:dev              # dashboard with hot reload (Vite), proxied to the running daemon
bun test
bun run typecheck
bun run build               # builds ui/ then compiles dist/servedev
```

The dashboard in `ui/` is React + [shadcn/ui](https://ui.shadcn.com) (default `base-nova` style). Add components with `npx shadcn@latest add <name>` from `ui/`. It builds to a single self-contained `ui/dist/index.html` that the daemon embeds.

macOS and Linux (needs `lsof`). Windows isn't supported yet.
