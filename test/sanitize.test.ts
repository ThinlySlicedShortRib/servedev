import { describe, expect, test } from "bun:test";

import { maskSecrets, portableCommand, portablePaths, stripSecrets } from "../src/sanitize";

const onPath = (bin: string) => (["pnpm", "node", "cloud-sql-proxy", "npm"].includes(bin) ? `/opt/homebrew/bin/${bin}` : null);
const ctx = { root: "/Users/me/code/app", cwd: "/Users/me/code/app/apps/api", home: "/Users/me", which: onPath };

describe("stripSecrets", () => {
  test("cloud-sql-proxy with access tokens (the real take-over case)", () => {
    const cmd = "cloud-sql-proxy --auto-iam-authn --token=ya29.a0AbCdEfGhIjKlMnOp --login-token ya29.QrStUvWxYz0123456789 proj:region:db --port=5437";
    const r = stripSecrets(cmd);
    expect(r.command).toBe("cloud-sql-proxy --auto-iam-authn proj:region:db --port=5437");
    expect(r.removed).toEqual(["--token (a credential)", "--login-token (a credential)"]);
  });

  test("token shapes anywhere, secret env assignments, URL passwords", () => {
    expect(stripSecrets("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 DEBUG=1 node server.js").command).toBe("DEBUG=1 node server.js");
    expect(stripSecrets("app --stripe sk_live_abcdefghijklmnop --x eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4").command).toBe("app --stripe --x");
    expect(stripSecrets("psql postgres://me:hunter2@localhost/db").command).toBe("psql postgres://me@localhost/db");
    expect(stripSecrets("aws --key-file ./k.pem --password-stdin").command).toBe("aws --key-file ./k.pem --password-stdin");
    expect(stripSecrets("x -p secretvalue --pass=abc").removed).toEqual(["--pass (a credential)"]);
  });
});

describe("maskSecrets", () => {
  test("keeps commands readable while hiding values", () => {
    expect(maskSecrets("cloud-sql-proxy --token=ya29.a0AbCdEfGhIjKlMnOp --login-token ya29.QrStUvWxYz0123456789 db")).toBe(
      "cloud-sql-proxy --token=… --login-token … db",
    );
    expect(maskSecrets("API_KEY=abc node x --password hunter2 postgres://u:p@h")).toBe("API_KEY=… node x --password … postgres://u:…@h");
  });
});

describe("portablePaths", () => {
  test("tool binaries on PATH become their names, dropping the runtime that launched them", () => {
    expect(portablePaths("node /opt/homebrew/bin/pnpm --filter api db:studio", ctx).command).toBe("pnpm --filter api db:studio");
    expect(portablePaths("/Users/me/.nvm/versions/node/v20/bin/node /opt/homebrew/bin/pnpm dev", ctx).command).toBe("pnpm dev");
    expect(portablePaths("/opt/homebrew/bin/cloud-sql-proxy db", ctx).command).toBe("cloud-sql-proxy db");
  });

  test("project paths become relative to where it runs; home paths use ~; others are flagged", () => {
    const r = portablePaths("node /Users/me/code/app/apps/api/dist/main.js --config=/Users/me/.config/x.json --data /var/lib/thing", ctx);
    expect(r.command).toBe("node ./dist/main.js --config=~/.config/x.json --data /var/lib/thing");
    expect(r.warnings).toEqual([
      "~/.config/x.json is outside the repo; it only works where that path exists",
      "/var/lib/thing is a path on this machine; it may not exist elsewhere",
    ]);
    expect(portablePaths("node /Users/me/code/app/scripts/x.js", ctx).command).toBe("node ../../scripts/x.js");
  });

  test("portableCommand does both", () => {
    const r = portableCommand("node /opt/homebrew/bin/pnpm dev --token=ya29.a0AbCdEfGhIjKlMnOp", ctx);
    expect(r.command).toBe("pnpm dev");
    expect(r.removed.length).toBe(1);
    expect(r.rewritten).toEqual(["node /opt/homebrew/bin/pnpm → pnpm"]);
  });
});

test("shell operators survive removing the argument before them", () => {
  expect(stripSecrets("node a.js --token=ya29.a0AbCdEfGhIjKlMnOp; exec ./server.sh").command).toBe("node a.js ; exec ./server.sh");
  expect(stripSecrets("x --password hunter2 && y").command).toBe("x && y");
  expect(stripSecrets("x --token && y").command).toBe("x && y");
  expect(maskSecrets("a --token=abc;b")).toBe("a --token=…;b");
});
