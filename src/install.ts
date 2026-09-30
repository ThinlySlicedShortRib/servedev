/**
 * Package manager detection and install planning.
 *
 * Declared intent beats lockfiles: a monorepo package can carry its own package-lock.json
 * (e.g. for CI's `npm ci`) while local development goes through the pnpm workspace above it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

const MANAGERS: PackageManager[] = ["pnpm", "yarn", "bun", "npm"];

const LOCKFILES: Record<PackageManager, string[]> = {
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
  npm: ["package-lock.json"],
};

export interface InstallPlan {
  pm: PackageManager;
  /** Folder the install runs in: the workspace root, or the folder holding the lockfile. */
  dir: string;
  /** The install command itself, run in `dir`. */
  command: string;
  /** Shell snippet that runs the install from the server's working directory. */
  setup: string;
  /** Why this package manager, e.g. "found pnpm-workspace.yaml". */
  reason: string;
  state: "missing" | "stale" | "ok" | "unknown";
  /** One sentence about `state`. */
  detail: string;
}

/** dir, then its parents up to and including root (or the filesystem root if dir is outside it). */
function ancestors(dir: string, root: string): string[] {
  const out: string[] = [];
  let cur = dir;
  while (true) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (cur === root || parent === cur) return out;
    cur = parent;
  }
}

function readPackageJson(dir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function tildify(p: string) {
  const home = os.homedir();
  return p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

export function resolvePackageManager(dir: string, root: string): { pm: PackageManager; reason: string } {
  const dirs = ancestors(dir, root);
  for (const d of dirs) {
    const field = readPackageJson(d)?.packageManager;
    const name = typeof field === "string" ? (field.split("@")[0] as PackageManager) : undefined;
    if (name && MANAGERS.includes(name)) {
      return { pm: name, reason: `"packageManager": "${field}" in ${tildify(path.join(d, "package.json"))}` };
    }
  }
  const ws = dirs.find((d) => fs.existsSync(path.join(d, "pnpm-workspace.yaml")));
  if (ws) return { pm: "pnpm", reason: `found ${tildify(path.join(ws, "pnpm-workspace.yaml"))}` };
  for (const d of dirs) {
    for (const pm of ["bun", "pnpm", "yarn", "npm"] as PackageManager[]) {
      const lock = LOCKFILES[pm].find((f) => fs.existsSync(path.join(d, f)));
      if (lock) return { pm, reason: `found ${tildify(path.join(d, lock))}` };
    }
  }
  return { pm: "npm", reason: "no lockfile found, so npm" };
}

export function detectPackageManager(dir: string, root: string): PackageManager {
  return resolvePackageManager(dir, root).pm;
}

/** The nearest workspace root for this package manager, else the nearest folder with its lockfile, else dir. */
function installDir(pm: PackageManager, dir: string, root: string): string {
  const dirs = ancestors(dir, root);
  const workspace = dirs.find((d) =>
    pm === "pnpm" ? fs.existsSync(path.join(d, "pnpm-workspace.yaml")) : readPackageJson(d)?.workspaces !== undefined,
  );
  if (workspace) return workspace;
  return dirs.find((d) => LOCKFILES[pm].some((f) => fs.existsSync(path.join(d, f)))) ?? dir;
}

function mtime(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Whether dependencies in `dir` are installed and match the lockfile. */
function installState(pm: PackageManager, dir: string): Pick<InstallPlan, "state" | "detail"> {
  const lockName = LOCKFILES[pm].find((f) => fs.existsSync(path.join(dir, f)));
  const lock = lockName && path.join(dir, lockName);
  const nm = path.join(dir, "node_modules");
  const newerThan = (marker: string) => {
    const m = mtime(marker);
    return m === undefined || (mtime(lock!) ?? 0) - m > 1000;
  };

  // Yarn Plug'n'Play has no node_modules at all.
  if (pm === "yarn" && fs.existsSync(path.join(dir, ".pnp.cjs"))) {
    if (lock && newerThan(path.join(dir, ".yarn", "install-state.gz"))) {
      return { state: "stale", detail: `${lockName} is newer than the last install.` };
    }
    return { state: "ok", detail: "Dependencies look up to date." };
  }
  if (!fs.existsSync(nm)) return { state: "missing", detail: "node_modules is missing." };
  if (!lock) return { state: "unknown", detail: "There is no lockfile to compare the install against." };

  switch (pm) {
    case "pnpm": {
      // pnpm keeps a copy of the lockfile it installed from. It doesn't rewrite any marker on a
      // no-op install, so compare contents rather than timestamps.
      const installed = path.join(nm, ".pnpm", "lock.yaml");
      if (!fs.existsSync(installed)) return { state: "stale", detail: "There is no record of the last pnpm install." };
      const same = fs.readFileSync(installed).equals(fs.readFileSync(lock));
      return same
        ? { state: "ok", detail: "Dependencies match pnpm-lock.yaml." }
        : { state: "stale", detail: "pnpm-lock.yaml has changed since the last install." };
    }
    case "npm":
      // npm refreshes its hidden lockfile on every install, including no-ops.
      return newerThan(path.join(nm, ".package-lock.json"))
        ? { state: "stale", detail: "package-lock.json is newer than the last install." }
        : { state: "ok", detail: "Dependencies look up to date." };
    case "yarn": {
      const marker = [".yarn-integrity", ".yarn-state.yml"].map((f) => path.join(nm, f)).find((f) => fs.existsSync(f));
      if (!marker) return { state: "unknown", detail: "yarn left no install record to compare against." };
      return newerThan(marker)
        ? { state: "stale", detail: "yarn.lock is newer than the last install." }
        : { state: "ok", detail: "Dependencies look up to date." };
    }
    case "bun":
      return { state: "unknown", detail: "bun keeps no install record, so servedev can't tell whether it's current." };
  }
}

function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** How to install JS dependencies for a server running in `dir`; undefined when there is no package.json there. */
export function planInstall(dir: string, root: string): InstallPlan | undefined {
  if (!fs.existsSync(path.join(dir, "package.json"))) return undefined;
  const { pm, reason } = resolvePackageManager(dir, root);
  const where = installDir(pm, dir, root);
  const hasDeps = (d: string) => {
    const pkg = readPackageJson(d);
    return ["dependencies", "devDependencies", "optionalDependencies"].some((k) => Object.keys((pkg?.[k] as object) ?? {}).length > 0);
  };
  // A workspace root may list no deps itself while its packages do, so check both.
  const nothingToInstall = !hasDeps(dir) && !hasDeps(where) && !readPackageJson(where)?.workspaces && !fs.existsSync(path.join(where, "pnpm-workspace.yaml"));
  // No TTY: pnpm would otherwise stop at "modules directories will be removed… Proceed?" and skip the install.
  const command = pm === "pnpm" ? "pnpm install --config.confirmModulesPurge=false" : `${pm} install`;
  return {
    pm,
    dir: where,
    command,
    // A subshell, so the server command still starts in its own directory.
    setup: where === dir ? command : `(cd ${shq(where)} && ${command})`,
    reason,
    ...(nothingToInstall ? { state: "ok" as const, detail: "package.json lists no dependencies." } : installState(pm, where)),
  };
}

/** e.g. "pnpm install in ~/code/app (found ~/code/app/pnpm-workspace.yaml)" */
export function describeInstall(plan: InstallPlan): string {
  return `${plan.command.split(" --")[0]} in ${tildify(plan.dir)} (${plan.reason})`;
}
