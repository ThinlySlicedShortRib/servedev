import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitBranch } from "../src/git";

test("gitBranch reads HEAD for repos, worktrees, subfolders and detached checkouts", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "servedev-git-"));
  const repo = path.join(base, "repo");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "wt"), { recursive: true });
  fs.mkdirSync(path.join(repo, "apps", "web"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/dev\n");
  expect(gitBranch(repo)).toBe("dev");
  expect(gitBranch(path.join(repo, "apps", "web"))).toBe("dev");

  const wt = path.join(base, "wt");
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`);
  fs.writeFileSync(path.join(repo, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/feat/grid-view\n");
  expect(gitBranch(wt)).toBe("feat/grid-view");

  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "9a4def8e1c2b3a4d5e6f7a8b9c0d1e2f3a4b5c6d\n");
  expect(gitBranch(repo)).toBe("detached@9a4def8");
  expect(gitBranch(os.tmpdir())).toBeUndefined();
  fs.rmSync(base, { recursive: true });
});
