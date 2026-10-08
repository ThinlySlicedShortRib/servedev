import { platform } from "./platform";

// Where it's always been importable from.
export { parseEnvOutput } from "./platform/posix";

/**
 * Server environments. A server stores only the variables someone set on purpose (--env, the
 * dashboard, servedev.json); everything else comes from a fresh login shell at every start, so
 * PATH & co. match a terminal, and nothing from the terminal or agent session that happened to
 * start it (tokens, NODE_OPTIONS shims, terminal ids) gets saved or leaks into servers.
 */

/** Variables that describe a terminal, agent session or login session, never a server's setup. */
const NOISY = [
  /^(PWD|OLDPWD|SHLVL|_|PS1|PS2|PROMPT|RPROMPT|COLUMNS|LINES)$/,
  /^TERM(_PROGRAM(_VERSION)?|_SESSION_ID|INFO)?$/,
  /^(COLORTERM|ITERM_.*|TMUX.*|STY|WINDOW|KITTY_.*|WEZTERM_.*|ALACRITTY_.*|GHOSTTY_.*|WARP_.*|ZED_.*|VTE_.*|KONSOLE_.*)$/,
  /^(VSCODE_.*|CURSOR_.*|WINDSURF_.*|JETBRAINS_.*|TERMINAL_EMULATOR|WORKSPACE_FOLDER_PATHS|ELECTRON_RUN_AS_NODE)$/,
  /^(CLAUDE.*|CODEX_.*|AI_AGENT|AIDER_.*|CMUX.*|OPENCODE.*|AMP_.*|GEMINI_CLI.*)$/,
  // servedev's own settings for the CLI/daemon (a test daemon's home, port), not the servers'.
  /^SERVEDEV_.*$/,
  /^(XPC_.*|__CF.*|__CFBundleIdentifier|COMMAND_MODE|SECURITYSESSIONID|LaunchInstanceID|MallocNanoZone|OSLogRateLimit|NoDefaultCurrentDirectoryInExePath)$/,
  /^(SSH_AUTH_SOCK|SSH_AGENT_PID|DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_.*)$/,
  // Agent harnesses set these for their own tool calls (no editor, auto-yes, no corepack pins).
  /^(GIT_EDITOR|GIT_PAGER|PAGER|NPM_CONFIG_YES|npm_config_yes|COREPACK_ENABLE_AUTO_PIN|NODE_OPTIONS|FORCE_COLOR|NO_COLOR|CI)$/,
  // Package-manager script context (servedev started from inside `npm run`).
  /^(npm_.*|npm_config_.*|PNPM_SCRIPT_SRC_DIR|INIT_CWD|BERRY_BIN_FOLDER|YARN_.*)$/,
];

/** Provided by the login shell / the machine; a stored copy would go stale or be wrong elsewhere. */
const MACHINE = /^(PATH|MANPATH|INFOPATH|FPATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_.*|HOMEBREW_.*|NVM_.*|VOLTA_HOME|PNPM_HOME|BUN_INSTALL|ASDF_.*|MISE_.*|PYENV_.*|RBENV_.*|GOPATH|JAVA_HOME|SDKMAN_.*)$/;

export const isNoisy = (name: string) => NOISY.some((re) => re.test(name));
export const isMachine = (name: string) => MACHINE.test(name);
export const looksSecret = (name: string) => /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE/i.test(name);

/** "sk_l…" — enough to recognize a value without showing it. */
export function maskValue(v: string): string {
  return v.length <= 4 ? "…" : `${v.slice(0, 4)}…`;
}

// ---------- the login shell's environment ----------

let loginEnv: Record<string, string> | undefined;
let loginAt = 0;
let pending: Promise<Record<string, string>> | undefined;

/**
 * What a new terminal would have (see Platform.loginShellEnv), minus terminal/session noise.
 * Falls back to the daemon's environment minus noise if the shell fails or hangs.
 */
async function captureLoginEnv(): Promise<Record<string, string>> {
  try {
    const env = await platform.loginShellEnv();
    for (const k of Object.keys(env)) if (isNoisy(k)) delete env[k];
    // The agent socket is per login session, not per shell; keep the daemon's so git over ssh works.
    if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
    return env;
  } catch {
    return Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => !isNoisy(k) || k === "SSH_AUTH_SOCK"));
  }
}

/** The login environment, re-read at most every 10 minutes (e.g. after editing ~/.zshrc). */
export async function getLoginEnv(refresh = false): Promise<Record<string, string>> {
  if (!refresh && loginEnv && Date.now() - loginAt < 10 * 60_000) return loginEnv;
  pending ??= captureLoginEnv().then((env) => {
    loginEnv = env;
    loginAt = Date.now();
    pending = undefined;
    return env;
  });
  // A stale copy is fine to use while the refresh runs.
  return loginEnv && !refresh ? loginEnv : pending;
}

/** For tests. */
export function setLoginEnvForTests(env: Record<string, string>) {
  loginEnv = env;
  loginAt = Date.now();
}

// ---------- explicit variables ----------

/**
 * The part of a full environment (an old client's process.env, or a stored snapshot) that someone
 * set on purpose: what differs from the login shell, minus terminal/session noise and per-machine
 * values.
 */
export function explicitPart(full: Record<string, string>, login: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(full)) {
    if (isNoisy(k) || isMachine(k) || login[k] === v) continue;
    out[k] = v;
  }
  return out;
}

export interface EnvMigration {
  id: string;
  before: number;
  kept: string[];
  /** Secret-looking names that were dropped (they matched the login shell, or were session noise). */
  secretsDropped: string[];
  /** Secret-looking names that were kept because they looked set on purpose. */
  secretsKept: string[];
}

/** One stored snapshot → its explicit part, with a report in names only. */
export function migrateSnapshot(id: string, stored: Record<string, string>, login: Record<string, string>): { env: Record<string, string>; report: EnvMigration } {
  const env = explicitPart(stored, login);
  const names = Object.keys(stored);
  const kept = Object.keys(env).sort();
  return {
    env,
    report: {
      id,
      before: names.length,
      kept,
      secretsDropped: names.filter((n) => looksSecret(n) && !(n in env)).sort(),
      secretsKept: kept.filter(looksSecret),
    },
  };
}

/** Apply `vars` to `base`: an empty value removes the variable. */
export function applyVars(base: Record<string, string>, vars: Record<string, string>): Record<string, string> {
  const out = { ...base };
  for (const [k, v] of Object.entries(vars)) {
    if (v === "") delete out[k];
    else out[k] = v;
  }
  return out;
}
