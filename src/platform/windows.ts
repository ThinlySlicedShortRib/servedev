/**
 * Native Windows (not WSL, which is Linux and uses posix.ts). Not implemented yet: every method
 * throws, so the shape is fixed and anything that reaches one says so plainly. The plan, per method:
 * ports from `netstat -ano`; processes from Win32_Process; servers spawned via pwsh/cmd inside a
 * Job Object (the "group"); stopping with Ctrl+Break then `taskkill /T /F`; the environment from
 * the registry; files under %LOCALAPPDATA%; login autostart as a scheduled task.
 */
import os from "node:os";
import path from "node:path";
import type { Platform } from "./types";

export class WindowsUnsupported extends Error {
  constructor(what: string) {
    super(`native Windows isn't supported yet (${what}); run servedev inside WSL for now`);
  }
}

const no = (what: string) => (): never => {
  throw new WindowsUnsupported(what);
};

export const windows: Platform = {
  name: "windows",
  listeners: no("listing ports"),
  processTable: no("listing processes"),
  cwdsOf: no("process folders"),
  startTimesOf: no("process start times"),
  spawnShell: no("starting servers"),
  shellArgv: no("running shell commands"),
  groupAlive: no("checking processes"),
  signalGroups: no("stopping processes"),
  stopGroups: no("stopping servers"),
  stopPids: no("stopping processes"),
  loginShellEnv: no("reading the login environment"),
  // Read when paths.ts loads, so it can't throw; where phase 1 will keep servedev's files.
  defaultHome: () => path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "servedev"),
  pickFolder: no("the folder picker"),
  openUrl: no("opening the browser"),
  autostartStatus: no("login autostart"),
  installAutostart: no("login autostart"),
  uninstallAutostart: no("login autostart"),
};
