import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { platform, platformFor } from "../src/platform";
import { plist } from "../src/platform/posix";
import { WindowsUnsupported } from "../src/platform/windows";

test("the platform follows the OS: native Windows gets its own, everything else posix", () => {
  expect(platformFor("win32").name).toBe("windows");
  for (const os of ["darwin", "linux", "freebsd"] as const) expect(platformFor(os).name).toBe("posix");
  expect(platform.name).toBe(process.platform === "win32" ? "windows" : "posix");
});

test("native Windows says plainly that it isn't supported yet", async () => {
  const win = platformFor("win32");
  expect(() => win.processTable()).toThrow(WindowsUnsupported);
  expect(() => win.spawnShell("echo", { cwd: "/", env: {}, stdio: ["ignore", "ignore", "ignore"] })).toThrow(/native Windows isn't supported yet/);
  expect(() => win.autostartStatus()).toThrow(WindowsUnsupported);
  // Read when paths.ts loads, so it must not throw.
  expect(win.defaultHome()).toMatch(/servedev$/);
});

test("posix shell commands run with /bin/sh -c", () => {
  expect(platformFor("linux").shellArgv("echo hi")).toEqual(["/bin/sh", "-c", "echo hi"]);
});

test("posix groups: a spawned shell gets its own group, and stopGroups ends it", async () => {
  if (process.platform === "win32") return;
  const posix = platformFor("darwin");
  const child = posix.spawnShell("sleep 30 & sleep 30; wait", { cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "ignore"] });
  child.unref();
  const pgid = child.pid!;
  await Bun.sleep(100);
  expect(posix.groupAlive(pgid)).toBe(true);
  expect((await posix.processTable()).filter((p) => p.pgid === pgid).length).toBeGreaterThanOrEqual(2);
  await posix.stopGroups(() => [pgid]);
  expect(posix.groupAlive(pgid)).toBe(false);
});

test("the LaunchAgent sends the daemon's output to the log it's given", () => {
  const xml = plist(["/usr/local/bin/servedev"], { SERVEDEV_PORT: "7777" }, "/tmp/a&b/daemon.log");
  expect(xml).toContain("<string>/usr/local/bin/servedev</string>");
  expect(xml).toContain("<key>StandardOutPath</key>\n  <string>/tmp/a&amp;b/daemon.log</string>");
});

test("posix autostart writes the LaunchAgent where SERVEDEV_LAUNCH_AGENTS_DIR says (macOS only)", () => {
  if (process.platform !== "darwin") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-agents-"));
  const before = process.env.SERVEDEV_LAUNCH_AGENTS_DIR;
  process.env.SERVEDEV_LAUNCH_AGENTS_DIR = dir;
  try {
    const posix = platformFor("darwin");
    const st = posix.installAutostart({ program: ["/x/servedev"], home: "/h", port: 9, log: "/h/daemon.log" });
    expect(st).toEqual({ supported: true, installed: true, file: path.join(dir, "dev.servedev.daemon.plist") });
    const xml = fs.readFileSync(st.file, "utf8");
    expect(xml).toContain("<string>--autostart</string>");
    expect(xml).toContain("<key>SERVEDEV_HOME</key>\n    <string>/h</string>");
    expect(posix.uninstallAutostart().installed).toBe(false);
  } finally {
    if (before === undefined) delete process.env.SERVEDEV_LAUNCH_AGENTS_DIR;
    else process.env.SERVEDEV_LAUNCH_AGENTS_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
