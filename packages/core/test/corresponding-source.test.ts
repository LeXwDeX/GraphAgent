import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, unlink } from "fs/promises"
import os from "os"
import path from "path"
import { createCorrespondingSource, verifyCorrespondingSourceArtifacts } from "../../../script/corresponding-source"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("corresponding source", () => {
  test("archives the exact committed tree with deterministic source metadata", async () => {
    const root = await repository()
    const result = await createCorrespondingSource({
      root,
      output: path.join(root, "artifacts"),
      version: "1.2.3-dev.4",
      requiredFiles: ["LICENSE", "NOTICE", "bun.lock", "package.json"],
    })
    const manifest = await Bun.file(result.manifest).json()
    const entries = (await command(root, ["tar", "-tzf", result.archive])).split("\n")

    expect(result.sha256).toHaveLength(64)
    expect(await Bun.file(result.checksum).text()).toBe(`${result.sha256}  ${path.basename(result.archive)}\n`)
    expect(manifest.commit).toBe(result.commit)
    expect(manifest.archive.sha256).toBe(result.sha256)
    expect(manifest.dependencyLocks).toEqual(["bun.lock"])
    expect(entries).toContain(`graphagent-1.2.3-dev.4-source-${result.commit.slice(0, 12)}/LICENSE`)
    expect((await verifyCorrespondingSourceArtifacts(path.dirname(result.archive))).sha256).toBe(result.sha256)
  })

  test("rejects a release set with a missing source archive", async () => {
    const root = await repository()
    const result = await createCorrespondingSource({
      root,
      output: path.join(root, "artifacts"),
      version: "1.2.3",
      requiredFiles: ["LICENSE", "NOTICE", "bun.lock", "package.json"],
    })
    await unlink(result.archive)

    const failure = await verifyCorrespondingSourceArtifacts(path.dirname(result.archive)).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error("expected source verification to fail")
    expect(failure.message).toContain("Corresponding source archive is missing")
  })
})

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "corresponding-source-"))
  roots.push(root)
  await Promise.all(
    ["LICENSE", "NOTICE", "bun.lock", "package.json"].map((file) => Bun.write(path.join(root, file), `${file}\n`)),
  )
  await git(root, ["init"])
  await git(root, ["config", "user.email", "test@example.com"])
  await git(root, ["config", "user.name", "Test User"])
  await git(root, ["add", "."])
  await git(root, ["commit", "-m", "test: source fixture"])
  return root
}

async function git(root: string, args: string[]) {
  return command(root, ["git", ...args])
}

async function command(root: string, args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed: ${stderr}`)
  return stdout.trim()
}
