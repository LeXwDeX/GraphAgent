import { expect, test } from "bun:test"
import { Schema } from "effect"
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

// The published document is a JSON Schema whose object nodes carry the
// annotations we assert on. Decode through narrow schemas instead of casting,
// so a shape change fails here rather than silently reading undefined.
const SectionNode = Schema.Struct({
  properties: Schema.Record(
    Schema.String,
    Schema.Struct({ description: Schema.optional(Schema.String) }),
  ),
  additionalProperties: Schema.optional(Schema.Boolean),
})
const Document = Schema.Struct({
  $ref: Schema.String,
  $defs: Schema.Record(Schema.String, Schema.Unknown),
})
const Engine = Schema.Struct({
  properties: Schema.Struct({ concurrency: SectionNode, cache: SectionNode, memory: SectionNode }),
  additionalProperties: Schema.optional(Schema.Boolean),
})
const ConfigDocument = Schema.Struct({ properties: Schema.Struct({ engine: Engine }) })

test("published config schema documents the draft engine limits", async () => {
  const document = Schema.decodeUnknownSync(Document)(await Bun.file(published.config).json())
  const engine = Schema.decodeUnknownSync(ConfigDocument)(document.$defs[document.$ref.replace("#/$defs/", "")])
    .properties.engine
  expect(engine.additionalProperties).toBe(false)
  expect(engine.properties.concurrency.additionalProperties).toBe(false)
  expect(engine.properties.cache.additionalProperties).toBe(false)
  expect(engine.properties.memory.additionalProperties).toBe(false)
  expect(engine.properties.concurrency.properties.global.description).toContain("draft default: 24")
  expect(engine.properties.concurrency.properties.perProvider.description).toContain("draft default: 12")
  expect(engine.properties.concurrency.properties.childGlobal.description).toContain("draft default: 16")
  expect(engine.properties.concurrency.properties.taskReserve.description).toContain("draft default: 2")
  expect(engine.properties.cache.properties.staggerSiblings.description).toContain("default: true")
  expect(engine.properties.memory.properties.selectTimeoutMs.description).toContain("draft default: 3000")
})
