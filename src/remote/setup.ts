/**
 * Connecting to a machine, step by step: the "Add machine" checklist, also run on every reconnect.
 * A step that fails stops the rest and carries a hint for fixing it.
 */
import type { SetupStep, StepId } from "./types";

export const STEP_LABELS: Record<StepId, string> = {
  ssh: "SSH connection",
  os: "Operating system",
  servedev: "servedev installed and running",
  token: "API token",
  api: "servedev API through the tunnel",
};
const ORDER: StepId[] = ["ssh", "os", "servedev", "token", "api"];

export class StepError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

export interface StepOutcome {
  detail?: string;
  /** Worked, but something needs attention (e.g. versions differ). */
  warning?: string;
  hint?: string;
}

export class Checklist {
  readonly steps: SetupStep[] = [];
  private failed = false;

  get ok(): boolean {
    return !this.failed;
  }

  get failure(): SetupStep | undefined {
    return this.steps.find((s) => s.status === "failed");
  }

  /** Runs a step unless an earlier one failed. Returns whether it succeeded. */
  async step(id: StepId, fn: () => Promise<StepOutcome>): Promise<boolean> {
    if (this.failed) return false;
    try {
      const r = await fn();
      this.steps.push({
        id,
        label: STEP_LABELS[id],
        status: r.warning ? "warning" : "ok",
        detail: r.warning ? [r.detail, r.warning].filter(Boolean).join("; ") : r.detail,
        hint: r.hint,
      });
      return true;
    } catch (e) {
      this.failed = true;
      this.steps.push({ id, label: STEP_LABELS[id], status: "failed", detail: (e as Error).message, hint: (e as { hint?: string }).hint });
      return false;
    }
  }

  /** Every step, with the ones that never ran marked skipped. */
  result(): SetupStep[] {
    const done = new Set(this.steps.map((s) => s.id));
    return [...this.steps, ...ORDER.filter((id) => !done.has(id)).map((id): SetupStep => ({ id, label: STEP_LABELS[id], status: "skipped" }))];
  }
}

/**
 * Finds servedev on the machine, starts its daemon if needed (any command does), and reads its
 * port and token. Lines are tagged so stray output from login scripts doesn't confuse parsing.
 */
export const SERVEDEV_PROBE = [
  `if ! command -v servedev >/dev/null 2>&1; then echo "@missing"; exit 0; fi`,
  `echo "@path $(command -v servedev)"`,
  `echo "@version $(servedev --version 2>&1 | head -n 1)"`,
  `servedev config status >/dev/null 2>&1`,
  `echo "@status $(servedev daemon status 2>&1 | head -n 1)"`,
  `h="\${SERVEDEV_HOME:-$HOME/.servedev}"`,
  `echo "@home $h"`,
  `echo "@token $(cat "$h/token" 2>/dev/null)"`,
].join("\n");

export interface ServedevProbe {
  missing: boolean;
  path?: string;
  version?: string;
  running: boolean;
  /** The daemon's port, from `servedev daemon status`. */
  port?: number;
  status?: string;
  home?: string;
  token?: string;
}

export function parseServedevProbe(stdout: string): ServedevProbe {
  const tag = (name: string) => {
    const line = stdout.split("\n").find((l) => l.startsWith(`@${name}`));
    return line === undefined ? undefined : line.slice(name.length + 1).trim();
  };
  if (tag("missing") !== undefined) return { missing: true, running: false };
  const status = tag("status");
  const m = status?.match(/running \(pid \d+\) at http:\/\/[^:]+:(\d+)/);
  return {
    missing: false,
    path: tag("path"),
    version: tag("version") || undefined,
    running: !!m,
    port: m ? Number(m[1]) : undefined,
    status,
    home: tag("home"),
    token: tag("token") || undefined,
  };
}

export function missingHint(kind: "posix" | "wsl" | undefined, machine: string): string {
  const where = kind === "wsl" ? "inside WSL" : `on ${machine}`;
  const check = kind === "wsl" ? `wsl.exe -e bash -lc 'servedev --version'` : `bash -lc 'servedev --version'`;
  return `Install servedev ${where} and put it on the login shell's PATH (e.g. ~/.local/bin/servedev); \`${check}\` there should print its version. Then run servedev remote reconnect ${machine}.`;
}
