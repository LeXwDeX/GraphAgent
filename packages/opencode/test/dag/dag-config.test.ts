import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { DagConfig } from "@/dag/config"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"

let dir: string
let projectDir: string
let globalDir: string
const originalConfigDir = process.env.GRAPHAGENT_CONFIG_DIR

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-config-"))
  projectDir = path.join(dir, "project")
  globalDir = path.join(dir, "global")
  await fs.mkdir(projectDir, { recursive: true })
  // Redirect the global config dir (Flag.GRAPHAGENT_CONFIG_DIR reads the env)
  // so seeding never touches the real one.
  process.env.GRAPHAGENT_CONFIG_DIR = globalDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
  else process.env.GRAPHAGENT_CONFIG_DIR = originalConfigDir
  await fs.rm(dir, { recursive: true, force: true })
})

describe("DagConfig.load", () => {
  it("does not write anything by default when no config exists (pure read path)", async () => {
    const info = await Effect.runPromise(DagConfig.load(projectDir))
    expect(info).toEqual({})
    // The scheduling hot path must never seed — the global dir stays absent.
    expect(fs.access(path.join(globalDir, "dag.jsonc"))).rejects.toThrow()
  })

  it("seeds a commented default dag.jsonc into the global config dir with autoSeed", async () => {
    const info = await Effect.runPromise(DagConfig.load(projectDir, { autoSeed: true }))
    expect(info).toEqual({})
    const seeded = await fs.readFile(path.join(globalDir, "dag.jsonc"), "utf-8")
    expect(seeded).toContain("thinking_depth")
    expect(seeded).toContain("advanced")
    // The seeded file keeps every value commented out — a subsequent load
    // yields an empty model block and no thinking depth.
    const reloaded = await Effect.runPromise(DagConfig.load(projectDir))
    expect(reloaded).toEqual({ model: {} })
    expect(reloaded.thinking_depth).toBeUndefined()
    expect(DagConfig.tierModel(reloaded, { required: true, workerType: "build" })).toBeUndefined()
  })

  it("returns empty config when seeding fails for non-EEXIST reasons", async () => {
    // Point the global dir AT A FILE so mkdir/writeFile fail with ENOTDIR —
    // load must swallow it (warning only) and still return {}.
    await fs.writeFile(path.join(dir, "not-a-dir"), "")
    process.env.GRAPHAGENT_CONFIG_DIR = path.join(dir, "not-a-dir")
    const info = await Effect.runPromise(DagConfig.load(projectDir, { autoSeed: true }))
    expect(info).toEqual({})
  })

  it("reads the global dag.jsonc with comments and trailing commas", async () => {
    await fs.mkdir(globalDir, { recursive: true })
    await fs.writeFile(
      path.join(globalDir, "dag.jsonc"),
      `{
        // tiered defaults
        "model": { "advanced": "prov/big", "standard": "prov/small", },
        "thinking_depth": "high",
      }`,
    )
    const info = await Effect.runPromise(DagConfig.load(projectDir))
    expect(info.model?.advanced).toBe("prov/big")
    expect(info.model?.standard).toBe("prov/small")
    expect(info.thinking_depth).toBe("high")
  })

  it("prefers the project .opencode/dag.jsonc over the global file", async () => {
    await fs.mkdir(globalDir, { recursive: true })
    await fs.writeFile(path.join(globalDir, "dag.jsonc"), `{ "thinking_depth": "low" }`)
    await fs.mkdir(path.join(projectDir, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(projectDir, ".opencode", "dag.jsonc"), `{ "thinking_depth": "max" }`)
    const info = await Effect.runPromise(DagConfig.load(projectDir))
    expect(info.thinking_depth).toBe("max")
  })

  it("ignores a config with an invalid shape instead of failing the round", async () => {
    await fs.mkdir(globalDir, { recursive: true })
    await fs.writeFile(path.join(globalDir, "dag.jsonc"), `{ "thinking_depth": "ultra" }`)
    const info = await Effect.runPromise(DagConfig.load(projectDir))
    expect(info).toEqual({})
  })
})

describe("DagConfig.tierModel", () => {
  const info: DagConfig.Info = { model: { advanced: "prov/big", standard: "prov/small" } }

  it("routes required nodes to the advanced tier", () => {
    expect(DagConfig.tierModel(info, { required: true, workerType: "build" })).toEqual({
      providerID: "prov",
      modelID: "big",
    })
  })

  it("routes review workers to the advanced tier", () => {
    expect(DagConfig.tierModel(info, { required: false, workerType: "review-arch" })).toEqual({
      providerID: "prov",
      modelID: "big",
    })
  })

  it("routes ordinary workers to the standard tier", () => {
    expect(DagConfig.tierModel(info, { required: false, workerType: "explore" })).toEqual({
      providerID: "prov",
      modelID: "small",
    })
  })

  it("uses a single configured tier as the unified default", () => {
    const only = { model: { standard: "prov/small" } }
    expect(DagConfig.tierModel(only, { required: true, workerType: "build" })).toEqual({
      providerID: "prov",
      modelID: "small",
    })
    const advancedOnly = { model: { advanced: "prov/big" } }
    expect(DagConfig.tierModel(advancedOnly, { required: false, workerType: "explore" })).toEqual({
      providerID: "prov",
      modelID: "big",
    })
  })

  // An empty tier (what uncommenting the seeded `// "advanced": ""` line
  // produces) is unconfigured: the other tier remains the unified default
  // instead of critical/required nodes silently falling through to the
  // worker-agent or parent-session model.
  it("falls back past an empty tier to the configured one", () => {
    const emptyAdvanced = { model: { advanced: "", standard: "openai/gpt-5" } }
    expect(DagConfig.tierModel(emptyAdvanced, { required: true, workerType: "build" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    expect(DagConfig.tierModel(emptyAdvanced, { required: false, workerType: "review" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    const emptyStandard = { model: { advanced: "anthropic/claude", standard: "" } }
    expect(DagConfig.tierModel(emptyStandard, { required: false, workerType: "build" })).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    })
  })

  it("treats a whitespace-only tier as unconfigured and trims tier components", () => {
    const blankAdvanced = { model: { advanced: " / ", standard: "openai/gpt-5" } }
    expect(DagConfig.tierModel(blankAdvanced, { required: true, workerType: "build" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    const padded = { model: { standard: " openai / gpt-5 " } }
    expect(DagConfig.tierModel(padded, { required: false, workerType: "build" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
  })

  it("keeps only the first slash as the provider separator", () => {
    const nested = { model: { standard: "local-proxy-compatible/qwen3.8-max-preview" } }
    expect(DagConfig.tierModel(nested, { required: false, workerType: "explore" })).toEqual({
      providerID: "local-proxy-compatible",
      modelID: "qwen3.8-max-preview",
    })
  })

  it("returns undefined for missing or malformed refs", () => {
    expect(DagConfig.tierModel({}, { required: true, workerType: "build" })).toBeUndefined()
    expect(DagConfig.tierModel({ model: { standard: "no-slash" } }, { required: false, workerType: "x" })).toBeUndefined()
    expect(DagConfig.tierModel({ model: { standard: "prov/" } }, { required: false, workerType: "x" })).toBeUndefined()
  })
})
