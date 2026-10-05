/** Minimal MCP server (JSON-RPC 2.0 over newline-delimited stdio) exposing servedev operations as tools. */
import path from "node:path";
import {
  opAutostart,
  opBulk,
  opConfig,
  opGetGrid,
  opEdit,
  opHostname,
  opInspect,
  opList,
  opLogs,
  opPin,
  opProfile,
  opProfiles,
  opRemove,
  opRemoveProject,
  opRestart,
  opRuns,
  opSaveGridAsProfile,
  opSearch,
  opSetGrid,
  opStart,
  opStatus,
  opStop,
  opStopHung,
  opStopOutside,
  opTakeOver,
  opUpdateGrid,
  opResetGrid,
  opConfigStatus,
  opWhere,
  opAddProject,
  opSetup,
  opAccounts,
  opSave,
  opAccountUse,
  opAccountAction,
  opAccountAdd,
  opAccountCatalog,
  opAccountRemove,
  opAccountTest,
  opDirs,
  type OpResult,
} from "./ops";
import { opRemoteList, opRemoteReconnect } from "./remote/ops";
import { api } from "./client";
import { VERSION } from "./paths";

const cwdProp = {
  cwd: { type: "string", description: "Project directory (defaults to the directory the MCP server was launched in)." },
};

const serverRef = { type: "string", description: 'Server name in this project, or a full id like "keel-review:dev" (or "pc/demo:api" on another machine).' };
const machineProp = {
  machine: {
    type: "string",
    description: 'Another machine whose servedev this one relays (see list_machines), e.g. "pc"; `name` is then a server there. Same as giving the id as "pc/<id>".',
  },
};
const serverList = {
  type: "array",
  items: { type: "string" },
  description: 'Server names (in this project) or ids like "keel-review:dev"; another machine\'s as "pc/demo:api" (or "pc/api" when the name is unique there).',
};
const profileRef = {
  type: "string",
  description:
    'Profile name (case-insensitive), or its id from list_profiles: "local:<name>" for the user\'s own, "<project>:<name>" for one shared in a repo\'s servedev.json (needed when several worktrees share one by the same name), "pc/<project>:<name>" for one shared in a repo on another machine.',
};
const gridProfile = {
  type: "string",
  description: "Profile whose grid to use. Omit for the unsaved grid (the dashboard's Custom grid view with no profile selected).",
};
const accountPicks = {
  type: "object",
  description:
    'Accounts the profile\'s servers on this machine use instead of this machine\'s, by provider id then field, e.g. {"gcloud": {"account": "me@x.com", "project": "my-proj"}, "github": {"user": "me"}}. ' +
    "A provider set to null goes back to this machine's accounts. Providers and fields are listed by list_accounts. Servers on other machines use the accounts their own machine resolves.",
  additionalProperties: { anyOf: [{ type: "object", additionalProperties: { type: "string" } }, { type: "null" }] },
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });

export const TOOLS = [
  // ---------- servers ----------
  {
    name: "start_server",
    description:
      "Start a dev server in the background and wait until it is ready; returns its URL, or the error and last log lines if it fails. " +
      "Idempotent: if a server with this name is already running it is returned as-is. " +
      "Without `command`, uses servedev.json or the package.json dev script. Also restarts a known, stopped server by name. " +
      "With `machine`, it runs on that machine (defined and owned there, in `dir`, a folder there) and its URL is forwarded here.",
    inputSchema: obj({
      name: { type: "string", description: 'Server name, e.g. "web" or "api". Defaults to the only configured server, or "dev".' },
      dir: { type: "string", description: "Folder to run it in (default: cwd). With machine: a folder on that machine, absolute or ~/... (needed to create a server there)." },
      ...machineProp,
      command: { type: "string", description: 'Shell command, e.g. "npm run dev". May contain {port}.' },
      hostname: { type: "string", description: 'Custom hostname served by servedev\'s proxy, e.g. "keel.localhost" -> http://keel.localhost.' },
      install: { type: "boolean", description: "Run the package manager install (e.g. pnpm install) before starting. Use when dependencies are missing." },
      setup: { type: "string", description: 'Command to run before the server on every start, e.g. "pnpm install && pnpm db:migrate".' },
      stop: { type: "string", description: 'Command to run first when it\'s stopped or restarted, e.g. "docker compose down"; signals stop whatever is left.' },
      port: { description: 'Port number or "auto" to pick a free one (exported as $PORT).', anyOf: [{ type: "number" }, { type: "string", enum: ["auto"] }] },
      ready_log: { type: "string", description: "Regex; ready when log output matches (instead of waiting for a port)." },
      ready_url: { type: "string", description: 'URL or path like "/health"; ready when it answers with status < 500.' },
      no_ready_check: { type: "boolean", description: "Consider ready as soon as it spawns (workers, watchers)." },
      timeout: { type: "number", description: "Seconds to wait for readiness (default 60)." },
      restart: { type: "boolean", description: "Restart if already running." },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description: 'Variables kept with the server, e.g. {"DEBUG": "1"}; "" removes one. Everything else comes from the user\'s login shell.',
      },
      profile: { type: "string", description: 'Run with this profile\'s accounts (see list_accounts); "none" for this machine\'s. Default: the profile it last ran with.' },
      ...cwdProp,
    }),
  },
  {
    name: "list_servers",
    description:
      "List dev servers with status, URL, pid and uptime, plus servers running outside servedev (started from a terminal or another tool), " +
      "which explain why a port may already be taken. Servers on other machines have ids like pc/demo:api and a machine field.",
    inputSchema: obj({ all: { type: "boolean", description: "Include servers from all projects (and other machines' servers, with a MACHINE column)." }, machine: { type: "string", description: 'Another machine this servedev relays (servedev remote ls), e.g. "pc": only its servers, ids like pc/demo:api.' }, ...cwdProp }),
  },
  {
    name: "server_status",
    description: "Details about one server (status, ports, command, exit code, process groups), its recent earlier runs with ids, and its latest log lines.",
    inputSchema: obj({ name: serverRef, ...machineProp, ...cwdProp }),
  },
  {
    name: "restart_server",
    description: "Restart a server and wait until it is ready. Also how a server picks up changed accounts.",
    inputSchema: obj({
      name: serverRef,
      profile: { type: "string", description: 'Run with this profile\'s accounts; "none" for this machine\'s. Default: the ones it last ran with.' },
      ...machineProp,
      ...cwdProp,
    }),
  },
  {
    name: "stop_server",
    description: "Stop a server (its whole process tree). Pass all=true to stop every server in this project (with machine: everything running on that machine).",
    inputSchema: obj({ name: serverRef, all: { type: "boolean" }, ...machineProp, ...cwdProp }),
  },
  {
    name: "save_server_config",
    description:
      "Write a server (command, setup, folder, port, ready check, hostname, variables set on purpose) into its repo's servedev.json, " +
      "so it's shared through git and teammates can run `servedev up`. Secret-looking variables are left out unless include_secrets. " +
      "With dry_run, only shows what would change. Replacing a different existing entry needs force.",
    inputSchema: obj({
      name: serverRef,
      force: { type: "boolean", description: "Replace an existing entry with the same name that differs." },
      dry_run: { type: "boolean" },
      include_secrets: { type: "boolean", description: "Also write secret-looking variables (they'd be committed to git)." },
      ...cwdProp,
    }),
  },
  {
    name: "remove_server",
    description: "Stop a server and forget it: removes it from servedev (the dashboard's Forget), including its logs and run history.",
    inputSchema: obj({ name: serverRef, ...machineProp, ...cwdProp }, ["name"]),
  },
  {
    name: "remove_project",
    description:
      "Remove a tracked folder (project) from servedev: stops and forgets every server in it, with their logs and history. Files on disk are not touched. " +
      "Only when the user asked for it.",
    inputSchema: obj({
      project: { type: "string", description: 'Project name as list_servers shows it, e.g. "feat-horizon-ai-file-cards".' },
      path: { type: "string", description: "Or a folder inside the project (default: cwd)." },
      ...cwdProp,
    }),
  },
  {
    name: "pin_server",
    description:
      "Pin or unpin a server. Pinned servers sit at the top of the dashboard and start automatically when the user logs in (macOS). " +
      "A server on another machine (pc/...) is pinned on that machine, in its own config: it starts whenever servedev starts there.",
    inputSchema: obj({ name: serverRef, pinned: { type: "boolean", description: "false to unpin (default true)." }, ...cwdProp }, ["name"]),
  },
  {
    name: "set_hostname",
    description:
      'Give a server a custom URL like http://keel.localhost (servedev proxies it to the server\'s current port), or remove it. ' +
      "*.localhost names work without any setup.",
    inputSchema: obj({ name: serverRef, hostname: { type: "string", description: 'e.g. "keel.localhost". Omit or empty to remove.' }, ...cwdProp }, ["name"]),
  },
  {
    name: "edit_server",
    description:
      "Change how a server starts and stops without starting it: its command, its setup step (runs before the command on every start) " +
      "and its stop command (runs first when it's stopped or restarted). " +
      "Kept in your config.json, on top of the repo's servedev.json if it defines the server. A running server keeps its old command " +
      "until restarted; pass restart=true to restart it now.",
    inputSchema: obj(
      {
        name: serverRef,
        command: { type: "string", description: 'e.g. "pnpm --filter web dev". May contain {port}.' },
        setup: { type: "string", description: 'e.g. "pnpm install". Empty string removes it.' },
        stop: { type: "string", description: 'Runs first when it\'s stopped or restarted, e.g. "docker compose down"; signals stop whatever is left. Empty string removes it.' },
        restart: { type: "boolean", description: "Restart it now if it's running." },
        ...cwdProp,
      },
      ["name"],
    ),
  },
  {
    name: "inspect_folder",
    description:
      "What servedev would do for a folder before starting a server there: project, detected dev command, dependency install state, " +
      "servers defined in servedev.json, and a suggested name. With machine, a folder on that machine.",
    inputSchema: obj({ path: { type: "string", description: "Folder (absolute, ~/..., or relative to cwd). Defaults to cwd. On a machine: absolute or ~/... there." }, ...machineProp, ...cwdProp }),
  },
  {
    name: "list_folders",
    description: "Subfolders of a folder, marking which hold package.json, servedev.json or a git repo; for finding a project folder, mainly on another machine. Names only, never file contents.",
    inputSchema: obj({
      path: { type: "string", description: "Folder (default: home on a machine, cwd here)." },
      hidden: { type: "boolean", description: "Include dot-folders and node_modules." },
      ...machineProp,
      ...cwdProp,
    }),
  },
  // ---------- logs ----------
  {
    name: "server_logs",
    description: "Read a server's logs. Output is bounded; prefer `grep` and `since` over large `lines`, or search_logs.",
    inputSchema: obj({
      name: serverRef,
      lines: { type: "number", description: "Number of lines from the end (default 50)." },
      grep: { type: "string", description: "Case-insensitive regex filter." },
      since: { type: "string", description: 'Only output from the last duration, e.g. "30s", "5m".' },
      previous_run: { type: "boolean", description: "Read the log of the previous run (useful after a crash + restart)." },
      run: { type: "number", description: "Read a specific earlier run by id (see server_runs)." },
      ...machineProp,
      ...cwdProp,
    }),
  },
  {
    name: "search_logs",
    description:
      "Search dev server logs across all servers in the project in one call, with context lines around each match " +
      "(grep -n -C format: `120:` is a match, `121-` is context). Use preset='errors' to find what's broken without writing a regex. " +
      "Prefer this over server_logs when looking for errors, stack traces, or a specific message.",
    inputSchema: obj({
      query: { type: "string", description: "Case-insensitive regex (invalid regex is matched literally). Omit when using preset." },
      preset: { type: "string", enum: ["errors", "warnings"], description: "Built-in pattern for errors (exceptions, ERR_* codes, missing modules, tracebacks, non-zero exits) or warnings." },
      servers: { ...serverList, description: "Servers to search. Default: all servers in the project." },
      all_projects: { type: "boolean", description: "Search servers in every project." },
      machine: { type: "string", description: 'Another machine this servedev relays (servedev remote ls), e.g. "pc": only its servers, ids like pc/demo:api.' },
      since: { type: "string", description: 'Only output from the last duration, e.g. "2m" (current run only).' },
      context: { type: "number", description: "Lines of context around each match (default 2). Raise it for long stack traces." },
      limit: { type: "number", description: "Max matches per server log, keeping the most recent (default 20)." },
      runs: {
        type: "string",
        enum: ["current", "previous", "both", "all"],
        description: "Which runs to search: the current run (default), the one before the last restart, both, or all runs still kept (7 days by default).",
      },
      ...cwdProp,
    }),
  },
  {
    name: "server_runs",
    description: "Run history of a server: each start with when it started, how it ended, how long it took to be ready, and whether its log is still kept.",
    inputSchema: obj({ name: serverRef, limit: { type: "number", description: "How many runs (default 20)." }, ...machineProp, ...cwdProp }),
  },
  // ---------- other machines ----------
  {
    name: "list_machines",
    description:
      "Other machines this servedev relays (each runs its own servedev, reached over SSH): connection state, system, servedev version, " +
      "server counts and forwarded ports. Their servers have ids like pc/demo:api and open here at http://<server>.<machine>.localhost.",
    inputSchema: obj({}),
  },
  {
    name: "reconnect_machine",
    description: "Reconnect to a machine now (instead of waiting for the next retry), re-running the connection checklist; reports each step.",
    inputSchema: obj({ machine: { type: "string" } }, ["machine"]),
  },
  // ---------- several servers ----------
  {
    name: "start_servers",
    description:
      "Start several servers one after another (each waits until the previous is ready), like the dashboard's Start all. " +
      "Choose a profile, a list of servers, or all=true for every tracked server. Running servers are left alone.",
    inputSchema: obj({ profile: profileRef, servers: serverList, all: { type: "boolean", description: "Every server servedev tracks." }, ...cwdProp }),
  },
  {
    name: "stop_servers",
    description:
      "Stop several servers, like the dashboard's Stop all: a profile, a list of servers, or all=true for EVERY tracked server " +
      "(across all projects; only when the user asked for that).",
    inputSchema: obj({ profile: profileRef, servers: serverList, all: { type: "boolean", description: "Every server servedev tracks." }, ...cwdProp }),
  },
  // ---------- profiles ----------
  {
    name: "list_profiles",
    description:
      "List profiles with their servers in start order. Two kinds: the user's own (in ~/.servedev/config.json, any servers from any project, on this machine or another one) " +
      "and shared ones (in a repo's servedev.json, committed for everyone on the repo; one per worktree, tagged with its branch). On a hub, profiles shared in repos on " +
      "another machine are listed too (ids \"pc/<project>:<name>\"); they start that machine's servers.",
    inputSchema: obj({}),
  },
  {
    name: "create_profile",
    description:
      "Create a profile from servers (in start order), or from whatever is running now. By default it's the user's own, and it can mix machines " +
      '(e.g. ["pc/demo:api", "web"]: each starts on its own machine, in order). shared=true puts it in the ' +
      "project's servedev.json for the whole team (servers must all be from that project on this machine; personal accounts like emails stay out of it). " +
      "To also arrange them on a grid, use set_grid with the profile afterwards.",
    inputSchema: obj(
      {
        name: { type: "string" },
        servers: serverList,
        from_running: { type: "boolean", description: "Use every server running now." },
        accounts: accountPicks,
        shared: { type: "boolean", description: "Put it in the repo's servedev.json (commit it to share)." },
        project: { type: "string", description: "For shared: the project (defaults to the servers' project)." },
        description: { type: "string" },
        ...cwdProp,
      },
      ["name"],
    ),
  },
  {
    name: "share_profile",
    description:
      "Move one of the user's own profiles into its repo's servedev.json so everyone on the repo gets it. Servers only defined in the user's config are " +
      "written to servedev.json too (credentials and machine paths left out). Account picks naming a person stay in the user's config. Tell the user to commit servedev.json.",
    inputSchema: obj({ name: profileRef, project: { type: "string", description: "Only needed if unclear." } }, ["name"]),
  },
  {
    name: "duplicate_profile",
    description: "Copy a profile (typically a shared one) as the user's own, to change freely without touching the repo.",
    inputSchema: obj({ name: profileRef, new_name: { type: "string" } }, ["name"]),
  },
  {
    name: "update_profile",
    description:
      "Change a profile: rename it, replace its servers (the given order becomes the start order), add/remove servers, " +
      "or pick the platform accounts its servers use (merged with its current picks). Running servers apply new accounts when restarted.",
    inputSchema: obj(
      {
        name: profileRef,
        rename: { type: "string" },
        accounts: { ...accountPicks, description: accountPicks.description + " For a shared profile these are the user's own picks (kept in their config)." },
        needs: {
          ...accountPicks,
          description:
            'Shared profiles only: what its servers need, written to servedev.json for everyone, e.g. {"gcloud": {"project": "acme-dev"}}. Never put personal accounts (emails) here. null removes a provider.',
        },
        skip: { ...serverList, description: "Shared profiles only: servers the user doesn't start with it (their own choice, kept in their config). [] clears." },
        description: { type: "string" },
        servers: { ...serverList, description: "New full list of servers, in start order." },
        add: serverList,
        remove: serverList,
        ...cwdProp,
      },
      ["name"],
    ),
  },
  {
    name: "delete_profile",
    description: "Delete a profile and its grid. Its servers are not touched. A shared profile is removed from servedev.json (for everyone once committed), so only when asked.",
    inputSchema: obj({ name: profileRef }, ["name"]),
  },
  {
    name: "start_profile",
    description:
      "Start every server in a profile, in order, waiting for each (on whichever machine each is on). Servers not in the profile keep running. " +
      "Servers on a machine that isn't connected are skipped, and the result says so.",
    inputSchema: obj({ name: profileRef }, ["name"]),
  },
  // ---------- grid ----------
  {
    name: "get_grid",
    description:
      "Show a custom grid (the dashboard's Custom grid view): which servers have tiles and where, on a 12-column grid. " +
      "Tiles in reading order (top to bottom, left to right) are a profile's start order.",
    inputSchema: obj({ profile: gridProfile }),
  },
  {
    name: "set_grid",
    description:
      "Lay out a custom grid, replacing its tiles. Simplest: `servers` plus `columns` (1-4; tiles fill left to right, top to bottom). " +
      "Or give exact `tiles` (x 0-11, w 1-12 with x + w <= 12, y and h in rows of ~44px; a normal tile is 6 wide, 9 high). " +
      "Servers can be on other machines (pc/...), on the unsaved grid and the user's own profiles' grids; a shared profile's grid holds its own repo's servers. " +
      "For the user's own profile this also sets its servers and start order. For a shared profile it saves the user's own arrangement " +
      "(repo=true instead makes it the default layout in servedev.json for everyone). The dashboard updates live.",
    inputSchema: obj({
      profile: gridProfile,
      repo: { type: "boolean", description: "Shared profile: save as the repo's default layout (servedev.json)." },
      servers: serverList,
      columns: { type: "number", description: "Tiles per row when laying out `servers` (default 2)." },
      height: { type: "number", description: "Tile height in rows when laying out `servers` (default 9)." },
      tiles: {
        type: "array",
        description: "Exact placement instead of servers/columns.",
        items: obj(
          { server: serverRef, x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
          ["server", "x", "y", "w", "h"],
        ),
      },
      ...cwdProp,
    }),
  },
  {
    name: "update_grid",
    description: "Change a custom grid without replacing it: add servers (placed at the bottom), remove tiles (servers keep running), or move/resize tiles.",
    inputSchema: obj({
      profile: gridProfile,
      add: serverList,
      remove: serverList,
      move: {
        type: "array",
        items: obj({ server: serverRef, x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } }, ["server"]),
      },
      ...cwdProp,
    }),
  },
  {
    name: "save_grid_as_profile",
    description: "Save the unsaved grid as a new profile, keeping its layout (the dashboard's Save as profile). The unsaved grid is then emptied.",
    inputSchema: obj({ name: { type: "string" } }, ["name"]),
  },
  // ---------- servers started outside servedev ----------
  {
    name: "take_over_server",
    description:
      "Take over a dev server running outside servedev (listed by list_servers): stop it and start the same command in the same folder " +
      "under servedev, so it gets logs, restarts and history. It's briefly down. Only when the user wants that.",
    inputSchema: obj({
      id: { type: "string", description: 'Its id from list_servers, e.g. "ext:10022".' },
      port: { type: "number", description: "Or the port it listens on." },
      name: { type: "string", description: "Name to give it (default: suggested from its command)." },
      command: { type: "string", description: "Command to run instead of the one it was started with." },
    }),
  },
  {
    name: "stop_outside_server",
    description: "Stop a dev server running outside servedev (e.g. one left behind from a deleted worktree), by id or port. Only its own processes are stopped.",
    inputSchema: obj({ id: { type: "string" }, port: { type: "number" } }),
  },
  {
    name: "stop_hung_servers",
    description:
      "Stop hung servers: dev servers still running from folders that were deleted (typically removed git worktrees), which can't be taken over. " +
      "list_servers marks them as 'folder deleted'. Pass ids to stop only some.",
    inputSchema: obj({ ids: { type: "array", items: { type: "string" }, description: 'Ids from list_servers, e.g. "ext:2423". Default: all hung servers.' } }),
  },
  // ---------- settings ----------
  {
    name: "reset_grid",
    description: "Drop the user's own arrangement of a shared profile's grid, going back to the default layout from servedev.json.",
    inputSchema: obj({ profile: profileRef }, ["profile"]),
  },
  // ---------- configuration files ----------
  {
    name: "config_status",
    description:
      "Where servedev's configuration lives (~/.servedev/config.json for the user's setup, each repo's servedev.json for shared servers and profiles) " +
      "and any problems: syntax errors (with file:line; servedev keeps using the last good version), unknown servers in profiles, emails in shared files. " +
      "Both files are JSON with comments, watched live: editing them directly is fine.",
    inputSchema: obj({}),
  },
  {
    name: "where_defined",
    description: "Which file defines a server or profile, i.e. where an edit to it goes (repo servedev.json, the user's config.json, or both).",
    inputSchema: obj({ name: { type: "string", description: "Server name/id or profile name/id." }, ...cwdProp }, ["name"]),
  },
  {
    name: "add_project",
    description: "Track a folder without starting anything: its servedev.json's servers and shared profiles show up (in the dashboard too).",
    inputSchema: obj({ path: { type: "string", description: "Folder (default: cwd)." }, ...cwdProp }),
  },
  {
    name: "setup_machine",
    description:
      "On a new machine where ~/.servedev/config.json was copied over (e.g. from dotfiles): find each project's repo here by git remote and report " +
      "what moved, what isn't cloned, and which profiles' accounts need signing in. Preview by default; apply=true updates the paths.",
    inputSchema: obj({
      apply: { type: "boolean" },
      map: { type: "object", additionalProperties: { type: "string" }, description: 'project (or remote, or folder name) -> path, e.g. {"capcon-apps": "~/code/capcon-apps"}' },
      roots: { type: "array", items: { type: "string" }, description: "Extra folders to look in." },
    }),
  },
  { name: "get_settings", description: "servedev settings: log retention, proxy port, and whether it starts at login.", inputSchema: obj({}) },
  {
    name: "list_accounts",
    description:
      "This machine's platform accounts (Google Cloud CLI account, project and app credentials/ADC; GitHub; plus any user-added providers): " +
      "current values, options, warnings and available actions. Profiles can pick different accounts for their servers (update_profile accounts).",
    inputSchema: obj({ provider: { type: "string", description: 'Only this provider, e.g. "gcloud".' }, refresh: { type: "boolean", description: "Re-read provider files and skip caches." } }),
  },
  {
    name: "switch_account",
    description:
      "Switch this machine's account for a platform, e.g. the gcloud CLI account or project, or the active gh account. " +
      "Affects every terminal and tool on the machine, so only when the user asked. To change accounts for some servers only, set a profile's accounts instead.",
    inputSchema: obj(
      {
        provider: { type: "string", description: 'Provider id, e.g. "gcloud" or "github".' },
        values: { type: "object", additionalProperties: { type: "string" }, description: 'Field id to value, e.g. {"account": "me@x.com", "project": "my-proj"}.' },
      },
      ["provider", "values"],
    ),
  },
  {
    name: "run_account_action",
    description:
      'Run a provider action listed by list_accounts, e.g. gcloud "sign-in-apps" (opens a browser sign-in and saves app credentials for an account, so profiles can use it) ' +
      'or "use-apps" (make an account\'s saved app credentials this machine\'s ADC). Interactive ones wait for the user in the browser.',
    inputSchema: obj(
      {
        provider: { type: "string" },
        action: { type: "string" },
        args: { type: "object", additionalProperties: { type: "string" }, description: 'e.g. {"account": "me@x.com"}' },
      },
      ["provider", "action"],
    ),
  },
  {
    name: "list_account_catalog",
    description:
      "Platforms that can be added to servedev's accounts (AWS, Docker, Kubernetes, ...), with whether each one's CLI is installed and whether it's already added.",
    inputSchema: obj({}),
  },
  {
    name: "add_account_provider",
    description:
      "Add a platform to servedev's accounts: a catalog entry by id, or a custom provider spec (JSON, see docs/providers.md: id, name, requires, " +
      "fields with list/current/set shell commands, env templates). Writes ~/.servedev/providers/<id>.json. Run test_account_provider on a custom spec first.",
    inputSchema: obj({
      catalog: { type: "string", description: 'Catalog id, e.g. "aws". Use this or spec.' },
      spec: { type: "object", description: "A custom provider spec." },
      replace: { type: "boolean", description: "Overwrite a provider with the same id that you added before." },
      override: { type: "boolean", description: "Replace a built-in provider (gcloud, github) with this one. Only when the user asked." },
    }),
  },
  {
    name: "test_account_provider",
    description:
      "Dry-run a provider spec without saving it: validates it, checks its CLI is installed, runs each field's current and list commands, and previews the env " +
      "a profile's servers would get (values masked). Never switches anything.",
    inputSchema: obj(
      {
        spec: { type: "object", description: "The provider spec to try." },
        selection: { type: "object", additionalProperties: { type: "string" }, description: "Field values for the env preview (default: the current values)." },
      },
      ["spec"],
    ),
  },
  {
    name: "remove_account_provider",
    description: "Remove a platform the user added (a JSON file in ~/.servedev/providers). Built-in providers can't be removed. Profiles lose their picks for it.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "update_settings",
    description: "Change servedev settings.",
    inputSchema: obj({
      log_retention_days: { type: "number", description: "Delete logs of runs that stopped more than this many days ago (default 7)." },
      proxy_port: { type: "number", description: "Port for custom hostnames (default 80, falls back to 7780)." },
      dashboard_hostname: { type: "string", description: 'Hostname for the dashboard (default "servedev.localhost").' },
      autostart: { type: "boolean", description: "Start the daemon and pinned servers at login (macOS)." },
    }),
  },
];

type Args = Record<string, any>;

/** A server reference with an optional machine: "api" + machine "pc" -> "pc/api". */
export function machineRef(name: unknown, machine: unknown): string | undefined {
  const n = typeof name === "string" && name ? name : undefined;
  if (typeof machine !== "string" || !machine) return n;
  if (!n) throw new Error(`pass the server's name on ${machine}`);
  if (n.includes("/")) {
    if (!n.startsWith(`${machine}/`)) throw new Error(`${n} isn't on ${machine}`);
    return n;
  }
  return `${machine}/${n}`;
}

export async function callTool(name: string, a: Args): Promise<OpResult> {
  const cwd = a.cwd ? path.resolve(a.cwd) : process.cwd();
  const ref = () => machineRef(a.name, a.machine);
  switch (name) {
    case "start_server":
      return opStart({
        cwd,
        name: a.name,
        machine: a.machine || undefined,
        folder: a.dir,
        command: a.command,
        setup: a.setup,
        stop: a.stop,
        install: a.install,
        hostname: a.hostname,
        port: a.port,
        ready: a.no_ready_check ? { mode: "none" } : a.ready_log || a.ready_url ? { log: a.ready_log, url: a.ready_url } : undefined,
        timeout: a.timeout,
        restart: a.restart,
        profile: a.profile,
        env: a.env,
      });
    case "list_servers":
      return opList({ cwd, all: a.all, machine: a.machine });
    case "server_status":
      return opStatus({ cwd, name: ref() });
    case "restart_server":
      return opRestart({ cwd, name: ref(), profile: a.profile });
    case "stop_server":
      if (a.machine && a.all && !a.name) return opStop({ cwd, names: [], all: true, machine: a.machine });
      return opStop({ cwd, names: a.name ? [ref()!] : [], all: a.all });
    case "save_server_config":
      return opSave({ cwd, name: a.name, force: a.force, dryRun: a.dry_run, includeSecrets: a.include_secrets });
    case "remove_server":
      return opRemove({ cwd, name: ref()! });
    case "remove_project":
      return opRemoveProject({ cwd, project: a.project, path: a.path });
    case "pin_server":
      return opPin({ cwd, name: a.name, pinned: a.pinned !== false });
    case "set_hostname":
      return opHostname({ cwd, name: a.name, hostname: a.hostname || undefined, clear: !a.hostname });
    case "edit_server":
      return opEdit({ cwd, name: ref()!, command: a.command, setup: a.setup, stop: a.stop, restart: a.restart });
    case "inspect_folder":
      return opInspect({ cwd, path: a.path, machine: a.machine || undefined });
    case "list_folders":
      return opDirs({ cwd, path: a.path, machine: a.machine || undefined, hidden: a.hidden });
    case "list_machines":
      return opRemoteList();
    case "reconnect_machine":
      return opRemoteReconnect(String(a.machine ?? ""));
    case "server_logs":
      return opLogs({ cwd, name: ref(), tail: a.lines, grep: a.grep, since: a.since, prev: a.previous_run, run: a.run });
    case "search_logs":
      return opSearch({ cwd, query: a.query, preset: a.preset, servers: a.servers, machine: a.machine, all: a.all_projects, since: a.since, context: a.context, limit: a.limit, runs: a.runs });
    case "server_runs":
      return opRuns({ cwd, name: ref(), limit: a.limit });
    case "start_servers":
      return opBulk({ cwd, action: "start", profile: a.profile, servers: a.servers, all: a.all });
    case "stop_servers":
      return opBulk({ cwd, action: "stop", profile: a.profile, servers: a.servers, all: a.all });
    case "list_profiles":
      return opProfiles();
    case "create_profile":
      return opProfile({
        cwd,
        action: "create",
        name: a.name,
        servers: a.servers,
        running: a.from_running,
        accounts: a.accounts,
        shared: a.shared,
        project: a.project,
        description: a.description,
      });
    case "share_profile":
      return opProfile({ cwd, action: "share", name: a.name, project: a.project });
    case "duplicate_profile":
      return opProfile({ cwd, action: "duplicate", name: a.name, rename: a.new_name });
    case "reset_grid":
      return opResetGrid({ profile: a.profile });
    case "config_status":
      return opConfigStatus();
    case "where_defined":
      return opWhere({ cwd, name: a.name });
    case "add_project":
      return opAddProject({ cwd, path: a.path });
    case "setup_machine":
      return opSetup({ apply: a.apply, map: a.map, roots: a.roots });
    case "update_profile": {
      let r: OpResult | undefined;
      if (a.servers) r = await opProfile({ cwd, action: "set", name: a.name, servers: a.servers });
      if (a.add?.length) r = await opProfile({ cwd, action: "add", name: a.name, servers: a.add });
      if (a.remove?.length) r = await opProfile({ cwd, action: "remove", name: a.name, servers: a.remove });
      if (a.accounts) r = await opProfile({ cwd, action: "accounts", name: a.name, accounts: a.accounts });
      if (a.needs) r = await opProfile({ cwd, action: "needs", name: a.name, accounts: a.needs });
      if (a.skip) r = await opProfile({ cwd, action: "skip", name: a.name, servers: a.skip });
      if (a.description !== undefined) {
        await api("/api/profiles/update", { profile: a.name, description: a.description });
        r ??= await opProfiles();
      }
      if (a.rename) r = await opProfile({ cwd, action: "rename", name: a.name, rename: a.rename });
      if (!r) throw new Error("nothing to change: pass rename, servers, add, remove, accounts, needs, skip or description");
      return r;
    }
    case "delete_profile":
      return opProfile({ cwd, action: "delete", name: a.name });
    case "start_profile":
      return opProfile({ cwd, action: "start", name: a.name });
    case "get_grid":
      return opGetGrid({ profile: a.profile });
    case "set_grid":
      return opSetGrid({ cwd, profile: a.profile, servers: a.servers, columns: a.columns, height: a.height, tiles: a.tiles, repo: a.repo });
    case "update_grid":
      return opUpdateGrid({ cwd, profile: a.profile, add: a.add, remove: a.remove, move: a.move });
    case "save_grid_as_profile":
      return opSaveGridAsProfile({ name: a.name });
    case "take_over_server":
      return opTakeOver({ id: a.id, port: a.port, name: a.name, command: a.command });
    case "stop_hung_servers":
      return opStopHung({ ids: a.ids });
    case "stop_outside_server":
      return opStopOutside({ id: a.id, port: a.port });
    case "get_settings": {
      const [settings, auto] = await Promise.all([opConfig({}), opAutostart()]);
      return { ok: true, text: `${settings.text}\nautostart: ${auto.text}`, data: { settings: settings.data, autostart: auto.data } };
    }
    case "list_accounts":
      return opAccounts({ provider: a.provider, refresh: a.refresh });
    case "switch_account":
      return opAccountUse({ provider: a.provider, values: a.values ?? {} });
    case "run_account_action":
      return opAccountAction({ provider: a.provider, action: a.action, args: a.args });
    case "list_account_catalog":
      return opAccountCatalog();
    case "add_account_provider":
      if (!a.catalog && !a.spec) throw new Error("pass catalog (an id from list_account_catalog) or spec");
      return opAccountAdd({ catalog: a.catalog, spec: a.spec, replace: a.replace, override: a.override });
    case "test_account_provider":
      return opAccountTest({ spec: a.spec, selection: a.selection });
    case "remove_account_provider":
      return opAccountRemove(a.id);
    case "update_settings": {
      const out: string[] = [];
      if (a.log_retention_days !== undefined) out.push((await opConfig({ key: "log_retention_days", value: String(a.log_retention_days) })).text);
      if (a.proxy_port !== undefined) out.push((await opConfig({ key: "proxy_port", value: String(a.proxy_port) })).text);
      if (a.dashboard_hostname !== undefined) out.push((await opConfig({ key: "dashboard_hostname", value: String(a.dashboard_hostname) })).text);
      if (a.autostart !== undefined) out.push(`autostart: ${(await opAutostart(a.autostart)).text}`);
      if (!out.length) throw new Error("nothing to change: pass log_retention_days, proxy_port, dashboard_hostname or autostart");
      return { ok: true, text: out.join("\n") };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export async function runMcp() {
  const write = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

  const handle = async (msg: any) => {
    const { id, method, params } = msg;
    if (id === undefined) return; // notification
    try {
      let result: unknown;
      switch (method) {
        case "initialize":
          result = {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "servedev", version: VERSION },
            instructions:
              "Use these tools to run dev servers instead of running them in a shell (never foreground or `&`). " +
              "start_server is idempotent and waits until the server is ready. After code changes, run search_logs with preset='errors' " +
              "and since='1m' to check for errors instead of restarting; dev servers usually hot-reload. " +
              "Everything the servedev dashboard can do has a tool here: profiles, custom grids (get_grid/set_grid), pins, custom hostnames, " +
              "taking over servers started outside servedev, and settings. " +
              "Other machines (list_machines) run their own servedev: their servers have ids like pc/demo:api, server tools take `machine`, " +
              "and start_server with machine + dir creates a server in a folder there (find one with list_folders / inspect_folder).",
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools: TOOLS };
          break;
        case "tools/call": {
          try {
            const r = await callTool(params.name, params.arguments ?? {});
            result = { content: [{ type: "text", text: r.text }], isError: !r.ok };
          } catch (e) {
            result = { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
          }
          break;
        }
        default:
          return write({ id, error: { code: -32601, message: `method not found: ${method}` } });
      }
      write({ id, result });
    } catch (e) {
      write({ id, error: { code: -32603, message: (e as Error).message } });
    }
  };

  let buf = "";
  for await (const chunk of process.stdin) {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        void handle(JSON.parse(line));
      } catch {
        write({ id: null, error: { code: -32700, message: "parse error" } });
      }
    }
  }
}
