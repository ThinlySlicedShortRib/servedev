/**
 * Updating servedev on another machine over its SSH connection: find out where its servedev
 * comes from, pull, install or build as that kind of install needs, and restart its daemon (its
 * servers keep running and the new daemon adopts them).
 *
 *   source  a wrapper script or symlink that runs <checkout>/src/cli.ts with bun
 *   binary  <checkout>/dist/servedev, built there with `bun run build`
 *
 * Anything else (a copied binary, a package manager) is refused with how to update it by hand.
 * So is a checkout with uncommitted changes, or one whose branch can't fast-forward: nothing on
 * the machine changes unless the pull can just move forward.
 */
import { RefError } from "./ids";
import { posixQuote, type Transport } from "./transport";

export type InstallKind = "source" | "binary" | "other";

export interface Install {
  missing: boolean;
  /** `command -v servedev` there, and what it resolves to. */
  path?: string;
  real?: string;
  version?: string;
  kind: InstallKind;
  /** src/cli.ts or dist/servedev that actually runs. */
  entry?: string;
  /** The git checkout holding it. */
  repo?: string;
  /** Empty when HEAD is detached. */
  branch?: string;
  upstream?: string;
  head?: string;
  /** `git status --porcelain` lines (tracked files only). */
  dirty: string[];
  bun?: string;
  /** binary: when it was built, and when HEAD was committed (seconds), to tell a stale build. */
  builtAt?: number;
  committedAt?: number;
}

/**
 * Where servedev comes from there. A wrapper script is read for the src/cli.ts or dist/servedev
 * it runs (and the bun it runs it with: `bun` is often not on a login PATH, e.g. ~/.bun/bin).
 */
export const INSTALL_PROBE = String.raw`p=$(command -v servedev 2>/dev/null)
if [ -z "$p" ]; then echo "@missing"; exit 0; fi
echo "@path $p"
r=$(readlink -f "$p" 2>/dev/null || realpath "$p" 2>/dev/null || echo "$p")
echo "@real $r"
echo "@version $(servedev --version 2>&1 | head -n 1)"
e=""
b=""
case "$r" in
  */src/cli.ts|*/dist/servedev) e="$r" ;;
  *) if [ "$(head -c 2 "$r" 2>/dev/null)" = "#!" ]; then
       e=$(grep -o -E "[^ \"']+/(src/cli\.ts|dist/servedev)" "$r" 2>/dev/null | head -n 1)
       b=$(grep -o -E "[^ \"']+/bun[ \"']" "$r" 2>/dev/null | head -n 1 | sed 's/.$//')
     fi ;;
esac
[ -z "$b" ] && b=$(command -v bun 2>/dev/null)
[ -z "$b" ] && [ -x "$HOME/.bun/bin/bun" ] && b="$HOME/.bun/bin/bun"
echo "@bun $b"
[ -z "$e" ] && exit 0
echo "@entry $e"
command -v git >/dev/null 2>&1 || exit 0
top=$(git -C "$(dirname "$(dirname "$e")")" rev-parse --show-toplevel 2>/dev/null) || exit 0
echo "@repo $top"
echo "@branch $(git -C "$top" symbolic-ref --short -q HEAD)"
echo "@upstream $(git -C "$top" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"
echo "@head $(git -C "$top" rev-parse HEAD)"
echo "@committed $(git -C "$top" log -1 --format=%ct)"
git -C "$top" status --porcelain --untracked-files=no | head -n 20 | sed 's/^/@dirty /'
echo "@built $(date -r "$e" +%s 2>/dev/null)"`;

/** Lines tagged @name: their values (stray output from login scripts is ignored). */
function tags(stdout: string, name: string): string[] {
  return stdout
    .split("\n")
    .filter((l) => l === `@${name}` || l.startsWith(`@${name} `))
    .map((l) => l.slice(name.length + 2).replace(/\r$/, ""));
}

function tag(stdout: string, name: string): string | undefined {
  const v = tags(stdout, name)[0]?.trim();
  return v ? v : undefined;
}

export function parseInstall(stdout: string): Install {
  if (tags(stdout, "missing").length) return { missing: true, kind: "other", dirty: [] };
  const entry = tag(stdout, "entry");
  const repo = tag(stdout, "repo");
  const kind: InstallKind = !entry || !repo ? "other" : entry.endsWith("/src/cli.ts") ? "source" : "binary";
  const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  return {
    missing: false,
    path: tag(stdout, "path"),
    real: tag(stdout, "real"),
    version: tag(stdout, "version"),
    kind,
    entry,
    repo,
    branch: tag(stdout, "branch"),
    upstream: tag(stdout, "upstream"),
    head: tag(stdout, "head"),
    dirty: tags(stdout, "dirty").filter((l) => l.trim()),
    bun: tag(stdout, "bun"),
    builtAt: num(tag(stdout, "built")),
    committedAt: num(tag(stdout, "committed")),
  };
}

/** Why this install can't be updated from here (before anything changes there), or undefined. */
export function refusal(machine: string, i: Install): string | undefined {
  if (i.missing) return `servedev isn't on ${machine}'s login shell PATH anymore`;
  if (i.kind === "other") {
    const where = i.real && i.real !== i.path ? `${i.path} → ${i.real}` : (i.path ?? "servedev");
    const what = i.entry ? `${i.entry}, which isn't in a git checkout` : where;
    return (
      `${machine} runs servedev from ${what}, so it can't be updated from here (only a git checkout run from source or built with bun run build can). ` +
      `Update it on ${machine} the way it was installed, then run servedev daemon restart there and servedev remote reconnect ${machine} here.`
    );
  }
  const at = `${i.repo} on ${machine}`;
  if (i.dirty.length) {
    const files = i.dirty.slice(0, 5).map((l) => l.trim()).join(", ");
    return `${at} has uncommitted changes (${files}${i.dirty.length > 5 ? ", …" : ""}); commit or stash them there first.`;
  }
  if (!i.branch) return `${at} isn't on a branch (detached at ${i.head?.slice(0, 7) ?? "?"}); check out the branch to update there first (git checkout main).`;
  if (!i.upstream) return `${i.branch} in ${at} has no upstream branch to pull from; set one there first (git branch -u origin/${i.branch}).`;
  if (!i.bun) return `bun isn't on ${machine}'s login shell PATH (nor in ~/.bun/bin), and it's needed to ${i.kind === "binary" ? "build servedev" : "install its dependencies"} there.`;
  return undefined;
}

export interface UpdateReport {
  ok: boolean;
  kind: "source" | "binary";
  repo: string;
  branch: string;
  before: { commit: string; version?: string };
  after?: { commit: string; version?: string };
  /** The pulled commits, newest first ("abc1234 Subject"). */
  commits: string[];
  /** What was done, in order. */
  done: string[];
  /** Why it stopped partway, and what to do. */
  error?: string;
  hint?: string;
  restarted: boolean;
  hubVersion: string;
}

const short = (sha: string | undefined) => (sha ?? "").slice(0, 7);

/** Compares versions like 0.10.1 and 0.9.0 by number: negative, 0 or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Last lines of a command's output, for errors. */
function tail(r: { stdout: string; stderr: string; code: number }, lines = 8): string {
  const out = `${r.stdout}\n${r.stderr}`.replace(/\0/g, "").trim().split("\n").filter((l) => l.trim() && !l.startsWith("@"));
  return out.slice(-lines).join("\n") || `exit ${r.code}`;
}

/**
 * Update servedev on the machine. Refusals throw (409) before anything changes there; a step
 * that fails after the pull returns a report with `error`, saying what state it was left in.
 */
export async function updateServedev(t: Transport, machine: string, hubVersion: string): Promise<UpdateReport> {
  const probed = await t.run(INSTALL_PROBE, { timeoutMs: 60_000 });
  const install = parseInstall(probed.stdout);
  const refused = refusal(machine, install);
  if (refused) throw new RefError(409, refused);
  const repo = posixQuote(install.repo!);
  const report: UpdateReport = {
    ok: false,
    kind: install.kind as "source" | "binary",
    repo: install.repo!,
    branch: install.branch!,
    before: { commit: short(install.head), version: install.version },
    commits: [],
    done: [],
    restarted: false,
    hubVersion,
  };
  const fail = (error: string, hint?: string) => ({ ...report, error, hint });
  // bun's own scripts (bun run build) call `bun` by name.
  const bun = posixQuote(install.bun!);
  const withBun = `export PATH="$(dirname ${bun}):$PATH"; cd ${repo} &&`;

  const fetched = await t.run(`cd ${repo} && git fetch --quiet 2>&1 && echo "@behind $(git rev-list --count HEAD..'@{u}')" && echo "@ahead $(git rev-list --count '@{u}'..HEAD)"`, { timeoutMs: 120_000 });
  const behind = Number(tag(fetched.stdout, "behind"));
  const ahead = Number(tag(fetched.stdout, "ahead"));
  if (fetched.code !== 0 || Number.isNaN(behind)) throw new RefError(502, `git fetch in ${install.repo} on ${machine} failed: ${tail(fetched)}`);
  if (behind > 0 && ahead > 0) {
    throw new RefError(
      409,
      `${install.branch} in ${install.repo} on ${machine} can't fast-forward: it has ${ahead} commit${ahead === 1 ? "" : "s"} that ${install.upstream} doesn't, and ${install.upstream} has ${behind} it doesn't. Merge or rebase there first.`,
    );
  }

  let head = install.head!;
  let changed: string[] = [];
  if (behind > 0) {
    const from = posixQuote(install.head!);
    const pulled = await t.run(`cd ${repo} && git pull --ff-only --quiet 2>&1 && echo "@head $(git rev-parse HEAD)" && git log --format='@commit %h %s' ${from}..HEAD | head -n 50 && git diff --name-only ${from} HEAD | sed 's/^/@file /'`, {
      timeoutMs: 120_000,
    });
    const after = tag(pulled.stdout, "head");
    if (pulled.code !== 0 || !after) throw new RefError(502, `git pull --ff-only in ${install.repo} on ${machine} failed (nothing changed there): ${tail(pulled)}`);
    head = after;
    report.commits = tags(pulled.stdout, "commit");
    changed = tags(pulled.stdout, "file");
    report.done.push(`pulled ${behind} commit${behind === 1 ? "" : "s"} from ${install.upstream} (${short(install.head)} → ${short(head)})`);
  } else report.done.push(`already up to date with ${install.upstream} (${short(head)})`);
  report.after = { commit: short(head) };

  if (changed.some((f) => /^(package\.json|bun\.lockb?)$/.test(f))) {
    const r = await t.run(`${withBun} ${bun} install 2>&1`, { timeoutMs: 600_000 });
    if (r.code !== 0) {
      return fail(`bun install in ${install.repo} on ${machine} failed: ${tail(r)}`, `the new code is checked out but its daemon still runs the old one; fix it there, then run servedev daemon restart there`);
    }
    report.done.push("installed dependencies (the lockfile changed)");
  }

  if (install.kind === "binary") {
    // Rebuilt when the pull brought commits, or when the binary is older than the checkout.
    const stale = install.builtAt !== undefined && install.committedAt !== undefined && install.builtAt < install.committedAt;
    if (behind > 0 || stale) {
      const r = await t.run(`${withBun} ${bun} run build 2>&1`, { timeoutMs: 900_000 });
      if (r.code !== 0) {
        return fail(`bun run build in ${install.repo} on ${machine} failed: ${tail(r)}`, `the new code is checked out but ${install.entry} wasn't rebuilt and its daemon still runs the old one; fix the build there, then run servedev daemon restart there`);
      }
      report.done.push(`built ${install.entry}`);
    }
  } else if (changed.some((f) => f.startsWith("ui/"))) {
    // Its own dashboard only (the hub's is this machine's); building it needs npm there too.
    report.done.push(`its own dashboard changed: to see it at ${machine}'s own address, run bun run build:ui in ${install.repo} there`);
  }

  const version = await t.run(`servedev --version 2>&1 | head -n 1`, { timeoutMs: 30_000 });
  report.after.version = version.stdout.trim().split("\n").pop()?.trim() || undefined;

  const restart = await t.run(`servedev daemon restart 2>&1`, { timeoutMs: 60_000 });
  if (restart.code !== 0 || !/running \(pid \d+\)/.test(restart.stdout)) {
    return fail(`restarting servedev's daemon on ${machine} failed: ${tail(restart)}`, `run servedev daemon restart on ${machine} (its log: ~/.servedev/daemon.log there)`);
  }
  report.restarted = true;
  report.done.push("restarted its daemon (servers keep running)");
  report.ok = true;
  return report;
}
