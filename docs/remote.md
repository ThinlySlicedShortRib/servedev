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
servedev profile create "Full stack" pc/demo:api web   # a profile of yours across machines
servedev profile start "Full stack"          # each server on its machine, in order, each once the previous is ready
servedev pin pc/demo:api                     # pinned on pc: starts whenever servedev starts there
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

## Profiles, grids and pins across machines

Nothing is synced between machines; each profile belongs somewhere, and that decides what it can hold.

**Your own profiles** (the hub's `~/.servedev/config.json`) can mix machines: `"servers": ["pc/demo:api", "web:web"]`. Starting one (`servedev profile start`, `start_profile`, the dashboard's **Start all**) goes through its servers **in order, on whichever machine each is on, each once the previous one is ready**: this machine's through its own manager, another machine's through that machine's servedev (`/api/start` with `wait`), so an API on the PC is up before the web app here that needs it. Servers already running are left as they are.

- **A machine that isn't connected**: its servers are skipped, and the result says so (`– pc/demo:api skipped: pc is offline (…); start it again once pc is back`); the rest still start. The CLI doesn't count skipped servers as failures. In the dashboard they're listed as left out before you confirm.
- **Refs are kept.** The hub checks a profile's `pc/…` refs against what that machine last reported. One it still has is a member (shown with its last known state while the machine is away). One that's gone from a connected machine, or that names a machine you don't have (anymore), is listed as not defined, and stays in the file: editing the profile never drops it, just like a server that's only on another branch. Removing a server through the hub (`servedev rm pc/demo:api`) takes it out of your profiles and grids, like removing a local one.
- **Accounts resolve where a server runs.** A profile's account picks (`servedev profile accounts`) are for its servers on this machine: they name accounts signed in here, so they're never sent to another machine. A server on another machine started from your profile gets the accounts its own machine resolves for it (the profile there it last ran with, or the one profile there that picks accounts, else that machine's own), and the start result notes it when your profile picks accounts. To pick accounts for servers on the PC, use a profile on the PC (a shared one in its repo, or one of its own).

**Grids.** The unsaved grid and your profiles' grids take any server, with a machine tag on another machine's tiles. **Save as profile** keeps every tile, other machines' included. A shared profile's grid holds its own repo's servers.

**Profiles shared in repos on other machines.** A repo's `servedev.json` never mentions machines; its shared profiles belong to the repo, and each machine that has the repo starts its own servers with them. On a hub, those of each connected machine are listed too, under that machine (`pc/demo:Full stack`; `profile ls`, the switcher's "Shared in repos on pc", `list_profiles`). Everything done to one happens on its machine: starting it (in order, with that machine's accounts for the profile), editing it (its servers, order, description and skipped servers are written to the `servedev.json` there, and your changes to it are kept in that machine's config), its grid, deleting it. **Make a copy of your own** copies it into the hub's config with `pc/` ids and its layout, without its account picks. While the machine is away they show as last seen and can't be changed. Profiles that are another machine's own (in its `config.json`) aren't shown on the hub.

**Pins.** Pinning a remote server (`servedev pin pc/demo:api`, `pin_server`, the server page's **Pin on pc**) pins it on that machine, in its own config: it starts whenever servedev starts there (its login item on a Mac, the boot task below on a Windows PC), whether or not the hub is around. The hub's own pins are only its own servers.

## Agents

The MCP server's server tools take an optional `machine` (or a `pc/…` id as the name): `start_server`, `stop_server` (with `all`: everything running on that machine), `restart_server`, `remove_server`, `server_status`, `server_logs`, `search_logs`, `server_runs`, `list_servers` (each remote server has `machine`), `inspect_folder`, and `list_folders`. `start_server` with `machine` and `dir` creates a server in a folder there. Profile and grid tools (`create_profile`, `update_profile`, `start_profile`, `start_servers` with a profile, `set_grid`, `update_grid`) take `pc/…` ids too. `list_machines` shows each machine's state, system, version, server counts and forwarded ports; `reconnect_machine` retries one now and reports the checklist. `servedev instructions` (for CLAUDE.md / AGENTS.md) mentions all of this.

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

A remote server's page says which machine it's on, where its address here leads (`→ pc:3000`, and the local port when that one was busy here), and pauses its actions while the machine isn't connected. Remote servers can go on any custom grid of yours (with a small machine tag).

The profile dialog lists servers by machine, then project; the switcher shows which machines each of your profiles uses (and when one of them is away), counts remote servers, and lists each machine's shared profiles under "Shared in repos on pc". With a profile selected, a project on another machine carries that machine's tag in the sidebar.

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
| `GET /api/stream/events` | The snapshot has `machines`; remote servers arrive as `server` / `remove` events with `pc/` ids; `machine` (a MachineSummary) when a machine's state or forwards change; `machine-removed` `{ name }`; `profiles` again when a machine's servers, shared profiles or state change what profiles show |
| `GET /api/profiles` | Yours (members on another machine as `pc/` ids, with `unavailable`: the ones whose machine isn't connected) and this machine's shared ones, then each machine's shared ones (`machine`, `pc/` ids) |
| `POST /api/profiles/start`, `POST /api/servers/start` `{ ids, profile }` | In order across machines; results may have `machine`, `skipped` (machine not connected) and `note` (e.g. which accounts a remote server used) |

Every endpoint that takes a server id or name (start, stop, restart, remove, pin, hostname, wait, logs, runs, processes, the log streams, bulk start/stop, search) accepts `pc/<id>` or `pc/<name>` and is relayed. The profile endpoints (`/api/profiles`, `/update`, `/delete`, `/duplicate`, `/start`) take `pc/…` server refs for your profiles, and a profile shared on another machine by its `pc/` id (relayed there), as does `/api/layouts` (`scope: profile:pc/demo:Full stack`). A start relayed with `profile` sends it on only when it's a profile on that machine. `POST /api/search` also takes `machine` to search every server on that machine.

| Endpoint | What |
|---|---|
| `POST /api/start` `{ machine, dir, name?, command?, install?, setup?, port?, ready?, timeout?, vars?, cwd?, wait? }` | Create (or start) a server in a folder on that machine. The hub inspects `dir` there for its project root, then sends the machine its own `/api/start`; the hub's `root`, `clientCwd` and `env` are never sent. `{ machine, name }` or `{ name: "pc/web" }` starts a known server there (options like a new command apply to it). Answer: a StartResponse with a `pc/` server view. |
| `GET /api/inspect?machine=pc&dir=~/code/app` | The folder inspected there (paths are that machine's), plus `machine` and `urlTemplate` (`http://{host}:7780`, `{host}` being `<name>.pc.localhost`; absent while the proxy is off) |
| `GET /api/dirs?path=&hidden=1&limit=` | Subfolders of a folder on this machine: `{ path, parent?, home, dirs: [{ name, path, link?, package?, servedev?, git? }], hidden, truncated? }` plus the same markers for the folder itself. `~` and relative paths are from home; `..` is resolved, so `path` says where it really is. Hidden (unless `hidden=1`): dot-folders and `node_modules`. Files are never listed. 404 for a missing folder, 400 for a file, 403 when unreadable. |
| `GET /api/dirs?machine=pc&path=` | The same on that machine (with `machine`); 501 when its servedev predates it | Types: `MachineSummary`, `SetupStep` and `RemoteServerView` in `src/remote/types.ts`.

## Limits

- No state is synced: your profiles live on the hub, a machine's own profiles and pins live on it. A machine's own (non-shared) profiles aren't shown on the hub.
- Your profiles' account picks only apply to servers on the hub; pick accounts for another machine's servers with a profile there.
- Each step of a profile start on another machine waits for that machine to report ready and for its port to be forwarded here (a couple of seconds on a WSL PC) before the next one starts.
- Remote servers' own custom hostnames (set on that machine) aren't routed by the hub's proxy; their hub hostname is `<server>.<machine>.localhost`.
- From the hub you can't track a folder on another machine without starting something (`servedev add` / Add project are local); the New server dialog still lists a folder's `servedev.json` servers there and starts them.
- POSIX machines need a login shell that runs POSIX scripts (bash, zsh; not fish).
- servedev itself doesn't run on Windows outside WSL.
