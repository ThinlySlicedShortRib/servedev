# Roadmap

What we want to add, explore or improve. Add items freely; move them down as they progress, and to **Done** (with the date) when they ship. One line each is enough; link an issue or a longer note when an item needs one.

Principle: agents add and edit most servers, and they already know the commands. Keep detection simple and make it easy for agents (MCP tools) and people (dashboard) to say exactly what to run.

## Next

Committed to; roughly in order.

- **Native Windows (no WSL).** [Plan](plans/windows.md). Phase 0 (platform layer) in progress; phases 1–3 wait on the open decisions in the plan.

## Improvements

Things that work but could work better.

- **The dashboard after a dev daemon starts without a build.** If `ui/dist/index.html` is missing when dev mode starts, building it later doesn't reload the daemon (bun only watches files it loaded); the fallback page says to restart.
- **`remote update` needs npm to rebuild a machine's dashboard.** A machine with bun but no npm keeps the old dashboard and gets a note.

## Explore

Ideas to look into before deciding.

- **Managing environments.** Designs to react to: [environments & one-time scripts](https://claude.ai/artifact/1TrXeRERg79LpA4ZUo7xZL) (layered variables on a server; named environments with `.env` files). See and edit a server's variables in one place (only `env` set on purpose is stored today; the rest comes from the login shell), and maybe named sets (dev / staging / prod) or `.env` files to switch between.
- **One-time scripts.** Designs on the same canvas (scripts with run history; scripts as steps in a profile). Easy to add and run commands that finish (migrations, seeds, codegen, a test run) next to the servers, and easy to see how each run went: exit code, duration, output, past runs.
- **Tags.** Add or remove the tags a server carries, beyond the built-in ones (branch, accounts, machine), to group and filter servers.
- **Signed requests and per-key permissions.** Only if servedev connects without SSH; see the security section of the [Windows plan](plans/windows.md).
- **Forwarding other ports from a machine on request.** Only dev servers are forwarded now; maybe a per-machine list of extra ports (databases, tools) for what the old `pc-ports` script used to cover.
- **Run the daemon from source on every machine?** The PC runs `src/cli.ts` with Bun, the Mac a compiled binary; pick one way, or make both update the same way.

## Done

- 2026-10-07: A rebuild never removes the dashboard file, so dev mode survives `bun run build`; a daemon with no dashboard build serves a short page instead of failing.
- 2026-10-07: `servedev remote update` rebuilds a source checkout's own dashboard when `ui/` changed (with `npm ci`, so the checkout stays clean).
- 2026-10-07: A stop command keeps the run's account variables across a daemon restart (saved only while the run lasts, readable only by you).
- 2026-10-07: Hubs with the same hostname are told apart by a hub id.
- 2026-10-07: Dashboard lint at zero.
- 2026-10-06: Agents are told every dev server goes through servedev unless the user says otherwise (MCP instructions, `start_server`, the CLAUDE.md snippet).
- 2026-10-06: Linux/WSL: ports of processes lsof leaves out (Next 16's `next-server (v…)`) are found with `ss`.
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
