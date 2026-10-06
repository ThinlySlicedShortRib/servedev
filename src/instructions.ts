export const AGENT_INSTRUCTIONS = `## Dev servers (servedev)

Run every dev server through \`servedev\` unless the user explicitly says otherwise: web and API servers, watchers, workers, database proxies, \`docker compose up\`, Storybook, emulators, anything long-running. Don't start them in a shell (no foreground run, \`&\`, nohup, tmux or background shell task). Commands that finish (build, test, lint, migrations) run normally.
servedev runs each server in the background, waits until it is ready, and keeps logs. Before starting one, check \`servedev ls --all\`: if it's already running (in servedev or outside it), use it or offer to take it over rather than starting a second copy.

- \`servedev start [name] [-- <command>]\` — start (idempotent: returns the existing server if already running). Blocks until ready and prints the URL. With no command it uses servedev.json or the package.json \`dev\` script.
  - \`--install\` runs \`pnpm install\` / \`npm install\` first (use when start fails with missing modules or "command not found")
  - \`--port auto\` assigns a free port (sets $PORT and fills \`{port}\` in the command)
  - \`--ready-log <regex>\` / \`--ready-url /health\` / \`--ready none\` for servers that don't just open a port
- \`servedev ls\` — servers in this project with status, URL and pid
- \`servedev logs <name> [-n 50] [--grep error] [--since 2m]\` — read logs (bounded; prefer --grep/--since over large -n)
- \`servedev search --errors [--since 2m]\` / \`servedev search <regex> [-C 5]\` — search all servers' logs at once, with context lines
- \`servedev runs <name>\` / \`servedev logs <name> --run <id>\` — earlier runs are kept (7 days by default); \`search --history\` searches all of them
- \`servedev restart <name>\` / \`servedev stop <name>\` / \`servedev down\` (stop all in project)
- \`servedev up\` — start everything in servedev.json in dependency order

With the servedev MCP server connected, the same things (and profiles, custom grids, pins, custom hostnames, taking over servers started elsewhere) are tools; \`list_servers\` also shows servers running outside servedev, which explains a port that's already taken.

Config: servers and shared profiles live in the repo's \`servedev.json\` (JSON with comments; commit it to share, teammates get them on clone); the user's own servers, profiles, pins and settings live in \`~/.servedev/config.json\`. Both are watched live, so editing them directly is fine. \`servedev config status\` shows problems; \`servedev config where <name>\` says which file an edit goes to. Don't put personal accounts (emails) in servedev.json.

Cloud accounts: \`servedev account\` shows this machine's Google Cloud / GitHub accounts; a profile can give its servers other ones (\`servedev profile accounts <profile> gcloud.account=<email>\`) without changing the machine's. Other platforms (AWS, Docker, …) can be added with \`servedev account catalog\` / \`account add <id>\`, or a custom JSON provider (\`account test --file\` first). Don't switch the machine's accounts (\`account use\`) unless asked. If a server gets permission errors from Google or GitHub, check which account it ran with in \`servedev status <name>\`.

Environment: servers get a fresh login-shell environment at every start, plus only the variables set on purpose (\`--env KEY=VALUE\`, or \`env\` in servedev.json) — not the environment of the shell you run servedev in. To share a server with the team, \`servedev save <name>\` writes it into the repo's servedev.json (credentials in the command are stripped).

Other machines: ids like \`pc/demo:api\` are servers on another computer that runs its own servedev (\`servedev remote ls\`); they take the same commands (\`servedev logs api --on pc\`), and their URLs in \`servedev ls --all\` are forwarded to this machine (\`http://<server>.pc.localhost\`). To run a new server there: \`servedev start <name> --on pc --dir '~/code/app' [-- <command>]\` (the folder is a path on that machine; \`servedev dirs '~/code' --on pc\` lists folders there). It's defined on that machine, not here. In MCP tools, pass \`machine: "pc"\` (and \`dir\` for start_server). Your own profiles and grids can mix machines (\`servedev profile create "Full stack" pc/api web\`); starting one starts each server on its machine, in order, skipping machines that are offline. Pinning \`pc/api\` pins it on pc. When an error says pc runs an older servedev, \`servedev remote update pc\` updates it (ask the user first: it restarts servedev there).

After code changes, the dev server usually hot-reloads — check \`servedev search --errors --since 1m\` instead of restarting.
If start fails, the output includes the last log lines; fix the cause, then run start again.
Stop servers you started when you are done unless the user wants them left running.
`;
