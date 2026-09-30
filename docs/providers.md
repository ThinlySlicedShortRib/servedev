# Account providers

servedev can show and switch the accounts your platform CLIs are signed in as (Google Cloud, GitHub, and anything you add), and let a **profile** run its servers as different accounts without touching the rest of your machine. Each platform is an **account provider**. Two are built in; adding another is usually one JSON file.

- [Concepts](#concepts)
- [Adding a provider](#adding-a-provider)
- [JSON providers](#json-providers)
- [TypeScript providers](#typescript-providers)
- [Testing your provider](#testing-your-provider)
- [The built-in providers](#the-built-in-providers)
- [Security](#security)
- [Contributing a built-in provider](#contributing-a-built-in-provider)

## Concepts

**Provider.** One platform, e.g. `gcloud` or `github`. It has an id (used on the CLI and in profiles), a display name, and a check for whether its CLI is installed. Providers whose CLI is missing are hidden.

**Fields.** What you pick on that platform. Google Cloud has three (`account`, `project`, `adc`); GitHub has one (`user`); Docker would have `context`. Each field has:

- **options**: the choices, e.g. the accounts `gcloud auth list` knows. Options can depend on the other fields (the projects an account can see).
- **current**: the machine-wide value, what a terminal on this machine uses right now.
- **set** (optional): how to switch the machine-wide value. Switching affects every terminal and tool, which is why agents are told to do it only when asked. A field without `set` can only be picked per profile (AWS profiles, for example, are just an environment variable).

**Profile picks.** A profile can store a value per field ("selections"), e.g. `{ "gcloud": { "account": "me@work.com", "project": "work-dev" } }`. When one of its servers starts, the provider turns the picks into **environment variables** for that process only (`CLOUDSDK_CORE_ACCOUNT`, `GOOGLE_APPLICATION_CREDENTIALS`, `GH_TOKEN`, ...). The machine-wide values don't change. A provider with no `env` can't be picked per profile.

- The env is computed **at every start** and never saved, so tokens are always fresh and never land in servedev's database. Only the picks (account names, project ids) are stored.
- It's added to that run only: a server started outside the profile later doesn't keep the old profile's credentials.
- If the env can't be produced (say, missing credentials for the picked account), the start fails with the provider's message instead of silently running as someone else.
- Which profile's picks a server uses: the profile it's started from (dashboard with that profile selected, `servedev profile start`, `--profile <name>`). A plain start or restart reuses the profile it last ran with, or the only profile it belongs to that picks accounts. `--profile none` uses the machine's accounts.
- Changing a profile's picks while its servers run marks them "restart to apply".

**Notices.** A provider can report things worth knowing ("Apps sign in as A; the CLI uses B"), each optionally with a **fix** that runs one of its actions.

**Actions.** Extra operations by id, such as "sign in for apps". They run from the dashboard's Accounts panel, `servedev account action <provider> <action> key=value`, or the `run_account_action` MCP tool. Interactive ones wait for you in a browser.

## Adding a provider

### From the dashboard

Open **Accounts** (top right) and press **Add platform**:

- **Catalog**: ready-made providers (AWS, Azure, Cloudflare, DigitalOcean, Docker, Firebase, Kubernetes, 1Password, Stripe, Vercel, …), grouped by category. Each shows whether its CLI is installed, whether it can only switch the whole machine (**machine only**: no per-process env) or only per profile (**per profile only**: no machine-wide switch), and **untested** when its commands were written from the CLI's docs but not yet run against it. **Add** copies it into `~/.servedev/providers/<id>.json`; the pencil opens it in the custom form first so you can change it.
- **Custom**: a form for your own CLI: name, the command it needs, each field you pick (a list command, a current command and a switch command), and the environment a profile's servers get. **Start from** prefills it from a catalog entry. **Test** runs the list and current commands and previews the environment (values masked) without saving or switching anything. **Edit as JSON** shows the file as it will be saved.

Providers you added get **Edit** and **Remove** in their ⋯ menu. Added providers whose CLI isn't installed are listed at the bottom of the panel (they stay hidden elsewhere until it is). Removing one deletes its file; profiles that picked accounts for it go back to the machine's.

### From the CLI or an agent

```sh
servedev account catalog                   # what can be added, with installed/added
servedev account add aws                   # from the catalog
servedev account test --file fly.json      # dry run: validate, run list/current, preview env; never switches
servedev account test --file fly.json org=personal   # preview env for specific values
servedev account add --file fly.json       # your own (--replace to update it, --override to replace a built-in)
servedev account remove fly
```

MCP tools: `list_account_catalog`, `test_account_provider`, `add_account_provider` (`catalog` or `spec`), `remove_account_provider`.

### As a file

Put a file in **`~/.servedev/providers/`** (or `$SERVEDEV_HOME/providers/`):

- `*.json`: a [JSON provider](#json-providers), for CLIs that can list, show and switch with one command each. No code.
- `*.ts`, `*.js`, `*.mjs`: a [TypeScript provider](#typescript-providers), for anything that needs logic.

The folder is re-read whenever it changes. A user provider with the **same id as a built-in replaces it**, so you can customize `gcloud` or `github` by copying and editing. A file that fails to load is listed with its error in the Accounts panel and in `servedev account`; the others still load.

The catalog's specs live in [`src/accounts/catalog/`](../src/accounts/catalog); more examples, including a commented TypeScript module, are in [`examples/providers/`](../examples/providers). Copy one and adjust it.

Catalog entries use four extra, optional keys: `homepage` (URL), `category` (e.g. "Cloud", "Containers"), `install` (a command or URL shown when the CLI is missing) and `tested` (`false` when the commands haven't been run against the real CLI). They don't change how a provider works.

## JSON providers

```json
{
  "id": "docker",
  "name": "Docker",
  "description": "Which engine `docker` talks to.",
  "requires": "docker",
  "fields": [
    {
      "id": "context",
      "label": "Context",
      "list": "docker context ls --format '{{.Name}}'",
      "current": "docker context show",
      "set": "docker context use {context}"
    }
  ],
  "env": { "DOCKER_CONTEXT": "{context}" }
}
```

### Reference

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lowercase letters, digits and dashes, starting with a letter (`docker`, `fly-io`). Used on the CLI and in profiles. |
| `name` | yes | Display name. |
| `description` | no | One or two sentences shown under the name. |
| `requires` | no | A command that must be on `PATH` for the provider to show up, e.g. `"docker"`. |
| `fields` | yes | At least one field (below). |
| `env` | no | Environment for servers whose profile picks this provider. Without it, the provider can't be picked per profile. |
| `actions` | no | Extra operations by id (below). |

Each **field**:

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Letters, digits, `_`, `-`. This is the `{placeholder}` name. |
| `label` | yes | Shown next to the picker. |
| `description` | no | Help text under the picker. |
| `list` | one of `list`, `options`, `freeform` | Command that prints the options, one per line (format below). |
| `options` | | Fixed options instead: strings, or `{ "value", "label"?, "detail"? }` objects. |
| `freeform` | | `true` allows values that aren't listed (typed in). A freeform field may have no list at all. |
| `current` | no | Command that prints the machine-wide value. Empty output means "not set". |
| `set` | no | Command that switches the machine-wide value. Omit it when the platform has no machine-wide switch. |

**`list` output.** One option per line: the value, optionally a tab and a label, optionally another tab and a detail. Blank lines are skipped. Use a label when the value is an opaque id:

```
3f2a…c1	Production	Owner
9b17…e0	Staging
```

The Azure example prints `id<TAB>name`, and the Docker example leaves the label empty (`name<TAB><TAB>endpoint`) to show the endpoint as a detail.

Each **action**: `{ "label", "description", "command", "interactive"? }`. The command's output is shown as the result (or "Done." when it prints nothing). Its placeholders are filled from the action's arguments (`servedev account action aws sso-login profile=work` → `{profile}`).

### Placeholders

`{field}` is replaced with that field's value:

- **In commands** (`list`, `set`, `env` commands, actions) the value is **shell-quoted**, so `docker context use {context}` stays one argument even if the value has spaces or quotes. Don't add quotes of your own around placeholders.
- **In `env` strings** the value is inserted **as is**: `"KUBE_NS": "{namespace}"`.
- In `set`, `{value}` also works and means the new value.
- In `list`, placeholders come from the other fields' picks (dependent options). A placeholder without a value becomes empty.
- An `env` variable whose template references a field with **no value is skipped**, so a profile that picks only some fields sets only the variables it can.

`env` values are either a template string or `{ "command": "..." }`, whose output becomes the value. Use a command for tokens, so they're fetched fresh at each start:

```json
"env": {
  "GH_TOKEN": { "command": "gh auth token --user {user}" },
  "GH_HOST": "github.com"
}
```

`env` templates may only reference field ids; that's checked when the file loads.

Commands run with `/bin/sh -c`, as you, with the daemon's environment and no stdin, and time out after 20 seconds. A failing command (non-zero exit) becomes an error: servedev shows the CLI's `error:` line when there is one, else the last lines of its output.

## TypeScript providers

A `.ts`/`.js` file whose default export is an `AccountProvider`. The types are in [`src/accounts/types.ts`](../src/accounts/types.ts); files in `~/.servedev/providers` can't import them, so annotate with your own copy or leave them implicit. See [`examples/providers/example-module.ts`](../examples/providers/example-module.ts) for a complete, commented one.

```ts
interface AccountProvider {
  id: string;                    // "gcloud"
  name: string;                  // "Google Cloud"
  description?: string;
  available(): Promise<boolean>; // CLI installed? Hidden when false.
  fields: AccountField[];
  /** Env for a process using `selection` instead of the machine's values. Called at every start; throw to refuse it. */
  env?(selection: Selection): Promise<Record<string, string>>;
  /** Warnings and tips, optionally with a fix that names an action. */
  status?(): Promise<Notice[]>;
  actions?: Record<string, ProviderAction>;
}

interface AccountField {
  id: string;
  label: string;
  description?: string;
  freeform?: boolean;                                // values outside the options are allowed
  options(selection: Selection): Promise<Option[]>;  // selection = the other fields' picks
  current(): Promise<string | undefined>;            // machine-wide value
  set?(value: string): Promise<void>;                // omit: per profile only
}

type Selection = Record<string, string>;             // field id -> value
interface Option { value: string; label?: string; detail?: string }
interface Notice {
  level: "info" | "warning";
  message: string;
  fix?: { action: string; label: string; args?: Record<string, string> };
}
interface ProviderAction {
  label: string;
  description: string;
  interactive?: boolean;                             // waits for the user (browser sign-in)
  run(args: Record<string, string>): Promise<string>; // returns a sentence saying what happened
}
```

Notes:

- servedev caches `current` and `status` for 10 seconds and `options` for 30, and clears the caches after any `set` or action. Keep calls cheap anyway, since the dashboard asks on focus. Read config files directly when the CLI is slow to start (the gcloud provider does).
- Throw `Error`s with messages a person can act on. They're shown as they are, prefixed with the provider's name where it helps.
- `Bun.which("cli")` is a quick `available()`. Modules run inside the daemon, so avoid blocking work at import time.
- The module is imported with a version query and re-imported when the file changes.

## Testing your provider

```sh
servedev account test --file my.json     # before adding: validate and run its list/current commands
servedev account                         # every provider: current values, options, notices, actions, load errors
servedev account docker --refresh        # one provider; --refresh re-reads provider files and skips caches
servedev account use docker desktop-linux          # switch machine-wide (first field), or field=value pairs
servedev account action aws sso-login profile=work
servedev profile accounts "Full stack" docker.context=remote aws.profile=work
servedev profile accounts "Full stack" docker=none # back to the machine's
servedev start api --profile "Full stack"          # start with the profile's picks
servedev status api                                # shows which accounts it runs with
```

In the dashboard, the custom form's **Test** button does the same dry run. Open **Accounts** (top right) and press **Reload** after editing a file by hand; load errors are listed at the top. Pick per-profile accounts in the profile's edit dialog, which checks the picks as you change them (the same check a start runs).

A quick way to see what a server receives: start something like `env | sort; sleep 600` with `--ready none` from a profile, and read its log.

## The built-in providers

### Google Cloud (`gcloud`)

A machine has two separate Google identities, and they drift apart easily:

- **The gcloud CLI account** (`gcloud config set account`), used by `gcloud` commands.
- **Application Default Credentials (ADC)**, the file `~/.config/gcloud/application_default_credentials.json`. Google client libraries (Node, Python, Go, ...), `cloud-sql-proxy` and Terraform read it. `gcloud auth application-default login` writes it, whatever the CLI account is.

Fields:

| Field | Machine-wide | Per profile |
| --- | --- | --- |
| `account` | `gcloud config set account` | `CLOUDSDK_CORE_ACCOUNT` |
| `project` (freeform; lists the account's projects) | `gcloud config set project` | `CLOUDSDK_CORE_PROJECT`, `GOOGLE_CLOUD_PROJECT` |
| `adc` (app credentials) | copies the account's saved credentials over the ADC file, keeping a copy of the old one | `GOOGLE_APPLICATION_CREDENTIALS` |

For per-profile app credentials, servedev keeps a copy of ADC **per account** in `~/.servedev/credentials/gcloud/<email>.json`. In a profile, `adc` defaults to the picked `account`. Starting a server as an account with no saved credentials fails with instructions instead of letting it sign in as whoever the machine's ADC is. Actions:

- `sign-in-apps`: browser sign-in that saves app credentials for the account you pick. It runs with a temporary `CLOUDSDK_CONFIG`, so the machine's gcloud setup and ADC are untouched.
- `save-current-apps`: keep a copy of the current ADC under its account.
- `use-apps account=<email>`: make an account's saved credentials the machine's ADC.
- `forget-apps account=<email>`: delete a saved copy.

A notice appears when ADC and the CLI account differ, with a fix. servedev tells which account an ADC file belongs to by exchanging its refresh token for an access token and asking Google's tokeninfo endpoint (cached per file version). Service-account and impersonation files are read directly. `CLOUDSDK_CONFIG` is honoured throughout.

### GitHub (`github`)

One field, `user`: the gh accounts for github.com (`gh auth status`). Switching machine-wide runs `gh auth switch`. Per profile, servers get `GH_TOKEN` from `gh auth token --user <user>` at each start. `gh`, the GitHub API clients and most tools that talk to GitHub honour it. Add accounts with `gh auth login` in a terminal; it's interactive, so servedev doesn't run it. Accounts whose token is no longer valid get a warning.

## Security

- Provider commands and modules run **as you**, inside the daemon, with its environment. Treat `~/.servedev/providers` like your shell config: only add files you'd run yourself.
- Values in commands are always shell-quoted, so an account name can't inject shell syntax. Your own command text is not quoted, of course.
- servedev stores **picks, not secrets**: profile rows hold account names and project ids. Tokens are produced at start time and passed only to that process's environment.
- The exception is gcloud's saved app credentials in `~/.servedev/credentials/gcloud/` (directory `0700`, files `0600`). They're copies of what `gcloud auth application-default login` writes, as sensitive as `~/.config/gcloud`. Remove one with `servedev account action gcloud forget-apps account=<email>`.
- A server's environment is visible to other processes you run (`ps eww`), as with any env var.
- The daemon's API only answers local requests carrying its token, so web pages can't switch your accounts.

## Contributing a built-in provider

Built-ins live in `src/accounts/providers/` and are registered in `BUILT_IN` in `src/accounts/registry.ts`.

1. Start as a JSON provider in `~/.servedev/providers/` and use it for a while. If it needs no code, contribute it to the catalog instead: add `src/accounts/catalog/<id>.json` (with `homepage`, `category`, `install`, and `tested: false` unless you ran every command), import it in `src/accounts/catalog/index.ts`, and run `bun test`: `test/catalog.test.ts` validates every entry. That's easier to review, and users can customize it before adding it.
2. Promote it to TypeScript when it needs logic (reading config files for speed, dependent options, notices, actions). Copy the shape of `github.ts` (small) or `gcloud.ts` (everything).
3. Rules of thumb:
   - Never write the platform's global config except in `set`, and never in `env`.
   - `env` must not have side effects, and must throw rather than fall back to the machine's account.
   - Honour the platform's config-dir variable (`CLOUDSDK_CONFIG`, `GH_CONFIG_DIR`, ...), so tests and users with custom setups work.
   - Tokens are fetched in `env`, never stored.
4. Add tests in `test/accounts.test.ts` that don't need the real CLI (fake it with a temp dir or a stub on `PATH`), and a section to this file.
