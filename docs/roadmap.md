# Roadmap

What we want to add, explore or improve. Add items freely; move them down as they progress, and to **Done** (with the date) when they ship. One line each is enough; link an issue or a longer note when an item needs one.

Principle: agents add and edit most servers, and they already know the commands. Keep detection simple and make it easy for agents (MCP tools) and people (dashboard) to say exactly what to run.

## Next

Committed to; roughly in order.

- **Dev mode survives a rebuild.** `bun run build` briefly removes `ui/dist/index.html`; dev mode's `bun --watch` daemon reloads at that moment, fails to import it and stays down until the next file change (and with it the forwards of any machine it's connected to).

## Improvements

Things that work but could work better.

- **The rest of the dashboard lint (23).** Left on purpose for now: `react-refresh/only-export-components` (mostly shadcn files), `Date.now()` in render for relative times, and effects in `new-server-dialog.tsx`, `use-custom-grid.ts`, `line-copy.tsx`, `log-search.tsx` and `log-view.tsx` that need care to restructure.
- **Stop command after a daemon restart.** A server adopted by a new daemon runs its stop command without its profile's account variables (they aren't saved with the run).
- **`servedev remote update` and the machine's dashboard.** A machine that runs from source isn't rebuilt by an update; the report says to run `bun run build:ui` there when `ui/` changed.
- **Hubs with the same hostname** look like one hub to the two-hubs warning.

## Explore

Ideas to look into before deciding.

- **Managing environments.** See and edit a server's variables in one place (only `env` set on purpose is stored today; the rest comes from the login shell), and maybe named sets (dev / staging / prod) or `.env` files to switch between.
- **One-time scripts.** Easy to add and run commands that finish (migrations, seeds, codegen, a test run) next to the servers, and easy to see how each run went: exit code, duration, output, past runs.
- **Tags.** Add or remove the tags a server carries, beyond the built-in ones (branch, accounts, machine), to group and filter servers.
- **Windows without WSL.** servedev needs `lsof` today (macOS, Linux, WSL).
- **Forwarding other ports from a machine on request.** Only dev servers are forwarded now; maybe a per-machine list of extra ports (databases, tools) for what the old `pc-ports` script used to cover.
- **Run the daemon from source on every machine?** The PC runs `src/cli.ts` with Bun, the Mac a compiled binary; pick one way, or make both update the same way.

## Done

- 2026-10-05: Optional `stop` command per server (e.g. `docker compose down`), run before the stop signals; editable in the dashboard, `edit_server` and the CLI.
- 2026-10-05: `servedev edit <server>` in the CLI.
- 2026-10-05: `servedev remote update <machine>`: pull (and build) servedev there and restart its daemon; also a dashboard button and the `update_machine` MCP tool.
- 2026-10-05: Warning when another hub is connected to the same machine.
- 2026-10-05: A machine with an older servedev says so and how to update it, instead of a bare 404.
- 2026-10-05: A server's declared port decides its URL (dev mode shows its dashboard, 7779).
- 2026-10-05: Dashboard lint down from 42 to 23 problems (dialogs mount their form while open; state resets during render).
- 2026-10-04: New profiles start with the servers the sidebar lists while it's filtered.
- 2026-10-04: Dashboard at http://servedev.localhost (the `dashboard_hostname` setting picks another name).
- 2026-10-02: Dev mode (`bun run dev`): sandboxed daemon from source with `--watch`, dashboard on Vite with hot reload.
- 2026-10-02: Edit a server's command and setup step from the dashboard and the `edit_server` MCP tool (masked secrets are kept).
- 2026-10-02: Another machine's dev servers started outside servedev get their ports forwarded too; forwards keep the same port number when the server listens only on `::1`.
