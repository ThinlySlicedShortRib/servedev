import { describe, expect, test } from "bun:test";

import { applyVars, explicitPart, isNoisy, looksSecret, maskValue, migrateSnapshot, parseEnvOutput } from "../src/env";

const login = { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/me", LANG: "en_US.UTF-8", NPM_TOKEN: "npm_abc" };

describe("explicitPart", () => {
  test("keeps only what differs from the login shell, minus session noise and machine values", () => {
    const full = {
      ...login,
      PATH: "/some/agent/shim:/usr/bin", // differs, but PATH comes from the login shell
      DATABASE_URL: "postgres://localhost/app",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDECODE: "1",
      CMUX_SOCKET: "/tmp/s",
      NODE_OPTIONS: "--require=/tmp/shim.js",
      TERM_PROGRAM: "ghostty",
      PWD: "/Users/me/app",
      GIT_EDITOR: "true",
      npm_config_yes: "true",
    };
    expect(explicitPart(full, login)).toEqual({ DATABASE_URL: "postgres://localhost/app" });
  });
});

describe("migrateSnapshot", () => {
  test("reports names only, and splits secret-looking ones into dropped and kept", () => {
    const stored = { ...login, CLAUDE_CODE_MESSAGING_TOKEN: "t", STRIPE_SECRET_KEY: "sk_test_1", DEBUG: "1", SHLVL: "2" };
    const { env, report } = migrateSnapshot("p:web", stored, login);
    expect(env).toEqual({ STRIPE_SECRET_KEY: "sk_test_1", DEBUG: "1" });
    expect(report).toEqual({
      id: "p:web",
      before: 8,
      kept: ["DEBUG", "STRIPE_SECRET_KEY"],
      secretsDropped: ["CLAUDE_CODE_MESSAGING_TOKEN", "NPM_TOKEN"],
      secretsKept: ["STRIPE_SECRET_KEY"],
    });
    expect(JSON.stringify(report)).not.toContain("sk_test_1");
  });

  test("is idempotent: migrating the result again changes nothing", () => {
    const once = migrateSnapshot("a", { ...login, FOO: "bar" }, login).env;
    expect(migrateSnapshot("a", once, login).env).toEqual(once);
  });
});

describe("helpers", () => {
  test("applyVars merges and removes with empty values", () => {
    expect(applyVars({ A: "1", B: "2" }, { B: "", C: "3" })).toEqual({ A: "1", C: "3" });
  });
  test("parseEnvOutput skips banners before the marker", () => {
    expect(parseEnvOutput("Welcome!\n__servedev_env__A=1\0B=x=y\0")).toEqual({ A: "1", B: "x=y" });
    expect(parseEnvOutput("no marker")).toEqual({});
  });
  test("classification", () => {
    expect(looksSecret("GITHUB_TOKEN")).toBe(true);
    expect(looksSecret("api_key")).toBe(true);
    expect(looksSecret("DEBUG")).toBe(false);
    expect(isNoisy("VSCODE_PID")).toBe(true);
    expect(isNoisy("DATABASE_URL")).toBe(false);
    expect(maskValue("sk_live_123")).toBe("sk_l…");
    expect(maskValue("ab")).toBe("…");
  });
});
