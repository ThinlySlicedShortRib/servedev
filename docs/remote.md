# Other machines

One servedev (the **hub**, usually your laptop) can show and control the servers of other machines that run servedev too: a desktop PC, a Linux box. Each machine stays the only source of truth for its own servers; the hub relays, it doesn't copy. If a machine goes away you still see its servers as they last were (marked *last known*), and anything you try to do to them fails with a clear error until it's back.

```sh
servedev remote add pc ariel@100.68.42.78   # connect and check, step by step
servedev ls --all                            # MACHINE column; pc's servers are pc/<project>:<name>
servedev logs api --on pc -f                 # --on <machine> for start, stop, restart, logs, status, search, ls
servedev restart pc/demo:api                 # or the full id, anywhere a server name goes
servedev start web --on pc --dir '~/code/app' -- npm run dev   # a new server in a folder on pc
servedev dirs '~/code' --on pc               # folders there, marking projects
curl http://api.pc.localhost:7780            # each running server's port, forwarded here
servedev remote ls                           # connected / reconnecting / offline, versions, forwards
servedev remote reconnect pc                 # now, instead of waiting for the next retry
servedev remote rm pc                        # forget it here (nothing changes on pc)
```

## How it works

The hub keeps **one SSH connection** per machine (an OpenSSH ControlMaster using your keys, so it must work without a password: `ssh -o BatchMode=yes <host> echo ok`). Over it:

- **Setup** runs a few commands on the machine once per connection: find `servedev`, start its daemon if it isn't running, read its API token. Reconnecting with a token that still works runs nothing there at all.
- **The API** of the remote servedev is forwarded to a local port. Everything else (listing, starting, stopping, logs, the live event stream) is plain HTTP to the remote's own API, with its token and its own `Host` header (its Host check stays as strict as ever).
- **Server ports**: when a remote server listens, its ports are forwarded here, to the same number when that's free, else to another one, and it gets a hostname on the hub's proxy: `<server>.<machine>.localhost` (`<server>.<project>.<machine>.localhost` when two projects there use the same name). Forwards go away when the server stops.

The "Add machine" checklist (`remote add`, `remote reconnect`, the dashboard) is the same sequence: **SSH connection → operating system → servedev installed and running → API token → servedev API through the tunnel**. A failed step stops the rest and says how to fix it.

Connection states: **connecting** (first try), **connected**, **reconnecting** (lost it; retries after 1s, 2s, 4s … with the attempt count), **offline** (still failing after 5 tries; retried every minute). The hub notices a lost machine through SSH keepalives (within ~45s), the remote's event stream ending, or a health check every 15s.

A different servedev version on the machine is reported (in the checklist and `remote ls`), not fixed: update one side so they match.

### Where things are kept

| What | Where |
|---|---|
| The machine: `ssh`, and the detected `kind` / `distro` | `~/.servedev/config.json` → `machines` (edit by hand if you like) |
| Its API token | macOS Keychain (`dev.servedev.machine`), elsewhere `~/.servedev/machines/<name>.token` (mode 600). Never config.json. |
| Last known servers, version, last seen | `~/.servedev/machines/<name>.json` |
| SSH control socket | `~/.servedev/machines/<name>.sock` |

## Creating servers on another machine

A server you create for another machine is that machine's: it's written to its `~/.servedev/config.json` (or found in its repo's `servedev.json`), runs there, and stays there if the hub goes away. The hub only finds the folder, sends the start, and forwards the port.

```sh
servedev start web --on pc --dir '~/code/app' -- python3 -m http.server {port}
servedev start --on pc --dir /mnt/c/code/app            # no command: detected there (package.json dev script, servedev.json)
servedev start web --on pc --dir '~/code/app' --install --port auto --ready-log 'ready in'
servedev start pc/web                                   # once it exists: by name, like any other server
```

- `--dir` is a folder **on that machine**: absolute, or `~/…` for its home (on a WSL PC, `/mnt/c/…` reaches Windows' drives). Quote `~` so your shell doesn't expand it here; an unquoted path under your home here is taken as the same path under the home there. Relative paths are refused (they'd depend on where its daemon started).
- The folder's project is found there the same way as locally (nearest `servedev.json` or `.git`). Without a name, the server is named after the folder; without a command, it's detected there.
- `--install`, `--setup`, `--port`, `--ready-log` / `--ready-url` / `--ready none`, `--timeout`, `--env`, `--cwd`, `--restart`, `--no-wait` and `--profile` mean what they do locally. Only the variables you pass go along, never this machine's environment; `--cwd` is a path there too.
- The answer comes back in hub terms: `pc/<project>:<name>`, and its URL here, `http://<name>.pc.localhost` (through the hub's proxy), plus where it listens there.
- `servedev dirs [path] --on pc` lists the subfolders of a folder there (`--hidden` for dot-folders and `node_modules`), marking those with `servedev.json`, `package.json` or a git repo. Names only, never files or their contents.

In the dashboard, **New server** gets a **Machine** picker once a machine is added (one that isn't connected is listed but can't be picked, with why). With a machine picked, the folder is a path there, **Browse…** opens a small navigator over that machine's folders, detection and the dependency check run there, and the name's description says where it'll open here. The new server shows up under that machine in the sidebar and opens, like a local one.

**Versions.** Starting and inspecting work with any servedev on the machine. Browsing its folders needs the `/api/dirs` endpoint (servedev 0.3.0); an older one answers "pc runs servedev 0.2.0, which can't list its folders (type the path instead); update it", and typing the path still works. `remote ls` and the Machines sheet show when versions differ.

## Agents

The MCP server's server tools take an optional `machine` (or a `pc/…` id as the name): `start_server`, `stop_server` (with `all`: everything running on that machine), `restart_server`, `remove_server`, `server_status`, `server_logs`, `search_logs`, `server_runs`, `list_servers` (each remote server has `machine`), `inspect_folder`, and `list_folders`. `start_server` with `machine` and `dir` creates a server in a folder there. `list_machines` shows each machine's state, system, version, server counts and forwarded ports; `reconnect_machine` retries one now and reports the checklist. `servedev instructions` (for CLAUDE.md / AGENTS.md) mentions all of this.

## Windows PCs (servers in WSL)

servedev runs inside WSL; Windows' own OpenSSH server is what the hub connects to. SSH lands in `cmd.exe`, so the hub runs every command through `wsl.exe -e bash -lc …` (a login shell, so `~/.local/bin` is on PATH). Forwards target `127.0.0.1` or `::1` explicitly, never `localhost`, and the hub checks which of the two each server answers on: WSL relays a port bound to IPv4 only on Windows' 127.0.0.1, and one bound to `[::]` only on `::1`.

Setting up the PC:

1. Enable the OpenSSH server in Windows (Settings → Optional features → OpenSSH Server) and add your public key: for an administrator account in `C:\ProgramData\ssh\administrators_authorized_keys`, otherwise `%USERPROFILE%\.ssh\authorized_keys`.
2. Install servedev inside WSL, on the login PATH: `wsl.exe -e bash -lc 'servedev --version'` should print it.
3. `servedev remote add pc you@<tailscale address>` on the hub.

**WSL shuts down when nothing on Windows holds it open**, and takes every server with it. While the hub is connected it holds a session open. To have servedev start (with its pinned servers) when you log in to Windows, and keep WSL up without the hub:

```sh
servedev remote boot pc             # writes ~/.servedev/wsl-boot.sh on pc and prints a PowerShell command to run there
servedev remote boot pc --install   # or registers the task over SSH
```

The task is a logon task named `servedev-wsl` that runs `conhost.exe --headless wsl.exe -d <distro> -e /bin/bash -l ~/.servedev/wsl-boot.sh` with no execution time limit (Task Scheduler stops tasks after 3 days by default). The script starts `servedev daemon run --autostart` if it isn't running and then stays attached. It runs at logon, not at boot: starting WSL before anyone logs in needs a task that stores your Windows password ("Run whether user is logged on or not"), which you can set in Task Scheduler.

## In the dashboard

Once a machine is added, the sidebar groups servers by machine: this one first, then each other machine with its own projects. A machine's header shows its state, how many of its servers run (and crashed), and folds its servers away; while it's reconnecting or offline a second line says so, with **Retry**. A remote server's row shows the port it has on its machine; the link opens it here (at `<server>.<machine>.localhost`, or the forwarded port). An offline machine's servers stay in the list, dimmed, with their last known state, and count in the status filters that way.

**Machines** (next to Accounts) lists the machines: state, system, address, servedev version, servers and forwarded ports, with Reconnect now, Show only its servers, Copy SSH command, Start with Windows (the boot task below) and Remove. **Add machine** there runs the same checklist as `remote add`.

A remote server's page says which machine it's on, where its address here leads (`→ pc:3000`, and the local port when that one was busy here), and pauses its actions while the machine isn't connected. Remote servers can go on the unsaved custom grid (with a small machine tag); profiles can't hold them yet.

## API (for the dashboard and other clients)

All under the hub's token, like the rest of the API.

| Endpoint | What |
|---|---|
| `GET /api/servers` | Local and remote servers (remote ones have `machine`, `remoteId`, `machineState`, `stale`, `remoteUrl`, `localHostname`, `forwards`; `url` is the forwarded one here), plus `machines` |
| `GET /api/machines` | `{ machines: MachineSummary[], hubVersion }` |
| `POST /api/machines/add` `{ name, ssh }` | `{ ok, steps: SetupStep[], machine? }`; on success the machine is saved and stays connected |
| `POST /api/machines/reconnect` `{ name }` | `{ ok, steps, machine }` |
| `POST /api/machines/remove` `{ name }` | `{ removed }` |
| `POST /api/machines/boot` `{ name, install? }` | `{ supported, script, powershell, installed?, note? }` |
| `GET /api/stream/events` | The snapshot has `machines`; remote servers arrive as `server` / `remove` events with `pc/` ids; `machine` (a MachineSummary) when a machine's state or forwards change; `machine-removed` `{ name }` |

Every endpoint that takes a server id or name (start, stop, restart, remove, pin, hostname, wait, logs, runs, processes, the log streams, bulk start/stop, search) accepts `pc/<id>` or `pc/<name>` and is relayed. `POST /api/search` also takes `machine` to search every server on that machine.

| Endpoint | What |
|---|---|
| `POST /api/start` `{ machine, dir, name?, command?, install?, setup?, port?, ready?, timeout?, vars?, cwd?, wait? }` | Create (or start) a server in a folder on that machine. The hub inspects `dir` there for its project root, then sends the machine its own `/api/start`; the hub's `root`, `clientCwd` and `env` are never sent. `{ machine, name }` or `{ name: "pc/web" }` starts a known server there (options like a new command apply to it). Answer: a StartResponse with a `pc/` server view. |
| `GET /api/inspect?machine=pc&dir=~/code/app` | The folder inspected there (paths are that machine's), plus `machine` and `urlTemplate` (`http://{host}:7780`, `{host}` being `<name>.pc.localhost`; absent while the proxy is off) |
| `GET /api/dirs?path=&hidden=1&limit=` | Subfolders of a folder on this machine: `{ path, parent?, home, dirs: [{ name, path, link?, package?, servedev?, git? }], hidden, truncated? }` plus the same markers for the folder itself. `~` and relative paths are from home; `..` is resolved, so `path` says where it really is. Hidden (unless `hidden=1`): dot-folders and `node_modules`. Files are never listed. 404 for a missing folder, 400 for a file, 403 when unreadable. |
| `GET /api/dirs?machine=pc&path=` | The same on that machine (with `machine`); 501 when its servedev predates it | Types: `MachineSummary`, `SetupStep` and `RemoteServerView` in `src/remote/types.ts`.

## Limits

- No state is synced: profiles (and their grids) and pins here can't include another machine's servers yet; the unsaved grid can. Pinning a remote server pins it on its machine.
- Remote servers' own custom hostnames (set on that machine) aren't routed by the hub's proxy; their hub hostname is `<server>.<machine>.localhost`.
- From the hub you can't track a folder on another machine without starting something (`servedev add` / Add project are local); the New server dialog still lists a folder's `servedev.json` servers there and starts them.
- POSIX machines need a login shell that runs POSIX scripts (bash, zsh; not fish).
- servedev itself doesn't run on Windows outside WSL.
