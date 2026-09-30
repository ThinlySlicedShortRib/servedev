/**
 * Login autostart on macOS: a LaunchAgent that starts the daemon with --autostart at login,
 * which then starts every pinned server. It only launches the daemon (no KeepAlive), so the
 * CLI can still stop and replace the daemon, e.g. after an upgrade.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DAEMON_LOG, DAEMON_PORT, HOME } from "./paths";

export const LABEL = "dev.servedev.daemon";

/** Overridable so tests never touch the real ~/Library/LaunchAgents. */
export function agentFile(): string {
  const dir = process.env.SERVEDEV_LAUNCH_AGENTS_DIR ?? path.join(os.homedir(), "Library", "LaunchAgents");
  return path.join(dir, `${LABEL}.plist`);
}

function xml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function plist(program: string[], env: Record<string, string>): string {
  const args = program.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const vars = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Servers run in their own process groups; never let launchd reap them with the daemon. -->
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(DAEMON_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(DAEMON_LOG)}</string>
</dict>
</plist>
`;
}

export interface AutostartStatus {
  supported: boolean;
  installed: boolean;
  file: string;
}

export function autostartStatus(): AutostartStatus {
  const file = agentFile();
  return { supported: process.platform === "darwin", installed: fs.existsSync(file), file };
}

/**
 * Write the LaunchAgent. It takes effect at the next login; it is not loaded now, because a
 * daemon is already running. `program` is the argv prefix that runs servedev.
 */
export function installAutostart(program: string[]): AutostartStatus {
  if (process.platform !== "darwin") return autostartStatus();
  const env: Record<string, string> = {
    // launchd's default PATH is minimal; servers started from the dashboard need the user's.
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    SERVEDEV_HOME: HOME,
    SERVEDEV_PORT: String(DAEMON_PORT),
  };
  const file = agentFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist([...program, "daemon", "run", "--autostart"], env));
  return autostartStatus();
}

export function uninstallAutostart(): AutostartStatus {
  fs.rmSync(agentFile(), { force: true });
  return autostartStatus();
}
