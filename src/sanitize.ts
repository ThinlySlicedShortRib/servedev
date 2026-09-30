import os from "node:os";
import path from "node:path";

/**
 * Making commands safe to write down (servedev.json, exports) and to show: credentials passed on
 * the command line are removed or masked, and paths that only exist on this machine are made
 * portable where that's safe.
 */

/** Flags whose value is a credential. Matched by exact name (so --token-file or --key-file aren't). */
const SECRET_FLAGS = new Set([
  "token",
  "login-token",
  "access-token",
  "id-token",
  "refresh-token",
  "auth-token",
  "api-token",
  "bearer-token",
  "password",
  "passwd",
  "pass",
  "api-key",
  "apikey",
  "secret",
  "client-secret",
  "secret-key",
  "access-key-secret",
  "auth",
  "authorization",
  "private-key",
]);

/** Values that are credentials whatever flag carries them. */
const TOKEN_SHAPES = [
  /ya29\.[\w.-]{10,}/, // Google OAuth access token
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bgithub_pat_\w{20,}/,
  /\b[sr]k_(?:live|test)_\w{10,}/, // Stripe
  /\bxox[abprs]-[\w-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/, // JWT
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bglpat-[\w-]{20}/, // GitLab
];

const looksSecretName = (name: string) => /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE/i.test(name);

/**
 * Shell words, keeping quotes, with operators (; && || | &) as words of their own so removing an
 * argument never takes the operator after it along. Good enough for one-line dev commands.
 */
export function splitWords(cmd: string): string[] {
  return cmd.match(/(?:[^\s"';&|]+|"(?:[^"\\]|\\.)*"|'[^']*')+|&&|\|\||[;&|]/g) ?? [];
}

const isOperator = (w: string) => /^(;|&&|\|\||\||&)$/.test(w);

const unquote = (w: string) => w.replace(/^(['"])(.*)\1$/s, "$2");
const hasTokenShape = (w: string) => TOKEN_SHAPES.some((re) => re.test(w));
/** postgres://user:pass@host → the password. */
const URL_PASSWORD = /(\w+:\/\/[^\s/:@'"]+:)([^\s@'"]+)(@)/g;

export interface CleanCommand {
  command: string;
  /** What was taken out and why, e.g. "removed --token (a credential)". */
  removed: string[];
  /** Paths rewritten to work on another machine. */
  rewritten: string[];
  /** Things that may not work elsewhere but were left as they are. */
  warnings: string[];
}

/** Remove credentials from a command. */
export function stripSecrets(cmd: string): { command: string; removed: string[] } {
  const words = splitWords(cmd);
  const out: string[] = [];
  const removed: string[] = [];
  let leading = true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // FOO_TOKEN=abc pnpm dev
    const assign = leading && w.match(/^([A-Za-z_]\w*)=/);
    if (assign) {
      if (looksSecretName(assign[1]) || hasTokenShape(w)) {
        removed.push(`${assign[1]}=… (a credential)`);
        continue;
      }
      out.push(w);
      continue;
    }
    leading = false;
    const flag = w.match(/^(--?)([\w-]+)(=(.*))?$/s);
    if (flag && SECRET_FLAGS.has(flag[2].toLowerCase())) {
      const name = `${flag[1]}${flag[2]}`;
      if (flag[3] === undefined && i + 1 < words.length && !words[i + 1].startsWith("-") && !isOperator(words[i + 1])) i++; // --token VALUE
      removed.push(`${name} (a credential)`);
      continue;
    }
    if (hasTokenShape(w)) {
      removed.push(`${flag ? `${flag[1]}${flag[2]}` : "an argument"} that looks like a token`);
      continue;
    }
    if (URL_PASSWORD.test(w)) {
      URL_PASSWORD.lastIndex = 0;
      out.push(w.replace(URL_PASSWORD, "$1$3").replace(/:@/, "@"));
      removed.push("a password in a URL");
      continue;
    }
    out.push(w);
  }
  return { command: out.join(" "), removed };
}

/** Mask credentials for display (commands of outside servers, previews); the rest stays readable. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_SHAPES) out = out.replace(new RegExp(re.source, "g"), (m) => `${m.slice(0, 4)}…`);
  out = out.replace(/(^|\s)(--?([\w-]+))(=|\s+)("[^"]*"|'[^']*'|[^\s;&|-][^\s;&|]*)/g, (m, pre, flag, name, sep, value) =>
    SECRET_FLAGS.has(String(name).toLowerCase()) && !String(value).startsWith("…") ? `${pre}${flag}${sep}…` : m,
  );
  out = out.replace(URL_PASSWORD, "$1…$3");
  out = out.replace(/(^|\s)([A-Za-z_]\w*)=(\S+)/g, (m, pre, name) => (looksSecretName(name) ? `${pre}${name}=…` : m));
  return out;
}

const RUNTIMES = new Set(["node", "bun", "deno", "python", "python3"]);

/**
 * Make a command work on another machine: an absolute path to a tool that's on PATH becomes its
 * name (`node /opt/homebrew/bin/pnpm dev` → `pnpm dev`); paths inside the project become relative
 * to where the command runs, other paths in the home folder use ~; anything else absolute is
 * flagged. `which` is injectable for tests.
 */
export function portablePaths(
  cmd: string,
  ctx: { root: string; cwd: string; home?: string; which?: (bin: string) => string | null },
): { command: string; rewritten: string[]; warnings: string[] } {
  const home = ctx.home ?? os.homedir();
  const which = ctx.which ?? ((b: string) => Bun.which(b));
  const words = splitWords(cmd);
  const rewritten: string[] = [];
  const warnings: string[] = [];
  const toolName = (w: string) => {
    if (!path.isAbsolute(w)) return undefined;
    const base = path.basename(w);
    return which(base) ? base : undefined;
  };
  // A runtime launching an absolute tool path: drop the runtime, keep the tool by name.
  let start = 0;
  while (start < words.length && /^[A-Za-z_]\w*=/.test(words[start])) start++;
  const first = words[start];
  const second = words[start + 1];
  if (first && second && RUNTIMES.has(path.basename(first)) && toolName(second)) {
    rewritten.push(`${first} ${second} → ${toolName(second)}`);
    words.splice(start, 2, toolName(second)!);
  } else if (first && toolName(first) && first !== toolName(first)) {
    rewritten.push(`${first} → ${toolName(first)}`);
    words[start] = toolName(first)!;
  }
  for (let i = start; i < words.length; i++) {
    const raw = unquote(words[i]);
    const eq = raw.match(/^(--?[\w-]+=)(\/.*)$/s);
    const prefix = eq ? eq[1] : "";
    const p = eq ? eq[2] : raw;
    if (!path.isAbsolute(p) || p === "/dev/null") continue;
    let next: string | undefined;
    if (p === ctx.root || p.startsWith(ctx.root + path.sep)) {
      const rel = path.relative(ctx.cwd, p) || ".";
      next = rel.startsWith(".") ? rel : `./${rel}`;
    } else if (p === home || p.startsWith(home + path.sep)) {
      next = `~/${path.relative(home, p)}`;
    }
    if (next !== undefined) {
      rewritten.push(`${p} → ${next}`);
      words[i] = prefix + next;
      if (next.startsWith("~/")) warnings.push(`${next} is outside the repo; it only works where that path exists`);
    } else if (i === start && toolName(p)) {
      // already handled
    } else {
      warnings.push(`${p} is a path on this machine; it may not exist elsewhere`);
    }
  }
  return { command: words.join(" "), rewritten, warnings };
}

/** Both: what save and export write. */
export function portableCommand(cmd: string, ctx: { root: string; cwd: string; home?: string; which?: (bin: string) => string | null }): CleanCommand {
  const s = stripSecrets(cmd);
  const p = portablePaths(s.command, ctx);
  return { command: p.command, removed: s.removed, rewritten: p.rewritten, warnings: p.warnings };
}
