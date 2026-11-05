import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../src/plugin/skill")
const skill = readFileSync(path.join(root, "configure-hooks.md"), "utf8")
const scratch = mkdtempSync(path.join(tmpdir(), "graphagent-skill-scripts-"))
const stopScript = path.join(scratch, "stop-guard.mjs")
const gitScript = path.join(scratch, "git-guard.mjs")

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
writeFileSync(gitScript, extract("git-guard"))

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

function runGit(cwd: string, command: string) {
  return runScript(gitScript, cwd, { cwd, tool_input: { command } })
}

function expectDenied(cwd: string, command: string) {
  const result = runGit(cwd, command)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe("")
  expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny")
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

describe("git-guard recipe script", () => {
  const dir = repo()

  const denied = [
    "git push --force origin main",
    "git push -f",
    "git push -fu origin main",
    "git push origin +main",
    "git push origin +HEAD:main",
    "git push --force-with-lease=main:abc123 origin main",
    "git push --mirror",
    "git -C . push --force",
    "git -c core.x=y push -f",
    "LC_ALL=C git push -f",
    "cd sub && git push --force",
    "git reset --hard",
    "git reset HEAD~1 --hard",
    "git -C . reset --hard",
  ]

  for (const command of denied) {
    test(`denies ${command}`, () => expectDenied(dir, command))
  }

  const allowed = [
    "git push origin feature",
    "git push -u origin feature",
    "git push origin feature; echo --force",
    'echo "git push --force"',
    'git commit -m "+1 --force"',
    "git reset --soft HEAD~1",
    "git reset HEAD file.txt",
    "git -C sub status",
    "ls -la",
  ]

  for (const command of allowed) {
    test(`allows ${command}`, () => expectAllowed(runGit(dir, command)))
  }

  test("names a safe alternative for force pushes and hard resets", () => {
    const push = JSON.parse(runGit(dir, "git push --force origin main").stdout)
    expect(push.hookSpecificOutput.permissionDecisionReason).toContain("Push a new commit")
    const reset = JSON.parse(runGit(dir, "git reset --hard").stdout)
    expect(reset.hookSpecificOutput.permissionDecisionReason).toContain("git stash")
  })
})
