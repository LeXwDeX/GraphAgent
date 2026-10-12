import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const packageDir = path.resolve(import.meta.dir, "../..")
const embedded = path.resolve(packageDir, "../../config_assistant/internal/schema/config.json")

// config_assistant embeds a copy of the config schema for offline validation.
// Regenerate it with `bun script/schema.ts ../../config_assistant/internal/schema/config.json`.
test("config_assistant embeds the current generated config schema", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-config-schema-"))
  try {
    const generated = path.join(directory, "config.json")
    const result = Bun.spawnSync(["bun", "script/schema.ts", generated], {
      cwd: packageDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(embedded).text()).toBe(await Bun.file(generated).text())
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
