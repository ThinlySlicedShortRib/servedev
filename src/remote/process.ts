/** Child processes behind an interface, so the SSH layer can be tested without SSH. */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface LongProc {
  readonly exited: Promise<number>;
  /** What it printed to stderr so far (why ssh gave up, usually). */
  stderr(): string;
  kill(): void;
}

export interface Spawner {
  run(argv: string[], opts?: { timeoutMs?: number }): Promise<RunResult>;
  /** A process that keeps running; stdin stays open (and empty) until it's killed. */
  spawn(argv: string[]): LongProc;
}

export const bunSpawner: Spawner = {
  async run(argv, opts = {}) {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = opts.timeoutMs ? setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs) : undefined;
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (proc.signalCode === "SIGKILL" && opts.timeoutMs) return { code: 124, stdout, stderr: `${stderr}timed out after ${Math.round(opts.timeoutMs / 1000)}s`.trim() };
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  },
  spawn(argv) {
    // stdin is a pipe we never write to: a remote command reading it sees EOF only when we go away.
    const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    let err = "";
    void (async () => {
      const reader = proc.stderr.pipeThrough(new TextDecoderStream()).getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        err = (err + value).slice(-4000);
      }
    })().catch(() => {});
    return {
      exited: proc.exited,
      stderr: () => err,
      kill: () => {
        try {
          proc.kill();
        } catch {}
      },
    };
  },
};
