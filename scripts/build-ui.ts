/**
 * Builds the dashboard (ui/) into ui/dist without a moment where ui/dist/index.html is missing:
 * Vite builds into ui/node_modules/.dist-next (out of the way of git and of Vite's dev watcher),
 * then each file is renamed over its old copy. A daemon run from source with `bun --watch` (dev
 * mode) imports that file and reloads when it changes; with Vite emptying ui/dist first, it
 * reloaded while the file was gone.
 *
 * Dependencies are installed with `npm ci` when the lockfile is newer than ui/node_modules, so a
 * build never rewrites the tracked package-lock.json (`npm install` can, and then `servedev
 * remote update` refuses the dirty checkout).
 */
import fs from "node:fs";
import path from "node:path";

const ui = path.resolve(import.meta.dirname, "..", "ui");
const dist = path.join(ui, "dist");
const next = path.join(ui, "node_modules", ".dist-next");

function run(argv: string[]) {
  const p = Bun.spawnSync(argv, { cwd: ui, stdio: ["ignore", "inherit", "inherit"] });
  if (p.exitCode !== 0) {
    console.error(`${argv.join(" ")} failed (exit ${p.exitCode})`);
    process.exit(p.exitCode || 1);
  }
}

const mtime = (f: string) => fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0;
// npm writes node_modules/.package-lock.json on every install.
const installed = mtime(path.join(ui, "node_modules", ".package-lock.json"));
if (!installed || installed < mtime(path.join(ui, "package-lock.json")) || installed < mtime(path.join(ui, "package.json"))) run(["npm", "ci"]);

run(["npm", "run", "build", "--", "--outDir", path.relative(ui, next), "--emptyOutDir"]);

fs.mkdirSync(dist, { recursive: true });
const built = fs.readdirSync(next);
// index.html last, so the rest of the build is in place when the daemon reloads.
for (const name of built.sort((a, b) => Number(a === "index.html") - Number(b === "index.html"))) {
  const to = path.join(dist, name);
  if (fs.statSync(path.join(next, name)).isDirectory()) fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(path.join(next, name), to);
}
for (const name of fs.readdirSync(dist)) if (!built.includes(name)) fs.rmSync(path.join(dist, name), { recursive: true, force: true });
fs.rmSync(next, { recursive: true, force: true });
