/**
 * Login autostart: starts the daemon with --autostart at login, which then starts every pinned
 * server. How depends on the OS (a LaunchAgent on macOS; see src/platform).
 */
import { DAEMON_LOG, DAEMON_PORT, HOME } from "./paths";
import { platform, type AutostartStatus } from "./platform";

export type { AutostartStatus };

export function autostartStatus(): AutostartStatus {
  return platform.autostartStatus();
}

/** Install the login item; it takes effect at the next login. `program` is the argv prefix that runs servedev. */
export function installAutostart(program: string[]): AutostartStatus {
  return platform.installAutostart({ program, home: HOME, port: DAEMON_PORT, log: DAEMON_LOG });
}

export function uninstallAutostart(): AutostartStatus {
  return platform.uninstallAutostart();
}
