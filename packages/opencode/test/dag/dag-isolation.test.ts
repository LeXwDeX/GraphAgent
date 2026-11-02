import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DagIsolation } from "@/dag/isolation"

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
})

describe("DagIsolation conflict views", () => {
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
