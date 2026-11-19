// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

// Generation embeds DAG_TEMPLATES_DIR content into the binary (script/generate.ts).
// Validate-before-embed: an invalid or unparseable template must abort
// generation instead of shipping a builtin template that fails at start/read
// time. Runs generate.ts as a subprocess to exercise the real build path.

const pkgRoot = path.resolve(import.meta.dir, "..", "..")

const VALID_TEMPLATE = `config:
  name: valid-route
  objective: Ship the bounded change
  blocks:
    - id: plan
      kind: plan
`

// Review fed by prototype writers without verification — the exact shape the
// block compiler rejects (and the pre-fix prototype-decision-route pinned).
const INVALID_TEMPLATE = `config:
  name: invalid-route
  objective: Ship the bounded change
  blocks:
    - id: proto
      kind: prototype
    - id: review
      kind: review
      depends_on: [proto]
`

// A review block with the default lenses has no completeness lens: valid as
// authored, where the standard gate only warns, but rejected under the strict
// gate that DAG mode applies to every start (#1560).
const STANDARD_ONLY_TEMPLATE = `config:
  name: standard-only
  objective: Review the bounded change
  blocks:
    - id: survey
      kind: explore
    - id: decision
      kind: review
      depends_on: [survey]
`

async function runGenerate(templatesDir: string, modelsSnapshot: string) {
  const result = Bun.spawnSync({
    cmd: ["bun", path.join("script", "generate.ts")],
    cwd: pkgRoot,
    env: { ...process.env, DAG_TEMPLATES_DIR: templatesDir, MODELS_DEV_API_JSON: modelsSnapshot },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
  }
}

// modelsSnapshot lives inside the scoped tmpdir so cleanup is guaranteed even
// when the test body throws — no separate rm that could leak on an exception path.
async function withTemplatesDir(
  files: Record<string, string>,
  fn: (dir: string, modelsSnapshot: string) => Promise<void>,
) {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const templates = path.join(dir, "templates")
      await fs.mkdir(templates, { recursive: true })
      for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(templates, name), content)
      }
      await fs.writeFile(
        path.join(templates, "runtime-compat.json"),
        JSON.stringify({ runtime_repo: "LeXwDeX/GraphAgent", runtime_commit: "0".repeat(40) }),
      )
      await fs.writeFile(path.join(dir, "models-snapshot.json"), "{}")
    },
  })
  await fn(path.join(tmp.path, "templates"), path.join(tmp.path, "models-snapshot.json"))
}

describe("dag template generation validates before embedding", () => {
  it(
    "embeds a directory whose templates all pass portable validation",
    async () => {
      await withTemplatesDir({ "valid-route.yml": VALID_TEMPLATE }, async (dir, modelsSnapshot) => {
        const result = await runGenerate(dir, modelsSnapshot)
        expect(result.exitCode).toBe(0)
        expect(result.output).toContain("1 templates (all validated)")
      })
    },
    { timeout: 60_000 },
  )

  it(
    "aborts when a template fails portable validation",
    async () => {
      await withTemplatesDir(
        { "valid-route.yaml": VALID_TEMPLATE, "invalid-route.yaml": INVALID_TEMPLATE },
        async (dir, modelsSnapshot) => {
          const result = await runGenerate(dir, modelsSnapshot)
          expect(result.exitCode).not.toBe(0)
          expect(result.output).toContain("invalid-route.yaml [block.compile_failed]")
          expect(result.output).toContain("block.compile_failed")
        },
      )
    },
    { timeout: 60_000 },
  )

  it(
    "aborts when a template passes as authored but fails under the strict review gate",
    async () => {
      await withTemplatesDir(
        { "valid-route.yaml": VALID_TEMPLATE, "standard-only.yaml": STANDARD_ONLY_TEMPLATE },
        async (dir, modelsSnapshot) => {
          const result = await runGenerate(dir, modelsSnapshot)
          expect(result.exitCode).not.toBe(0)
          expect(result.output).toContain("standard-only.yaml [block.compile_failed]")
          expect(result.output).toContain("must include the completeness lens")
          expect(result.output).toContain("[strict review gate: DAG mode applies it to every start]")
          expect(result.output).not.toContain("valid-route.yaml [")
        },
      )
    },
    { timeout: 60_000 },
  )

  it(
    "aborts when a template is not parseable YAML",
    async () => {
      await withTemplatesDir(
        { "broken.yaml": "key: [unclosed", "valid-route.yaml": VALID_TEMPLATE },
        async (dir, modelsSnapshot) => {
          const result = await runGenerate(dir, modelsSnapshot)
          expect(result.exitCode).not.toBe(0)
        },
      )
    },
    { timeout: 60_000 },
  )

  it(
    "aborts when runtime compatibility metadata is missing",
    async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await fs.writeFile(path.join(dir, "valid-route.yml"), VALID_TEMPLATE)
          await fs.writeFile(path.join(dir, "models-snapshot.json"), "{}")
        },
      })
      const result = await runGenerate(tmp.path, path.join(tmp.path, "models-snapshot.json"))
      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain("runtime compatibility file is missing")
    },
    { timeout: 60_000 },
  )

  it(
    "rejects duplicate logical names across yaml extensions",
    async () => {
      await withTemplatesDir(
        { "duplicate.yaml": VALID_TEMPLATE, "duplicate.yml": VALID_TEMPLATE },
        async (dir, modelsSnapshot) => {
          const result = await runGenerate(dir, modelsSnapshot)
          expect(result.exitCode).not.toBe(0)
          expect(result.output).toContain("duplicated across .yaml/.yml")
        },
      )
    },
    { timeout: 60_000 },
  )
})
