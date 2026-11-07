import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { artifactCliTarget, cliCommand, resolveCliTarget, sourceCliTarget, verifyCliTarget } from "./cli-process"

async function rejectionMessage(promise: Promise<unknown>) {
  try {
    await promise
    throw new Error("expected promise to reject")
  } catch (error) {
    return error instanceof Error ? error.message : JSON.stringify(error)
  }
}

describe("CLI subprocess target", () => {
  test("keeps the source command as bun run", async () => {
    const target = await resolveCliTarget(sourceCliTarget)
    const command = cliCommand(target, ["run", "hello"])

    expect(target.mode).toBe("source")
    expect(command.executable).toBe("bun")
    expect(command.args.slice(0, 2)).toEqual(["run", "--conditions=browser"])
    expect(command.args.slice(-2)).toEqual(["run", "hello"])
  })

  test("rejects a relative artifact path before filesystem access", () => {
    expect(() => artifactCliTarget("bin/graphagent")).toThrow("must be an absolute path")
  })

  test("rejects a directly constructed relative artifact target", async () => {
    expect(await rejectionMessage(resolveCliTarget({ mode: "artifact", executable: "bin/graphagent" }))).toContain(
      "must be an absolute path",
    )
  })

  test.skipIf(process.platform === "win32")(
    "resolves an executable symlink and binds every spawn to its SHA256",
    async () => {
      await using tmp = await tmpdir()
      const executable = path.join(tmp.path, "opencode")
      const link = path.join(tmp.path, "opencode-link")
      const content = "#!/bin/sh\nexit 0\n"
      await Bun.write(executable, content)
      await chmod(executable, 0o755)
      await symlink(executable, link)

      const target = await resolveCliTarget(artifactCliTarget(link))
      expect(target).toEqual({
        mode: "artifact",
        requestedExecutable: link,
        executable: await realpath(executable),
        sha256: createHash("sha256").update(content).digest("hex"),
      })
      expect(cliCommand(target, ["run", "hello"])).toEqual({
        executable: await realpath(executable),
        args: ["run", "hello"],
      })

      await Bun.write(executable, content + "# replaced\n")
      await chmod(executable, 0o755)
      expect(await rejectionMessage(verifyCliTarget(target))).toContain("identity changed")
    },
  )

  test.skipIf(process.platform === "win32")("rejects directories and non-executable regular files", async () => {
    await using tmp = await tmpdir()
    expect(await rejectionMessage(resolveCliTarget(artifactCliTarget(tmp.path)))).toContain("not a regular file")

    const file = path.join(tmp.path, "not-executable")
    await Bun.write(file, "plain data")
    await chmod(file, 0o644)
    expect(await rejectionMessage(resolveCliTarget(artifactCliTarget(file)))).not.toBe("expected promise to reject")
  })
})
