# Other machines

One servedev (the **hub**, usually your laptop) can show and control the servers of other machines that run servedev too: a desktop PC, a Linux box. Each machine stays the only source of truth for its own servers; the hub relays, it doesn't copy. If a machine goes away you still see its servers as they last were (marked *last known*), and anything you try to do to them fails with a clear error until it's back.

```sh
servedev remote add pc ariel@100.68.42.78   # connect and check, step by step
servedev ls --all                            # MACHINE column; pc's servers are pc/<project>:<name>
servedev logs api --on pc -f                 # --on <machine> for start, stop, restart, logs, status, search, ls
servedev restart pc/demo:api                 # or the full id, anywhere a server name goes
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

Every endpoint that takes a server id or name (start, stop, restart, remove, pin, hostname, wait, logs, runs, processes, the log streams, bulk start/stop, search) accepts `pc/<id>` or `pc/<name>` and is relayed. `POST /api/search` also takes `machine` to search every server on that machine. A remote server is started by id; defining a new one (a command) has to happen on its machine for now. Types: `MachineSummary`, `SetupStep` and `RemoteServerView` in `src/remote/types.ts`.

## Limits

- No state is synced: profiles, grids and pins can't include another machine's servers yet.
- Remote servers' own custom hostnames (set on that machine) aren't routed by the hub's proxy; their hub hostname is `<server>.<machine>.localhost`.
- POSIX machines need a login shell that runs POSIX scripts (bash, zsh; not fish).
- servedev itself doesn't run on Windows outside WSL.
