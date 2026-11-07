import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const packageDir = path.resolve(import.meta.dir, "../..")
const repoRoot = path.resolve(packageDir, "../..")
const embedded = path.resolve(repoRoot, "config_assistant/internal/schema/config.json")
const published = {
  config: path.resolve(repoRoot, "schema/config.json"),
  tui: path.resolve(repoRoot, "schema/tui.json"),
  theme: path.resolve(repoRoot, "schema/theme.json"),
}

// config_assistant embeds a copy of the config schema for offline validation,
// and the repository publishes editor-facing schemas for every config file.
// Regenerate them with
// `bun script/schema.ts ../../schema/config.json ../../schema/tui.json ../../schema/theme.json`.
test("published and embedded schemas match the generated schemas", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-config-schema-"))
  try {
    const generated = {
      config: path.join(directory, "config.json"),
      tui: path.join(directory, "tui.json"),
      theme: path.join(directory, "theme.json"),
    }
    const result = Bun.spawnSync(["bun", "script/schema.ts", generated.config, generated.tui, generated.theme], {
      cwd: packageDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
    // Compare parsed JSON so CRLF checkouts (core.autocrlf) still match the LF generator output.
    expect(await Bun.file(embedded).json()).toEqual(await Bun.file(generated.config).json())
    for (const name of ["config", "tui", "theme"] as const) {
      expect(await Bun.file(published[name]).json()).toEqual(await Bun.file(generated[name]).json())
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
