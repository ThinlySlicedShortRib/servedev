/**
 * Dev mode: the daemon from source (restarts when src/ changes) plus the dashboard on Vite with
 * hot reload. Runs in a sandbox (its own home folder and port), so a half-finished edit never
 * touches the real daemon on 7777 or the servers it runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const home = process.env.SERVEDEV_HOME ?? path.join(os.homedir(), ".servedev-dev");
const port = process.env.SERVEDEV_PORT ?? "7778";
const uiPort = process.env.SERVEDEV_UI_PORT ?? "7779";
const env = {
  ...process.env,
  SERVEDEV_HOME: home,
  SERVEDEV_PORT: port,
  // Pinning writes a LaunchAgent; keep it out of ~/Library/LaunchAgents so the real one stays.
  SERVEDEV_LAUNCH_AGENTS_DIR: path.join(home, "LaunchAgents"),
};
const daemonUrl = `http://127.0.0.1:${port}`;

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${daemonUrl}/api/health`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

if (await healthy()) {
  console.error(`a daemon is already running on ${daemonUrl}; stop it first:`);
  console.error(`  SERVEDEV_HOME=${home} SERVEDEV_PORT=${port} bun src/cli.ts daemon stop`);
  process.exit(1);
}

fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const daemon = Bun.spawn(["bun", "--watch", "src/cli.ts", "daemon", "run"], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });

// Vite reads the daemon's token when it starts, and the daemon creates it on first run.
for (let i = 0; !(await healthy()); i++) {
  if (i === 100 || daemon.exitCode !== null) {
    console.error("dev daemon failed to start");
    daemon.kill();
    process.exit(1);
  }
  await Bun.sleep(100);
}

const ui = Bun.spawn(["npx", "vite", "--port", uiPort, "--strictPort"], { cwd: path.join(root, "ui"), env, stdio: ["ignore", "inherit", "inherit"] });

console.log(`\n  dashboard (hot reload)  http://localhost:${uiPort}`);
console.log(`  daemon (watching src/) ${daemonUrl}`);
console.log(`  sandbox                ${home}`);
console.log(`  CLI against it         SERVEDEV_HOME=${home} SERVEDEV_PORT=${port} bun src/cli.ts <command>\n`);

// Servers started in the sandbox keep running after this exits, like with the real daemon.
const shutdown = () => {
  ui.kill();
  daemon.kill();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await Promise.race([daemon.exited, ui.exited]);
shutdown();
