/**
 * A TypeScript account provider, for platforms that need more than a few commands: logic,
 * HTTP calls, warnings, extra actions. Copy it to ~/.servedev/providers/ and edit.
 *
 * The default export is an AccountProvider (src/accounts/types.ts in the servedev repo). Files in
 * ~/.servedev/providers can't import servedev's types, so the shape is spelled out in comments.
 *
 * This example needs no CLI: it keeps "Example Cloud" accounts in ~/.example-cloud.json:
 *   { "active": "me@example.com", "accounts": { "me@example.com": { "token": "t1", "projects": ["demo"] } } }
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = path.join(os.homedir(), ".example-cloud.json");

interface State {
  active?: string;
  project?: string;
  accounts: Record<string, { token: string; projects: string[]; expired?: boolean }>;
}

function read(): State {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { accounts: {} };
  }
}

function write(state: State) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export default {
  // Stable and lowercase: used in profiles and on the CLI (servedev account example-cloud).
  id: "example-cloud",
  name: "Example Cloud",
  description: "A sample provider that keeps its accounts in ~/.example-cloud.json.",

  // Hidden in the dashboard when false (e.g. the CLI isn't installed).
  available: async () => fs.existsSync(FILE),

  fields: [
    {
      id: "account",
      label: "Account",
      options: async () =>
        Object.entries(read().accounts).map(([value, a]) => ({ value, detail: a.expired ? "signed out" : undefined })),
      current: async () => read().active,
      // Omit `set` when the platform has no machine-wide "current" (then it's per profile only).
      set: async (value: string) => {
        const state = read();
        if (!state.accounts[value]) throw new Error(`no account ${value}`);
        write({ ...state, active: value });
      },
    },
    {
      id: "project",
      label: "Project",
      // Values that aren't listed are allowed too (typed into the picker).
      freeform: true,
      // `selection` holds the other fields' picks: projects depend on the account.
      options: async (selection: Record<string, string>) => {
        const state = read();
        const account = selection.account ?? state.active;
        return (account ? state.accounts[account]?.projects ?? [] : []).map((value) => ({ value }));
      },
      current: async () => read().project,
      set: async (value: string) => write({ ...read(), project: value }),
    },
  ],

  // Environment for servers whose profile picked accounts. Called at every start, so tokens are
  // fresh and servedev never stores them. Throw to refuse the start with a clear message.
  env: async (selection: Record<string, string>) => {
    const env: Record<string, string> = {};
    if (selection.account) {
      const account = read().accounts[selection.account];
      if (!account) throw new Error(`no account ${selection.account}; add it to ${FILE}`);
      env.EXAMPLE_CLOUD_TOKEN = account.token;
    }
    if (selection.project) env.EXAMPLE_CLOUD_PROJECT = selection.project;
    return env;
  },

  // Shown in the dashboard's Accounts panel and `servedev account`. A fix names an action below.
  status: async () => {
    const state = read();
    const active = state.active && state.accounts[state.active];
    if (active && active.expired) {
      return [
        {
          level: "warning" as const,
          message: `${state.active} is signed out.`,
          fix: { action: "sign-in", label: "Sign in again", args: { account: state.active! } },
        },
      ];
    }
    return [];
  },

  // Run from the dashboard, `servedev account action example-cloud sign-in account=me@example.com`,
  // or the run_account_action MCP tool. Return a sentence saying what happened.
  actions: {
    "sign-in": {
      label: "Sign in",
      description: "Marks an account as signed in (a real provider would open a browser login).",
      // Interactive actions wait for the user; the dashboard says so while they run.
      interactive: false,
      run: async (args: Record<string, string>) => {
        const state = read();
        const account = args.account ?? state.active;
        if (!account || !state.accounts[account]) throw new Error("which account? pass account=<email>");
        state.accounts[account].expired = false;
        write(state);
        return `Signed in as ${account}.`;
      },
    },
  },
};
