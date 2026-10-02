# Roadmap

What we want to add, explore or improve. Add items freely; move them down as they progress, and to **Done** (with the date) when they ship. One line each is enough; link an issue or a longer note when an item needs one.

Principle: agents add and edit most servers, and they already know the commands. Keep detection simple and make it easy for agents (MCP tools) and people (dashboard) to say exactly what to run.

## Next

Committed to; roughly in order.

- **Optional `stop` command per server.** Run it first (e.g. `docker compose down`), then fall back to SIGTERM/SIGKILL if it fails or takes too long. Today every server stops by signals only (`src/manager.ts`, `stop`).
- **Updating servedev on another machine.** One command (`servedev remote update pc`) that pulls or installs the hub's version there and restarts its daemon. New endpoints (e.g. `/api/command`) only work on `pc/…` servers once the machine runs the same version.
- **Warn when two hubs connect to the same machine.** Both forward its ports and the second gets other port numbers; say which hub has it.

## Improvements

Things that work but could work better.

- **Dev mode shows the daemon's URL, not the dashboard's.** `servedev:dev` lists `localhost:7778` (the first port it saw) although it was started with `port: 7779`; the declared port should win.
- **Clear message for an older servedev on another machine.** Editing a `pc/…` server's command on an older version should say "update servedev on pc", not a bare 404.
- **CLI for editing a command.** `servedev edit <server> -- <command>` / `--setup`, matching the `edit_server` MCP tool and the dashboard.
- **Lint: setState in effects.** `hostname-dialog.tsx` and `server-detail.tsx` trip `react-hooks/set-state-in-effect`; `command-dialog.tsx` shows the fix (mount the form only while open).

## Explore

Ideas to look into before deciding.

- **Managing environments.** See and edit a server's variables in one place (only `env` set on purpose is stored today; the rest comes from the login shell), and maybe named sets (dev / staging / prod) or `.env` files to switch between.
- **One-time scripts.** Easy to add and run commands that finish (migrations, seeds, codegen, a test run) next to the servers, and easy to see how each run went: exit code, duration, output, past runs.
- **Tags.** Add or remove the tags a server carries, beyond the built-in ones (branch, accounts, machine), to group and filter servers.
- **Windows without WSL.** servedev needs `lsof` today (macOS, Linux, WSL).
- **Forwarding other ports from a machine on request.** Only dev servers are forwarded now; maybe a per-machine list of extra ports (databases, tools) for what the old `pc-ports` script used to cover.
- **Run the daemon from source on every machine?** The PC runs `src/cli.ts` with Bun, the Mac a compiled binary; pick one way, or make both update the same way.

## Done

- 2026-10-02: Dev mode (`bun run dev`): sandboxed daemon from source with `--watch`, dashboard on Vite with hot reload.
- 2026-10-02: Edit a server's command and setup step from the dashboard and the `edit_server` MCP tool (masked secrets are kept).
- 2026-10-02: Another machine's dev servers started outside servedev get their ports forwarded too; forwards keep the same port number when the server listens only on `::1`.
