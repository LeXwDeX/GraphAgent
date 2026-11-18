// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { countModelIdBranches, LOCAL_ID_FILES, run } from "../script/check-model-id-branches"
import { tmpdir } from "./fixture/fixture"

const REPO_ROOT = path.resolve(import.meta.dir, "../../..")
const SCRIPT = path.join(REPO_ROOT, "packages/graphagent/script/check-model-id-branches.ts")
const ENGINE_FILE = "packages/graphagent/src/provider/provider.ts"
const LOCAL_FILE = "packages/graphagent/src/provider/transform.ts"

/** A model id read through a receiver the search knows: it is a branch on a substring of the id. */
const SEARCH_R_HITS = [
  `if (model.api.id.includes("claude")) return`,
  `const claude = input.model.api.id.toLowerCase().includes("claude")`,
  `return model.id.startsWith("gpt-")`,
  `if (model.id.toLowerCase().endsWith("-latest")) return`,
  `return modelID.includes("gpt-") && !modelID.includes("oss")`,
  `const version = modelId.match(/gpt-(\\d+)/)`,
  `if (apiID.startsWith("o1")) return`,
  `const preview = apiId.endsWith("-preview")`,
  `const mistral = mistralId.includes("mistral")`,
  `return /^gpt-5/.test(model.api.id)`,
  `const hit = PATTERN.exec(modelID)`,
  `if (PATTERN.test(apiId.toLowerCase())) return`,
]

/** Comparisons that do not take a substring of the id apart. */
const SEARCH_R_MISSES = [
  `if (model.api.id === "gpt-5") return`,
  `const id = model.api.id.toLowerCase()`,
  `if (KNOWN.has(model.api.id)) return`,
  `if (list.includes(model.api.id)) return`,
  `const label = model.identity.includes("x")`,
  `if (providerID.includes("openai")) return`,
  `if (npm.startsWith("@ai-sdk/")) return`,
  `if (id.includes("claude")) return`,
]

/** A bare `id` is a model id only in the files `LOCAL_ID_FILES` names. */
const SEARCH_B_HITS = [
  `if (id.includes("claude")) return`,
  `return !id.startsWith("gpt-")`,
  `const latest = id.toLowerCase().endsWith("-latest")`,
  `if (id.match(/gpt-(\\d+)/)) return`,
  `return PATTERN.test(id)`,
  `const hit = PATTERN.exec(id)`,
]

const SEARCH_B_MISSES = [
  `if (userid.includes("x")) return`,
  `if (item.id.includes("x")) return`,
  `if (id === "gpt-5") return`,
  `if (ids.includes(id)) return`,
  `if (PATTERN.test(identity)) return`,
  `const id = model.api.id.toLowerCase()`,
]

describe("countModelIdBranches search R", () => {
  for (const line of SEARCH_R_HITS)
    test(`counts ${line}`, () => {
      expect(countModelIdBranches(ENGINE_FILE, line)).toBe(1)
      expect(countModelIdBranches(LOCAL_FILE, line)).toBe(1)
    })

  for (const line of SEARCH_R_MISSES)
    test(`ignores ${line}`, () => {
      expect(countModelIdBranches(ENGINE_FILE, line)).toBe(0)
    })
})

describe("countModelIdBranches search B", () => {
  test("is read only in the files whose local id is a model id", () => {
    expect(LOCAL_ID_FILES).toEqual([
      "packages/graphagent/src/provider/transform.ts",
      "packages/graphagent/src/session/message-v2.ts",
      "packages/llm/src/providers/openai-options.ts",
    ])
    for (const line of SEARCH_B_HITS) {
      for (const file of LOCAL_ID_FILES) expect(countModelIdBranches(file, line)).toBe(1)
      expect(countModelIdBranches(ENGINE_FILE, line)).toBe(0)
      expect(countModelIdBranches("packages/llm/src/other.ts", line)).toBe(0)
    }
  })

  for (const line of SEARCH_B_MISSES)
    test(`ignores ${line} even in a local id file`, () => {
      for (const file of LOCAL_ID_FILES) expect(countModelIdBranches(file, line)).toBe(0)
    })
})

describe("countModelIdBranches counting", () => {
  test("counts a line once however many branches it holds", () => {
    const text = [
      `const a = modelID.includes("a") || modelID.includes("b")`,
      `const b = model.api.id.includes("c") && id.includes("d")`,
      `const c = 1`,
    ].join("\n")
    expect(countModelIdBranches(LOCAL_FILE, text)).toBe(2)
    expect(countModelIdBranches(ENGINE_FILE, text)).toBe(2)
  })

  test("sums the lines of a whole file and returns 0 for none", () => {
    const text = SEARCH_R_HITS.join("\n")
    expect(countModelIdBranches(ENGINE_FILE, text)).toBe(SEARCH_R_HITS.length)
    expect(countModelIdBranches(ENGINE_FILE, "")).toBe(0)
    expect(countModelIdBranches(ENGINE_FILE, SEARCH_R_MISSES.join("\n"))).toBe(0)
  })
})

async function put(root: string, file: string, text: string) {
  const target = path.join(root, file)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, text)
}

const HIT = `if (model.api.id.includes("claude")) return\n`

describe("check-model-id-branches baseline", () => {
  test("a file past its baseline fails, and a file missing from the baseline counts as zero", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, "packages/graphagent/src/a.ts", HIT + HIT)
    await put(tmp.path, "packages/llm/src/b.ts", HIT)
    await put(tmp.path, "packages/graphagent/src/clean.ts", "export const x = 1\n")
    const baselineFile = path.join(tmp.path, "baseline.json")
    await writeFile(baselineFile, JSON.stringify({ version: 1, files: { "packages/graphagent/src/a.ts": 1 } }))

    const result = run({ root: tmp.path, baselineFile })
    const output = result.output.join("\n")
    expect(result.code).toBe(1)
    expect(output).toContain("GROW packages/graphagent/src/a.ts 2 > baseline 1")
    expect(output).toContain("NEW packages/llm/src/b.ts 1")
    expect(output).not.toContain("clean.ts")
  })

  test("a file at its baseline passes", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, "packages/graphagent/src/a.ts", HIT + HIT)
    const baselineFile = path.join(tmp.path, "baseline.json")
    await writeFile(baselineFile, JSON.stringify({ version: 1, files: { "packages/graphagent/src/a.ts": 2 } }))

    const result = run({ root: tmp.path, baselineFile })
    expect(result.code).toBe(0)
    expect(result.output.join("\n")).not.toContain("STALE")
  })

  test("a file under its baseline, or gone, only reports STALE", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, "packages/graphagent/src/a.ts", HIT)
    const baselineFile = path.join(tmp.path, "baseline.json")
    await writeFile(
      baselineFile,
      JSON.stringify({
        version: 1,
        files: { "packages/graphagent/src/a.ts": 3, "packages/graphagent/src/gone.ts": 2 },
      }),
    )

    const result = run({ root: tmp.path, baselineFile })
    const output = result.output.join("\n")
    expect(result.code).toBe(0)
    expect(output).toContain("STALE packages/graphagent/src/a.ts 1 < baseline 3")
    expect(output).toContain("STALE packages/graphagent/src/gone.ts 0 < baseline 2")
  })

  test("a missing or malformed baseline is an empty one", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, "packages/graphagent/src/a.ts", HIT)
    await put(tmp.path, "packages/graphagent/src/b.ts", "export const x = 1\n")
    const baselineFile = path.join(tmp.path, "baseline.json")
    expect(run({ root: tmp.path, baselineFile }).code).toBe(1)
    await writeFile(baselineFile, "{ not json")
    expect(run({ root: tmp.path, baselineFile }).code).toBe(1)
    await writeFile(baselineFile, JSON.stringify({ version: 2, files: { "packages/graphagent/src/a.ts": 1 } }))
    expect(run({ root: tmp.path, baselineFile }).code).toBe(1)
  })

  test("scans only .ts and .tsx files of the two source trees, and never a declaration file", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, "packages/graphagent/src/z.ts", HIT)
    await put(tmp.path, "packages/graphagent/src/deep/a.tsx", HIT + HIT)
    await put(tmp.path, "packages/llm/src/m.ts", HIT)
    await put(tmp.path, "packages/graphagent/src/types.d.ts", HIT)
    await put(tmp.path, "packages/graphagent/src/note.md", HIT)
    await put(tmp.path, "packages/graphagent/src/node_modules/pkg/index.ts", HIT)
    await put(tmp.path, "packages/graphagent/test/t.ts", HIT)
    await put(tmp.path, "packages/other/src/o.ts", HIT)
    await put(tmp.path, "packages/graphagent/src/clean.ts", "export const x = 1\n")
    const baselineFile = path.join(tmp.path, "baseline.json")

    const written = run({ root: tmp.path, baselineFile, writeBaseline: true })
    expect(written.code).toBe(0)
    const text = await readFile(baselineFile, "utf8")
    expect(text.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(text)
    expect(parsed).toEqual({
      version: 1,
      files: {
        "packages/graphagent/src/deep/a.tsx": 2,
        "packages/graphagent/src/z.ts": 1,
        "packages/llm/src/m.ts": 1,
      },
    })
    expect(Object.keys(parsed.files)).toEqual([
      "packages/graphagent/src/deep/a.tsx",
      "packages/graphagent/src/z.ts",
      "packages/llm/src/m.ts",
    ])
    // What was just written is what the check accepts.
    const checked = run({ root: tmp.path, baselineFile })
    expect(checked.code).toBe(0)
    expect(checked.output.join("\n")).not.toContain("STALE")
  })

  test("counts a bare id search only in the local id files", async () => {
    await using tmp = await tmpdir()
    const bare = `if (id.includes("claude")) return\n`
    await put(tmp.path, LOCAL_FILE, bare)
    await put(tmp.path, "packages/graphagent/src/other.ts", bare)
    const baselineFile = path.join(tmp.path, "baseline.json")
    run({ root: tmp.path, baselineFile, writeBaseline: true })
    expect(JSON.parse(await readFile(baselineFile, "utf8"))).toEqual({ version: 1, files: { [LOCAL_FILE]: 1 } })
  })
})

describe("check-model-id-branches on the repository", () => {
  test("the committed baseline accepts the source tree (exit code 0)", () => {
    const proc = Bun.spawnSync([process.execPath, SCRIPT], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
    const stdout = proc.stdout.toString()
    if (proc.exitCode !== 0)
      throw new Error(`check-model-id-branches exited ${proc.exitCode}\n${stdout}\n${proc.stderr.toString()}`)
    expect(stdout).toContain("model-id: OK")
  })

  test("the root package.json runs the script as check:model-id", async () => {
    const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"))
    expect(manifest.scripts["check:model-id"]).toBe("bun packages/graphagent/script/check-model-id-branches.ts")
  })
})
