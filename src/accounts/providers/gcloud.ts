import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HOME } from "../../paths";
import { runOk } from "../exec";
import type { AccountProvider, Notice, Option, Selection } from "../types";

/**
 * Google Cloud. Two separate identities live on a machine:
 *  - the gcloud CLI account (`gcloud config set account`), used by `gcloud` commands;
 *  - Application Default Credentials (ADC), a file that Google client libraries, cloud-sql-proxy
 *    and friends read. `gcloud auth application-default login` writes it, whatever the CLI account.
 * servedev can keep a copy of ADC per account ("app credentials"), so a profile can hand its
 * servers GOOGLE_APPLICATION_CREDENTIALS for one account while the machine uses another.
 */

const configDir = () => process.env.CLOUDSDK_CONFIG ?? path.join(os.homedir(), ".config", "gcloud");
const adcFile = () => path.join(configDir(), "application_default_credentials.json");
const savedDir = () => path.join(HOME, "credentials", "gcloud");
const savedFile = (account: string) => path.join(savedDir(), `${account.replace(/[^\w.@+-]/g, "_")}.json`);

function savedAccounts(): string[] {
  try {
    return fs
      .readdirSync(savedDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

function save(account: string, credentials: string) {
  fs.mkdirSync(savedDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(savedFile(account), credentials, { mode: 0o600 });
}

/** [core] properties of the active gcloud configuration, read from disk (gcloud itself takes ~1s to start). */
function activeConfig(): Record<string, string> {
  const dir = configDir();
  let name = "default";
  try {
    name = fs.readFileSync(path.join(dir, "active_config"), "utf8").trim() || "default";
  } catch {}
  const props: Record<string, string> = {};
  try {
    let section = "";
    for (const line of fs.readFileSync(path.join(dir, "configurations", `config_${name}`), "utf8").split("\n")) {
      const header = line.match(/^\s*\[(.+)\]\s*$/);
      if (header) section = header[1];
      const kv = line.match(/^\s*([\w-]+)\s*=\s*(.*?)\s*$/);
      if (kv && section === "core") props[kv[1]] = kv[2];
    }
  } catch {}
  return props;
}

/** Who a credentials file signs in as. Cached per file version; user credentials need a token round trip. */
const identities = new Map<string, { key: string; at: number; who?: string }>();

async function identify(file: string): Promise<string | undefined> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = identities.get(file);
  // Unknown (offline, revoked) results are retried after a minute.
  if (hit && hit.key === key && (hit.who || Date.now() - hit.at < 60_000)) return hit.who;
  const who = await identifyCredentials(JSON.parse(fs.readFileSync(file, "utf8"))).catch(() => undefined);
  identities.set(file, { key, at: Date.now(), who });
  return who;
}

async function identifyCredentials(c: Record<string, any>): Promise<string | undefined> {
  if (c.type === "service_account") return c.client_email;
  if (c.type === "impersonated_service_account") {
    return String(c.service_account_impersonation_url ?? "").match(/serviceAccounts\/([^:]+):/)?.[1];
  }
  if (c.type !== "authorized_user") return undefined;
  const token = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token }),
    signal: AbortSignal.timeout(8000),
  }).then((r) => r.json() as Promise<{ access_token?: string }>);
  if (!token.access_token) return undefined;
  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token.access_token}`, { signal: AbortSignal.timeout(8000) }).then(
    (r) => r.json() as Promise<{ email?: string }>,
  );
  return info.email;
}

/** Keep a copy of the current ADC before replacing it, so switching back is always possible. */
async function backUpCurrent() {
  if (!fs.existsSync(adcFile())) return;
  const who = await identify(adcFile());
  if (who && !fs.existsSync(savedFile(who))) save(who, fs.readFileSync(adcFile(), "utf8"));
}

async function useAppCredentials(account: string) {
  if (!fs.existsSync(savedFile(account))) {
    throw new Error(`no saved app credentials for ${account}. Sign in for apps first: servedev account action gcloud sign-in-apps account=${account}`);
  }
  await backUpCurrent();
  fs.copyFileSync(savedFile(account), adcFile());
  fs.chmodSync(adcFile(), 0o600);
}

const projectCache = new Map<string, { at: number; options: Option[] }>();

export const gcloud: AccountProvider = {
  id: "gcloud",
  name: "Google Cloud",
  description:
    "The gcloud CLI account and project, and the app credentials (ADC) that Google client libraries and cloud-sql-proxy use. " +
    "A profile can give its servers a different account without changing this machine's.",
  available: async () => !!Bun.which("gcloud"),
  fields: [
    {
      id: "account",
      label: "Account",
      async options() {
        const list = JSON.parse(await runOk(["gcloud", "auth", "list", "--format=json"])) as { account: string }[];
        const saved = new Set(savedAccounts());
        return list.map((a) => ({ value: a.account, detail: saved.has(a.account) ? "app credentials saved" : undefined }));
      },
      current: async () => activeConfig().account,
      set: async (value) => void (await runOk(["gcloud", "config", "set", "account", value])),
    },
    {
      id: "project",
      label: "Project",
      freeform: true,
      async options(selection) {
        const account = selection.account ?? activeConfig().account ?? "";
        const hit = projectCache.get(account);
        if (hit && Date.now() - hit.at < 5 * 60_000) return hit.options;
        const argv = ["gcloud", "projects", "list", "--format=json(projectId,name)", "--sort-by=projectId"];
        if (account) argv.push(`--account=${account}`);
        const list = JSON.parse(await runOk(argv, { timeoutMs: 30_000 })) as { projectId: string; name?: string }[];
        const options = list.map((p) => ({ value: p.projectId, detail: p.name && p.name !== p.projectId ? p.name : undefined }));
        projectCache.set(account, { at: Date.now(), options });
        return options;
      },
      current: async () => activeConfig().project,
      set: async (value) => void (await runOk(["gcloud", "config", "set", "project", value])),
    },
    {
      id: "adc",
      label: "App credentials (ADC)",
      description: "Who Google client libraries and cloud-sql-proxy sign in as. In a profile, defaults to the account above.",
      async options() {
        const current = await identify(adcFile());
        const accounts = new Set([...savedAccounts(), ...(current ? [current] : [])]);
        return [...accounts].map((a) => ({ value: a, detail: a === current && !fs.existsSync(savedFile(a)) ? "current, not saved" : "saved" }));
      },
      current: () => identify(adcFile()),
      set: useAppCredentials,
    },
  ],

  async env(selection: Selection) {
    const env: Record<string, string> = {};
    if (selection.account) env.CLOUDSDK_CORE_ACCOUNT = selection.account;
    if (selection.project) {
      env.CLOUDSDK_CORE_PROJECT = selection.project;
      env.GOOGLE_CLOUD_PROJECT = selection.project;
    }
    const app = selection.adc ?? selection.account;
    if (app) {
      // Starting with some other account's credentials is the mistake a profile exists to prevent: fail loudly.
      if (!fs.existsSync(savedFile(app))) {
        throw new Error(
          `Google Cloud: no saved app credentials for ${app}, so its servers can't sign in as it. ` +
            `Sign in for apps (dashboard: Accounts → Google Cloud, or: servedev account action gcloud sign-in-apps account=${app}).`,
        );
      }
      env.GOOGLE_APPLICATION_CREDENTIALS = savedFile(app);
    }
    return env;
  },

  async status() {
    const notices: Notice[] = [];
    const cli = activeConfig().account;
    if (!fs.existsSync(adcFile())) {
      notices.push({
        level: "warning",
        message: "No app credentials (ADC). Servers that use Google client libraries can't sign in.",
        fix: { action: "sign-in-apps", label: "Sign in for apps", args: cli ? { account: cli } : {} },
      });
      return notices;
    }
    const app = await identify(adcFile());
    if (app && cli && app !== cli) {
      notices.push({
        level: "info",
        message: `Apps sign in as ${app}; the gcloud CLI uses ${cli}.`,
        fix: fs.existsSync(savedFile(cli))
          ? { action: "use-apps", label: `Use ${cli} for apps`, args: { account: cli } }
          : { action: "sign-in-apps", label: `Sign in for apps as ${cli}`, args: { account: cli } },
      });
    }
    return notices;
  },

  actions: {
    "sign-in-apps": {
      label: "Sign in for apps",
      description:
        "Opens Google sign-in in your browser and saves app credentials (ADC) for the account you pick. " +
        "This machine's gcloud setup and current app credentials are left alone.",
      interactive: true,
      async run(args) {
        // A throwaway gcloud config dir, so the login doesn't replace the machine's ADC.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-gcloud-"));
        try {
          await runOk(["gcloud", "auth", "application-default", "login", "--quiet"], { env: { CLOUDSDK_CONFIG: tmp }, timeoutMs: 5 * 60_000 });
          const file = path.join(tmp, "application_default_credentials.json");
          const who = await identify(file);
          if (!who) throw new Error("signed in, but couldn't tell which account the credentials belong to");
          save(who, fs.readFileSync(file, "utf8"));
          const note = args.account && args.account !== who ? ` (you signed in as ${who}, not ${args.account})` : "";
          return `Saved app credentials for ${who}${note}.`;
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    "use-apps": {
      label: "Use saved app credentials",
      description: "Makes this machine's app credentials (ADC) an account's saved ones. Restart servers that use them to pick up the change.",
      async run(args) {
        if (!args.account) throw new Error("which account? pass account");
        await useAppCredentials(args.account);
        return `App credentials (ADC) now sign in as ${args.account}. Restart servers that use them.`;
      },
    },
    "save-current-apps": {
      label: "Save current app credentials",
      description: "Keeps a copy of the current app credentials (ADC) under their account, so profiles can use them.",
      async run() {
        if (!fs.existsSync(adcFile())) throw new Error("there are no app credentials (ADC) to save");
        const who = await identify(adcFile());
        if (!who) throw new Error("couldn't tell which account the current app credentials belong to");
        save(who, fs.readFileSync(adcFile(), "utf8"));
        return `Saved the current app credentials for ${who}.`;
      },
    },
    "forget-apps": {
      label: "Forget saved app credentials",
      description: "Deletes servedev's saved copy of an account's app credentials. The machine's ADC is left alone.",
      async run(args) {
        if (!args.account) throw new Error("which account? pass account");
        fs.rmSync(savedFile(args.account), { force: true });
        return `Forgot the saved app credentials for ${args.account}.`;
      },
    },
  },
};
