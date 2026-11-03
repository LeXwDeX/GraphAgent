import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DagIsolation } from "@/dag/isolation"
import { recoverIsolatedWorktree } from "@/dag/runtime/worktree-completion"
import { Worktree } from "@/worktree"
import { Effect, Layer } from "effect"
import { makeNodeRow } from "./fixtures"

const roots: string[] = []

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()
}

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "dag-isolation-"))
  roots.push(root)
  git(root, ["init"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  writeFileSync(path.join(root, "base.txt"), "base\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-m", "base"])
  return root
}

function worktree(root: string, name: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), `dag-isolation-${name}-`))
  roots.push(directory)
  rmSync(directory, { recursive: true, force: true })
  git(root, ["worktree", "add", "--detach", directory, "HEAD"])
  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("DagIsolation porcelain parsing", () => {
  it("returns raw UTF-8 filenames from git status", () => {
    const root = repo()
    git(root, ["config", "core.quotePath", "true"])
    writeFileSync(path.join(root, "中文.txt"), "content\n")

    expect(DagIsolation.touchedPaths(root)).toEqual(["中文.txt"])
  })

  it("normalizes modified, untracked, quoted and renamed paths", () => {
    expect(
      DagIsolation.parsePorcelain(
        [" M src/a.ts", "?? new file.ts", 'R  "old name.ts" -> "new name.ts"', "D  gone.ts", ""].join("\n"),
      ),
    ).toEqual(["gone.ts", "new file.ts", "new name.ts", "src/a.ts"].sort())
  })

  it("deduplicates repeated paths", () => {
    expect(DagIsolation.parsePorcelain(" M a.ts\nM  a.ts\n")).toEqual(["a.ts"])
  })
})

describe("DagIsolation worktree commits", () => {
  it("fails completion when an active worktree is missing", () => {
    const root = repo()
    const directory = path.join(root, "missing")
    const result = DagIsolation.completeWorktree({
      worktree: { directory, state: "active", touchedPaths: [], conflictsWith: [] },
      reportRoot: root,
      dagID: "dag_1",
      nodeID: "node-1",
      message: "dag: node-1",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(directory)
  })

  for (const state of ["active", "removed", "kept"] as const)
    it(`recovers a missing worktree in ${state} state`, async () => {
      const root = repo()
      const directory = path.join(root, "missing")
      let removals = 0
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const worktreeSvc = yield* Worktree.Service
          return yield* recoverIsolatedWorktree({
            node: makeNodeRow({ worktreeDirectory: directory, worktreeState: state, touchedPaths: ["saved.txt"] }),
            dagID: "dag_1",
            ownerDirectory: root,
            worktreeSvc,
            remove: () =>
              Effect.sync(() => {
                removals++
                return true
              }),
          })
        }).pipe(Effect.provide(Layer.mock(Worktree.Service, {}))),
      )
      if (state === "active") {
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason).toContain(directory)
      } else {
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.worktree?.state).toBe(state)
          expect(result.touchedPaths).toEqual(["saved.txt"])
        }
      }
      expect(removals).toBe(0)
    })
  it("creates two commits and patches for parallel edits of the same file and reports the conflict", () => {
    const root = repo()
    const a = worktree(root, "a")
    const b = worktree(root, "b")
    const base = git(root, ["rev-parse", "HEAD"])

    writeFileSync(path.join(a, "shared.txt"), "from a\n")
    writeFileSync(path.join(b, "shared.txt"), "from b\n")

    const commitA = DagIsolation.commitWorktree(a, base, "dag: a")
    const commitB = DagIsolation.commitWorktree(b, base, "dag: b")
    expect(commitA.ok).toBe(true)
    expect(commitB.ok).toBe(true)
    if (!commitA.ok || !commitB.ok) return
    expect(commitA.change?.touchedPaths).toEqual(["shared.txt"])
    expect(commitB.change?.touchedPaths).toEqual(["shared.txt"])
    expect(commitA.change?.commit).not.toBe(commitB.change?.commit)
    expect(commitA.change?.patch).toContain("from a")
    expect(commitB.change?.patch).toContain("from b")

    expect(
      DagIsolation.conflictsFor(commitB.change!.touchedPaths, [
        { id: "a", touchedPaths: commitA.change!.touchedPaths },
      ]),
    ).toEqual([{ nodeID: "a", paths: ["shared.txt"] }])
    // The shared checkout is untouched until an integration node applies a patch.
    expect(git(root, ["status", "--porcelain"])).toBe("")
    expect(existsSync(path.join(root, "shared.txt"))).toBe(false)
  })

  it("keeps the patch after the worktree is removed", () => {
    const root = repo()
    const a = worktree(root, "a")
    const base = git(root, ["rev-parse", "HEAD"])
    writeFileSync(path.join(a, "change.txt"), "change\n")
    const commit = DagIsolation.commitWorktree(a, base, "dag: a")
    expect(commit.ok).toBe(true)
    if (!commit.ok || !commit.change) return
    const patch = DagIsolation.writePatchArtifact(root, "dag_1", "node-1", commit.change.patch)
    expect(patch.path).toBe(path.join(root, ".opencode", "workflow-reports", "dag_1", "node-1.patch"))
    expect(readFileSync(patch.path, "utf8")).toContain("change.txt")
    expect(patch.sha256).toMatch(/^[0-9a-f]{64}$/)

    git(root, ["worktree", "remove", "--force", a])
    expect(existsSync(a)).toBe(false)
    expect(readFileSync(patch.path, "utf8")).toContain("change.txt")
  })

  it("a reset in one worktree does not affect another", () => {
    const root = repo()
    const a = worktree(root, "a")
    const b = worktree(root, "b")
    const base = git(root, ["rev-parse", "HEAD"])
    writeFileSync(path.join(a, "a.txt"), "a\n")
    writeFileSync(path.join(b, "b.txt"), "b\n")
    expect(DagIsolation.commitWorktree(a, base, "dag: a").ok).toBe(true)
    expect(DagIsolation.commitWorktree(b, base, "dag: b").ok).toBe(true)

    git(a, ["reset", "--hard", base])
    expect(existsSync(path.join(a, "a.txt"))).toBe(false)
    expect(readFileSync(path.join(b, "b.txt"), "utf8")).toBe("b\n")
  })

  it("returns a successful no-op for a clean worktree", () => {
    const root = repo()
    const a = worktree(root, "a")
    const base = git(root, ["rev-parse", "HEAD"])
    expect(DagIsolation.commitWorktree(a, base, "dag: a")).toEqual({ ok: true })
  })

  it("detects and commits untracked files even when Git hides them", () => {
    const root = repo()
    const a = worktree(root, "a")
    const base = git(root, ["rev-parse", "HEAD"])
    git(root, ["config", "extensions.worktreeConfig", "true"])
    git(a, ["config", "--worktree", "status.showUntrackedFiles", "no"])
    writeFileSync(path.join(a, "only.txt"), "untracked\n")
    expect(git(a, ["status", "--porcelain"])).toBe("")
    expect(DagIsolation.touchedPaths(a)).toEqual(["only.txt"])
    const result = DagIsolation.commitWorktree(a, base, "dag: a")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.change?.touchedPaths).toEqual(["only.txt"])
    expect(result.change?.patch).toContain("untracked")
  })

  it("includes paths committed before the completion commit in touched paths and conflicts", () => {
    const root = repo()
    const a = worktree(root, "a")
    const base = git(root, ["rev-parse", "HEAD"])
    writeFileSync(path.join(a, "committed.txt"), "committed\n")
    git(a, ["add", "-A"])
    git(a, ["commit", "-m", "child commit"])
    writeFileSync(path.join(a, "dirty.txt"), "dirty\n")

    const commit = DagIsolation.commitWorktree(a, base, "dag: a")
    expect(commit.ok).toBe(true)
    if (!commit.ok || !commit.change) return
    expect(commit.change.touchedPaths).toEqual(["committed.txt", "dirty.txt"])
    expect(commit.change.patch).toContain("committed.txt")
    expect(commit.change.patch).toContain("dirty.txt")
    expect(
      DagIsolation.conflictsFor(commit.change.touchedPaths, [
        { id: "other", touchedPaths: ["committed.txt", "dirty.txt"] },
      ]),
    ).toEqual([{ nodeID: "other", paths: ["committed.txt", "dirty.txt"] }])
  })

  it("recovers commits already present in a clean worktree after a crash", () => {
    const root = repo()
    const a = worktree(root, "a")
    const base = git(root, ["rev-parse", "HEAD"])
    writeFileSync(path.join(a, "committed.txt"), "committed\n")
    git(a, ["add", "-A"])
    git(a, ["commit", "-m", "child commit"])
    const head = git(a, ["rev-parse", "HEAD"])
    expect(git(a, ["status", "--porcelain"])).toBe("")

    const commit = DagIsolation.commitWorktree(a, base, "dag: a")
    expect(commit.ok).toBe(true)
    if (!commit.ok || !commit.change) return
    expect(commit.change.commit).toBe(head)
    expect(commit.change.touchedPaths).toEqual(["committed.txt"])
    expect(commit.change.patch).toContain("committed.txt")
  })
})

describe("DagIsolation patch artifacts", () => {
  it("rejects traversal in durable IDs instead of writing outside the report area", () => {
    const root = repo()
    expect(() => DagIsolation.writePatchArtifact(root, "../escape", "node", "x")).toThrow(/workflow ID/)
    expect(() => DagIsolation.writePatchArtifact(root, "dag_1", "../escape", "x")).toThrow(/node ID/)
    expect(existsSync(path.join(path.dirname(root), "escape"))).toBe(false)
  })
})

describe("DagIsolation conflict views", () => {
  it("treats ancestor and descendant paths as overlapping", () => {
    expect(DagIsolation.conflictsFor(["src"], [{ id: "a", touchedPaths: ["src/a.ts"] }])).toEqual([
      { nodeID: "a", paths: ["src/a.ts"] },
    ])
    expect(DagIsolation.conflictsFor(["src/a.ts"], [{ id: "a", touchedPaths: ["src"] }])).toEqual([
      { nodeID: "a", paths: ["src"] },
    ])
  })

  it("reports each conflicting pair once with the shared paths", () => {
    expect(
      DagIsolation.conflictGroups([
        { id: "a", touchedPaths: ["x.ts", "y.ts"], conflictsWith: ["b"] },
        { id: "b", touchedPaths: ["y.ts", "x.ts"], conflictsWith: ["a"] },
        { id: "c", touchedPaths: ["z.ts"], conflictsWith: [] },
      ]),
    ).toEqual([{ nodes: ["a", "b"], paths: ["x.ts", "y.ts"] }])
  })

  it("warns only for unordered non-isolated writers", () => {
    expect(
      DagIsolation.parallelOverlaps([
        { id: "a", touchedPaths: ["x.ts"], dependsOn: [], isolated: false },
        { id: "b", touchedPaths: ["x.ts"], dependsOn: ["a"], isolated: false },
        { id: "c", touchedPaths: ["x.ts"], dependsOn: [], isolated: false },
        { id: "d", touchedPaths: ["x.ts"], dependsOn: [], isolated: true },
      ]),
    ).toEqual([
      { nodes: ["a", "c"], paths: ["x.ts"] },
      { nodes: ["b", "c"], paths: ["x.ts"] },
    ])
  })
})
