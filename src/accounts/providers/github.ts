import { run, runOk } from "../exec";
import type { AccountProvider, Notice } from "../types";

/** GitHub via the gh CLI (github.com). Profiles get GH_TOKEN for their account, fetched fresh at each start. */

interface HostEntry {
  login: string;
  active: boolean;
  state: string;
  error?: string;
}

async function entries(): Promise<HostEntry[]> {
  // Exits non-zero when any token is invalid; the JSON is still printed.
  const r = await run(["gh", "auth", "status", "--hostname", "github.com", "--json", "hosts"]);
  try {
    return (JSON.parse(r.stdout).hosts?.["github.com"] ?? []) as HostEntry[];
  } catch {
    throw new Error((r.stderr || r.stdout).trim() || "gh auth status failed");
  }
}

export const github: AccountProvider = {
  id: "github",
  name: "GitHub",
  description: "The gh CLI account for github.com. Add accounts with `gh auth login` in a terminal.",
  available: async () => !!Bun.which("gh"),
  fields: [
    {
      id: "user",
      label: "Account",
      options: async () => (await entries()).map((e) => ({ value: e.login, detail: e.state === "success" ? undefined : "signed out" })),
      current: async () => (await entries()).find((e) => e.active)?.login,
      set: async (value) => void (await runOk(["gh", "auth", "switch", "--hostname", "github.com", "--user", value])),
    },
  ],
  async env(selection): Promise<Record<string, string>> {
    if (!selection.user) return {};
    const token = await runOk(["gh", "auth", "token", "--hostname", "github.com", "--user", selection.user]);
    return { GH_TOKEN: token };
  },
  async status() {
    const notices: Notice[] = [];
    for (const e of await entries()) {
      if (e.state !== "success") notices.push({ level: "warning", message: `${e.login}'s GitHub sign-in isn't valid. Run \`gh auth login\` in a terminal.` });
    }
    return notices;
  },
};
