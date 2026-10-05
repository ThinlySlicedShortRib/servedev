# Configuration

servedev keeps everything you configure in JSON files, and only what happens (runs, logs, pids) in its database. There are two config files with the same shape, read by one loader:

| File | Shared? | Holds |
|---|---|---|
| `<repo>/servedev.json` | Yes, through git | How to run the repo's servers, shared profiles, their default grids, what their servers need (e.g. a Google Cloud project) |
| `~/.servedev/config.json` | No, it's yours | Where your projects are, servers only you use, your own profiles, your changes to shared profiles, pins, settings, the unsaved grid |

Other files in `~/.servedev`:

| Path | What |
|---|---|
| `providers/*.json` | Account platforms you added (see [providers.md](providers.md)) |
| `credentials/gcloud/*.json` | Saved Google app credentials, readable only by you. Never shared. |
| `servedev.db` | State: runs, pids, ports, log markers, what each run started with. Deleting it loses history only. |
| `logs/` | One log file per run |
| `machines/` | Other machines: last known servers, SSH control sockets, and (off macOS) their API tokens, readable only by you. See [remote.md](remote.md). |

Both config files accept comments (JSONC) and have JSON Schemas for editor autocomplete: [`schema/servedev.schema.json`](../schema/servedev.schema.json) and [`schema/config.schema.json`](../schema/config.schema.json). The daemon also serves them at `http://127.0.0.1:7777/schema/<name>.json`.

## How they combine

For every server and profile, servedev merges, later winning:

1. built-in defaults
2. the repo's `servedev.json`
3. your `config.json`
4. your overrides of shared profiles

Every server and profile remembers where it came from. The dashboard tags shared profiles **Shared · repo** with the worktree's branch, and an edit is written to the file it came from.

## servedev.json (shared)

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/ThinlySlicedShortRib/servedev/main/schema/servedev.schema.json",
  "servers": {
    "cloud-sql-proxy": {
      "command": "cloud-sql-proxy --auto-iam-authn my-proj:us-central1:db --port=5433",
      "ready": { "log": "ready for new connections" }
    },
    "db": { "command": "docker compose up", "stop": "docker compose down", "port": 5432 },
    "api": { "command": "pnpm --filter api dev", "dependsOn": ["cloud-sql-proxy"] },
    "web": { "command": "pnpm --filter web dev", "port": 5173, "hostname": "web.localhost" }
  },
  "profiles": {
    "Full stack": {
      "description": "API and web against the dev database",
      "servers": ["cloud-sql-proxy", "api", "web"],      // start order
      "accounts": { "gcloud": { "project": "my-proj" } }, // needs, never a person's email
      "grid": [{ "i": "api", "x": 0, "y": 0, "w": 6, "h": 8 }, { "i": "web", "x": 6, "y": 0, "w": 6, "h": 8 }]
    }
  }
}
```

- `setup` runs before a server's command on every start; if it fails, the server doesn't start. `stop` runs first when it's stopped or restarted, in the server's folder with its environment and its output in the server's log; after it finishes (or fails, or runs past 30s) anything still running gets SIGTERM, then SIGKILL.
- A shared profile can only list its own repo's servers, never another machine's: each machine that has the repo starts its own with it.
- `accounts` says what the servers need, like a project. Personal accounts (emails) belong in your config; servedev warns when it finds one here.
- `grid` is the default layout. Everyone can rearrange it for themselves without changing the file.

## config.json (yours)

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/ThinlySlicedShortRib/servedev/main/schema/config.schema.json",
  "version": 1,
  "projects": {
    "my-app": { "path": "~/code/my-app", "remote": "github.com/acme/my-app" },
    "feat-login": { "path": "~/code/my-app-feat-login", "remote": "github.com/acme/my-app", "worktree": "feat/login" }
  },
  "servers": {
    "my-app": {
      "storybook": { "command": "pnpm storybook", "port": 6006 },  // only yours
      "api": { "env": { "LOG_LEVEL": "debug" } }                   // your changes to a shared one
    }
  },
  "profiles": {
    "Review": {
      "servers": ["my-app:api", "feat-login:web", "pc/shop:db"],   // across repos, worktrees and machines
      "accounts": { "gcloud": { "account": "me@example.com" } }   // for its servers on this machine
    }
  },
  "overrides": {
    "github.com/acme/my-app": {
      "Full stack": {                                              // applies in every worktree
        "accounts": { "gcloud": { "account": "me@example.com" } },
        "skip": ["cloud-sql-proxy"],
        "grid": [{ "i": "api", "x": 0, "y": 0, "w": 12, "h": 6 }]
      }
    }
  },
  "pinned": ["my-app:api"],
  "settings": { "log_retention_days": 14 },
  "machines": {
    "pc": { "ssh": "me@100.68.42.78", "kind": "wsl", "distro": "Ubuntu" }  // servedev remote add pc me@100.68.42.78
  }
}
```

- **Server ids** are `<project>:<name>`. The project name comes from `projects`, so local profiles keep working when a repo moves.
- **Overrides** are keyed by the repo's git remote (or `folder:<name>` without one) plus the profile name, so your accounts, skipped servers and grid apply in every worktree of the repo.
- **Your profiles and grids** can list another machine's servers by id (`pc/shop:db`); they start on that machine, in the profile's order. A ref to a machine or server that's gone stays in the file. A profile's `accounts` apply to its servers on this machine; another machine's servers use the accounts resolved there. See [remote.md](remote.md#profiles-grids-and-pins-across-machines).
- **Machines** are other computers running servedev whose servers this one shows and controls over SSH; their ids get the machine's name in front (`pc/my-app:api`). Only `ssh` is needed (`user@host`, `ssh://user@host:port`, or a Host from `~/.ssh/config`); `kind` (`posix` or `wsl`) and `distro` are detected when it connects and kept so you can see and change them. The machine's API token is never stored here (Keychain on macOS, else `~/.servedev/machines/<name>.token`). Adding, removing or changing an entry by hand connects, disconnects or reconnects it. See [remote.md](remote.md).

## Worktrees

Each worktree has its own copy of `servedev.json`, possibly a different version per branch. servedev treats each worktree as its own project: a shared profile appears once per worktree, tagged with its branch, and starts that worktree's servers.

## Editing

You can edit either file by hand, from the dashboard, from the CLI or through an agent:

- **Live reload.** servedev watches every config file. Hand edits, `git pull`, `git checkout` and commits show up in the dashboard within about a second.
- **Broken JSON doesn't break servedev.** It keeps the last good version and shows the error with file and line (dashboard banner, `servedev config status`, the `config_status` agent tool).
- **Safe writes.** servedev checks the file hasn't changed since it read it, writes atomically, and keeps comments and formatting. An edit made while your editor has unsaved changes is refused rather than overwritten.
- **Uncommitted changes.** Editing a shared profile from the dashboard writes to that worktree's `servedev.json`, and the profile shows *uncommitted changes* until you commit. Git stays the review step: nothing is shared until you push.

## Sharing

| To | Dashboard | CLI |
|---|---|---|
| Put a server in the repo | Server page → **Save to servedev.json** | `servedev save <server>` |
| Create a shared profile | New profile → **Share with the repo** | `servedev profile create <name> <servers...> --shared` |
| Share one of your profiles | Profile menu → **Share with the repo…** | `servedev profile share <profile>` |
| Copy a shared profile to change freely | Profile menu → **Make a copy of your own** | `servedev profile duplicate <profile>` |
| Skip a shared profile's server for yourself | Profile dialog → turn off the server's switch | `servedev profile skip <profile> <servers...>` |
| Set what a shared profile's servers need | Profile dialog → **What its servers need** | `servedev profile needs <profile> gcloud.project=<id>` |
| Go back to the repo's grid | Grid layout menu → **Reset to the repo's layout** | `servedev grid reset <profile>` |
| See where something is defined | Server page → **Defined in** | `servedev config where <server or profile>` |

Saving to `servedev.json` never writes credentials: command-line tokens (`--token=…`, `ghp_…`, `sk_live_…`) and secret-looking variables are left out, and machine-specific paths are made portable.

## Adding a repo

Add the folder from the dashboard (**New server** → pick the folder → **Add project**) or with `servedev add <path>`. If it has a `servedev.json`, its servers and shared profiles appear right away; nothing starts until you start it.

## A new machine

1. Install servedev and clone your repos (and recreate worktrees), in any folders.
2. Copy `~/.servedev/config.json` from the old machine, or keep it in a dotfiles repo.
3. Run `servedev setup`. It finds each project in `projects` by git remote (and worktree branch), fixes the paths, and lists what's missing: repos to clone, worktrees to add (with the `git worktree add` command), and accounts to sign in to. It only prints a plan; add `--apply` to write it, or `--map <project>=<path>` to point at a folder yourself.

Run history, logs and saved credentials stay on the old machine on purpose.

## Upgrading from the database

Earlier versions kept servers, profiles, grids, pins and settings in `servedev.db`. On first start, servedev moves them into `config.json`, after backing the database up to `servedev.db.pre-config`. The move runs once and is safe to run again.
