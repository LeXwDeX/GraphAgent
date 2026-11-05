import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../src/plugin/skill")
const skill = readFileSync(path.join(root, "configure-hooks.md"), "utf8")
const scratch = mkdtempSync(path.join(tmpdir(), "graphagent-skill-scripts-"))
const stopScript = path.join(scratch, "stop-guard.mjs")
const scopeScript = path.join(scratch, "scope-guard.mjs")

function extract(name: string) {
  const start = `<!-- ${name}:script:start -->`
  const end = `<!-- ${name}:script:end -->`
  const from = skill.indexOf(start)
  const to = skill.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error(`missing ${name} script block`)
  const body = skill.slice(from + start.length, to)
  const match = /```js\n([\s\S]*?)```/.exec(body)
  if (!match) throw new Error(`missing ${name} script fence`)
  return match[1]
}

writeFileSync(stopScript, extract("stop-guard"))
writeFileSync(scopeScript, extract("scope-guard"))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function repo() {
  const dir = mkdtempSync(path.join(scratch, "repo-"))
  git(dir, ["init", "-q"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Test"])
  git(dir, ["commit", "-q", "--allow-empty", "-m", "init"])
  return dir
}

function withUpstream(dir: string) {
  const remote = mkdtempSync(path.join(scratch, "remote-"))
  git(scratch, ["init", "-q", "--bare", remote])
  git(dir, ["remote", "add", "origin", remote])
  git(dir, ["push", "-q", "-u", "origin", "HEAD"])
}

function runScript(script: string, cwd: string, payload: unknown) {
  const result = spawnSync("node", [script], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
  })
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

function expectAllowed(result: { code: number | null; stdout: string; stderr: string }) {
  expect(result.code).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toBe("")
}

function runStop(cwd: string, payload: Record<string, unknown> = {}) {
  return runScript(stopScript, cwd, { cwd, ...payload })
}

function runScope(cwd: string, command: string) {
  return runScript(scopeScript, cwd, { cwd, tool_input: { command } })
}

describe("stop-guard recipe script", () => {
  test("allows a clean worktree with an up-to-date upstream", () => {
    const dir = repo()
    withUpstream(dir)
    expectAllowed(runStop(dir))
  })

  test("blocks uncommitted changes and names the next action", () => {
    const dir = repo()
    withUpstream(dir)
    writeFileSync(path.join(dir, "dirty.txt"), "x")
    const result = runStop(dir)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("Uncommitted changes"),
    })
  })

  test("blocks an unpushed commit", () => {
    const dir = repo()
    withUpstream(dir)
    git(dir, ["commit", "-q", "--allow-empty", "-m", "next"])
    const result = runStop(dir)
    expect(JSON.parse(result.stdout)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("Unpushed commits"),
    })
  })

  test("allows on the continuation marked by stop_hook_active", () => {
    const dir = repo()
    withUpstream(dir)
    writeFileSync(path.join(dir, "dirty.txt"), "x")
    expectAllowed(runStop(dir, { stop_hook_active: true }))
  })

  test("allows a non-git directory", () => {
    const dir = mkdtempSync(path.join(scratch, "plain-"))
    expectAllowed(runStop(dir))
  })
})

describe("scope-guard recipe script", () => {
  const dir = repo()

  test("denies force pushes with a safe alternative", () => {
    const result = runScope(dir, "git push --force origin main")
    const output = JSON.parse(result.stdout)
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("Push a new commit")
  })

  test("denies destructive resets", () => {
    expect(JSON.parse(runScope(dir, "git reset --hard HEAD~1").stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    )
  })

  test("denies recursive deletion outside the worktree", () => {
    expect(JSON.parse(runScope(dir, "rm -rf /tmp/outside").stdout).hookSpecificOutput.permissionDecision).toBe("deny")
    expect(JSON.parse(runScope(dir, "rm -rf ../outside").stdout).hookSpecificOutput.permissionDecision).toBe("deny")
    expect(JSON.parse(runScope(dir, "rm -r ../outside").stdout).hookSpecificOutput.permissionDecision).toBe("deny")
    expect(JSON.parse(runScope(dir, "rm --recursive ../outside").stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    )
    expect(JSON.parse(runScope(dir, "rm -rf link/../victim").stdout).hookSpecificOutput.permissionDecision).toBe("deny")
    expect(JSON.parse(runScope(dir, 'rm -rf link/".."/victim').stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    )
    expect(
      JSON.parse(runScope(dir, 'rm -rf "build;cache" ../victim').stdout).hookSpecificOutput.permissionDecision,
    ).toBe("deny")
    expect(JSON.parse(runScope(dir, 'rm -rf "unterminated').stdout).hookSpecificOutput.permissionDecision).toBe("deny")
    expect(JSON.parse(runScope(dir, "LC_ALL=C rm -rf ../victim").stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    )
    expect(JSON.parse(runScope(dir, "rm -rf ..\\\n/victim").stdout).hookSpecificOutput.permissionDecision).toBe("deny")
    expect(JSON.parse(runScope(dir, 'rm -rf "..\\\n/victim"').stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    )
  })

  test("denies recursive deletion through a symlink that leaves the worktree", () => {
    if (process.platform === "win32") return
    const outsideDir = mkdtempSync(path.join(scratch, "outside-"))
    symlinkSync(outsideDir, path.join(dir, "link"), "dir")
    expect(JSON.parse(runScope(dir, "rm -rf link/subdir").stdout).hookSpecificOutput.permissionDecision).toBe("deny")
    symlinkSync(outsideDir, path.join(dir, "bridge\\\n"), "dir")
    expect(JSON.parse(runScope(dir, "rm -rf 'bridge\\\n/subdir'").stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    )
    expectAllowed(runScope(dir, "rm -rf bridge/subdir"))
  })

  test("allows ordinary pushes, in-worktree deletion and near-misses", () => {
    expectAllowed(runScope(dir, "git push origin feature"))
    expectAllowed(runScope(dir, "git push origin feature; echo --force"))
    expectAllowed(runScope(dir, "rm -rf ./build"))
    expectAllowed(runScope(dir, "rm -rf ./build-cache"))
    expectAllowed(runScope(dir, "rm -rf ./build && echo a/../b"))
    expectAllowed(runScope(dir, "rm -- -r ../file"))
    expectAllowed(runScope(dir, 'rm -rf ./build && echo "a\\"b"'))
    expectAllowed(runScope(dir, 'rm -rf "dir\\name"'))
    expectAllowed(runScope(dir, "ls -la"))
  })
})
