import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deletedRoot, detectExternal, launcherOf, subtree, suggestName } from "../src/external";
import { parsePs, type Listener } from "../src/ports";

const table = parsePs(`
    1     0     1 /sbin/launchd
  500     1   500 /bin/zsh -l
  600   500   600 node /opt/homebrew/bin/pnpm --filter web exec vite --port 5213
  601   600   600 node ./node_modules/.bin/vite --port 5213
  602   601   600 esbuild --service
  700     1   700 /bin/zsh -c source ~/.agent-snapshot && eval 'pnpm dev'
  701   700   700 node /opt/homebrew/bin/pnpm dev
  702   701   700 node next dev
  800     1   800 /Applications/Spotify.app/Contents/MacOS/Spotify
  900     1   900 node managed-by-servedev`);
const byPid = new Map(table.map((p) => [p.pid, p]));

test("launcherOf stops at shells, including agent -c wrappers", () => {
  expect(launcherOf(601, byPid)?.pid).toBe(600); // pnpm, not the interactive zsh
  expect(launcherOf(702, byPid)?.pid).toBe(701); // pnpm, not the agent's zsh -c wrapper
  expect(subtree(600, table).sort()).toEqual([600, 601, 602]);
});

test("detectExternal finds dev servers in projects, skips apps and managed ones", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-home-"));
  const web = path.join(home, "code", "web");
  const notes = path.join(home, "notes");
  fs.mkdirSync(path.join(web, ".git"), { recursive: true });
  fs.writeFileSync(path.join(web, "package.json"), "{}");
  fs.mkdirSync(notes);
  const listeners: Listener[] = [
    { pid: 601, pgid: 600, command: "node", port: 5213 },
    { pid: 602, pgid: 600, command: "esbuild", port: 24678 },
    { pid: 702, pgid: 700, command: "node", port: 3000 },
    { pid: 800, pgid: 800, command: "Spotify", port: 7768 },
    { pid: 900, pgid: 900, command: "node", port: 4000 },
  ];
  const cwds = new Map([
    [600, web],
    [701, notes], // listening from a folder that isn't a project
    [800, "/"],
    [900, web],
  ]);
  const found = detectExternal({ table, listeners, managed: new Set([900]), cwds, home });
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ id: "ext:600", pid: 600, cwd: web, root: web, ports: [5213, 24678], pids: [600, 601, 602] });
  expect(found[0].command).toBe("node /opt/homebrew/bin/pnpm --filter web exec vite --port 5213");
  fs.rmSync(home, { recursive: true });
});

test("suggestName uses the workspace filter and script, then the folder, then the program", () => {
  const root = "/h/capcon";
  expect(suggestName({ command: "node /opt/homebrew/bin/pnpm --filter api dev", cwd: root, root })).toBe("api");
  expect(suggestName({ command: "node pnpm --filter api db:studio", cwd: root, root })).toBe("api-db-studio");
  expect(suggestName({ command: "node pnpm --filter @capcon/horizon-web dev -- --force", cwd: root, root })).toBe("horizon-web");
  expect(suggestName({ command: "node pnpm --filter @capcon/horizon-web exec vite --port 5213", cwd: root, root })).toBe("horizon-web");
  expect(suggestName({ command: "node vite.js --port 5213", cwd: root + "/apps/web", root })).toBe("web");
  expect(suggestName({ command: "cloud-sql-proxy --port 5433", cwd: root, root })).toBe("cloud-sql-proxy");
  expect(suggestName({ command: "node server.js", cwd: root, root })).toBe("dev");
});

test("deletedRoot names a removed worktree by its folder", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-wt-"));
  expect(deletedRoot(path.join(base, "feat-x", "apps", "api"))).toBe(path.join(base, "feat-x"));
  fs.rmSync(base, { recursive: true });
});
