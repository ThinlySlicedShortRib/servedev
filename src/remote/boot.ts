/**
 * Starting servedev when a Windows PC boots into WSL. WSL stops its VM (and every server in it)
 * once no Windows process is attached, so a logon task runs a script that starts servedev and then
 * stays attached. `conhost --headless` keeps the task from opening a console window, and the
 * execution limit is lifted (Task Scheduler stops tasks after 3 days by default).
 */
import { posixQuote } from "./transport";

export const BOOT_TASK = "servedev-wsl";

export const BOOT_SCRIPT = `#!/bin/bash
# Run at Windows logon by the "${BOOT_TASK}" scheduled task (servedev remote boot).
# Starts servedev with its pinned servers, then keeps WSL running so they stay up.
if ! servedev daemon status 2>/dev/null | grep -q running; then
  setsid servedev daemon run --autostart >>"\${SERVEDEV_HOME:-$HOME/.servedev}/daemon.log" 2>&1 </dev/null &
fi
exec sleep infinity
`;

/** Writes the boot script on the machine (inside WSL) and prints where. */
export function writeBootScript(): string {
  return [
    `h="\${SERVEDEV_HOME:-$HOME/.servedev}"`,
    `mkdir -p "$h"`,
    `f="$h/wsl-boot.sh"`,
    `printf '%s' ${posixQuote(BOOT_SCRIPT)} > "$f"`,
    `chmod 755 "$f"`,
    `echo "@file $f"`,
  ].join("\n");
}

/** PowerShell that registers the logon task (run on the PC, in Windows). */
export function bootTaskPowerShell(distro: string | undefined, scriptPath: string): string {
  const args = `--headless wsl.exe ${distro ? `-d ${distro} ` : ""}-e /bin/bash -l ${scriptPath}`;
  return [
    `$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '${args.replace(/'/g, "''")}'`,
    `$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    `$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable`,
    `Register-ScheduledTask -TaskName '${BOOT_TASK}' -Action $a -Trigger $t -Settings $s -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${BOOT_TASK}'`,
  ].join("; ");
}

/** The same, as a command cmd.exe can run over SSH without any quoting trouble. */
export function encodedPowerShell(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
