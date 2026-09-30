/** Running platform CLIs for account providers. */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command. `env` extends the daemon's environment (tests point gcloud and gh at copies of
 * their config with CLOUDSDK_CONFIG / GH_CONFIG_DIR). Never interactive: stdin is closed.
 */
export async function run(argv: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 20_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Run and return trimmed stdout, or throw with the command's own error text. */
export async function runOk(argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }): Promise<string> {
  const r = await run(argv, opts);
  if (r.code !== 0) throw new Error(errorText(r.stderr || r.stdout) || `${argv[0]} exited with ${r.code}`);
  return r.stdout.trim();
}

/**
 * The useful part of a CLI's error output: from its "ERROR:" / "error:" line when there is one
 * (gcloud prints warnings before it and advice after), else the last few lines.
 */
export function errorText(output: string): string {
  const lines = output.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const at = lines.findIndex((l) => /^(error|fatal)\b:?/i.test(l));
  const picked = at >= 0 ? lines.slice(at, at + 6) : lines.slice(-3);
  return picked.join(" ").replace(/^ERROR:\s*(\([\w.]+\)\s*)?/i, "").replace(/\s+/g, " ");
}

/** Shell command via sh -c (for JSON providers). */
export function sh(command: string, opts?: { env?: Record<string, string>; timeoutMs?: number }) {
  return run(["/bin/sh", "-c", command], opts);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function hasCommand(name: string): Promise<boolean> {
  return !!Bun.which(name);
}
