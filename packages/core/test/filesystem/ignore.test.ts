import { expect, test } from "bun:test"
import { Ignore } from "@graphagent/core/filesystem/ignore"

test("match nested and non-nested", () => {
  expect(Ignore.match("node_modules/index.js")).toBe(true)
  expect(Ignore.match("node_modules")).toBe(true)
  expect(Ignore.match("node_modules/")).toBe(true)
  expect(Ignore.match("node_modules/bar")).toBe(true)
  expect(Ignore.match("node_modules/bar/")).toBe(true)
})

test("excludes product worktrees at any depth", () => {
  expect(Ignore.match(".agents/worktree/wt-01/src/index.ts")).toBe(true)
  expect(Ignore.match("packages/app/.agents/worktree/wt-02/README.md")).toBe(true)
  expect(Ignore.match(".agents/hooks.json")).toBe(false)
  expect(Ignore.match("src/worktree/index.ts")).toBe(false)
})

test("identifies worktree paths without matching lookalikes", () => {
  expect(Ignore.isWorktreePath(".agents/worktree/")).toBe(true)
  expect(Ignore.isWorktreePath(".agents/worktree/wt-01")).toBe(true)
  expect(Ignore.isWorktreePath("packages/app/.agents/worktree/wt-02/src/index.ts")).toBe(true)
  expect(Ignore.isWorktreePath(".agents/worktree-notes.md")).toBe(false)
  expect(Ignore.isWorktreePath(".agents/plans/worktree.md")).toBe(false)
  expect(Ignore.isWorktreePath("src/worktree/index.ts")).toBe(false)
})
