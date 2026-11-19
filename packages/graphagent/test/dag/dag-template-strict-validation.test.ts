// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1560: DAG mode starts every workflow under the strict review gate, so the
// release and CI gate for a template directory judges each template twice: as
// authored, and under strict. A template that only passes as authored is one a
// DAG-mode session could never start, and it must not ship.
import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { dagTemplateDirectoryFailure, validateDagTemplateDirectory } from "../../script/dag-template-validation"

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

/** A template directory with the runtime pin it needs to be releasable. */
const directory = async (files: Record<string, string>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "template-strict-"))
  roots.push(dir)
  await fs.writeFile(
    path.join(dir, "runtime-compat.json"),
    JSON.stringify({ runtime_repo: "LeXwDeX/GraphAgent", runtime_commit: "0".repeat(40) }),
  )
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content)
  return dir
}

const MARKER = "[strict review gate: DAG mode applies it to every start]"

// A review block with the default lenses has no completeness lens: valid as
// authored (the standard gate only warns), invalid under strict.
const STANDARD_ONLY = `inputs:
  objective: {}
config:
  name: standard-only
  objective: "Review the change. Request: {{objective}}"
  blocks:
    - id: survey
      kind: explore
    - id: decision
      kind: review
      depends_on: [survey]
`

const STRICT_VALID = STANDARD_ONLY.replace("standard-only", "strict-valid").replace(
  "      depends_on: [survey]\n",
  "      depends_on: [survey]\n      lenses: [standards, intent, completeness]\n",
)

// A hand-written node on a write-capable worker: fine as authored, never under strict.
const NODES_WRITER = `config:
  name: nodes-writer
  nodes:
    - id: work
      name: work
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "Do the work"
`

const entry = (results: Awaited<ReturnType<typeof validateDagTemplateDirectory>>["results"], name: string) => {
  const found = results.find((result) => result.name === name)
  if (!found) throw new Error(`no result for ${name}`)
  return found
}

describe("template directory validation under the strict review gate", () => {
  it("fails a template that is valid only as authored and passes one that is strict-valid", async () => {
    const dir = await directory({ "standard-only.yaml": STANDARD_ONLY, "strict-valid.yaml": STRICT_VALID })
    const validation = await validateDagTemplateDirectory(dir)

    const strictValid = entry(validation.results, "strict-valid.yaml")
    expect(strictValid.valid).toBe(true)
    expect(strictValid.errors).toEqual([])

    const standardOnly = entry(validation.results, "standard-only.yaml")
    expect(standardOnly.valid).toBe(false)
    expect(standardOnly.errors).toHaveLength(1)
    const [error] = standardOnly.errors
    expect(error.code).toBe("block.compile_failed")
    expect(error.message).toContain('Review block "decision" must include the completeness lens')
    // It says the finding comes from the strict pass, and how to satisfy it.
    expect(error.message).toContain(MARKER)
    expect(error.hint).toContain("add completeness to the review block's lenses")
    expect(error.hint).not.toContain("lower config.review_gate")
    // Authored on its own, the template raised nothing but the standard advisory.
    expect(standardOnly.warnings.map((warning) => warning.message)).toEqual([
      expect.stringContaining("strict review decision must include the completeness lens"),
    ])
  })

  it("makes the release and CI failure name the template that only passes as authored", async () => {
    const dir = await directory({ "standard-only.yaml": STANDARD_ONLY, "strict-valid.yaml": STRICT_VALID })
    const failure = dagTemplateDirectoryFailure(await validateDagTemplateDirectory(dir))
    expect(failure).toContain("DAG template validation failed:")
    expect(failure).toContain("- standard-only.yaml [block.compile_failed] config.blocks:")
    expect(failure).toContain(MARKER)
    expect(failure).not.toContain("strict-valid.yaml")

    const passing = await directory({ "strict-valid.yaml": STRICT_VALID })
    expect(dagTemplateDirectoryFailure(await validateDagTemplateDirectory(passing))).toBeUndefined()
  })

  it("rejects a node-form writer that passes as authored, without suggesting a lower gate", async () => {
    const dir = await directory({ "nodes-writer.yaml": NODES_WRITER })
    const { results } = await validateDagTemplateDirectory(dir)
    const writer = entry(results, "nodes-writer.yaml")
    expect(writer.valid).toBe(false)
    expect(writer.errors).toHaveLength(1)
    expect(writer.errors[0].path).toBe("nodes[work].worker_type")
    expect(writer.errors[0].message).toContain(MARKER)
    expect(writer.errors[0].hint).toContain("DAG mode fixes the strict review gate")
    expect(writer.errors[0].hint).not.toContain("lower config.review_gate")
  })

  it("reports a finding that both gates raise once, with the hint of the spec's own gate", async () => {
    const declared = NODES_WRITER.replace("  name: nodes-writer\n", "  name: declared-strict\n  review_gate: strict\n")
    const dir = await directory({ "declared-strict.yaml": declared })
    const { results } = await validateDagTemplateDirectory(dir)
    const writer = entry(results, "declared-strict.yaml")
    expect(writer.valid).toBe(false)
    expect(writer.errors).toHaveLength(1)
    expect(writer.errors[0].message).not.toContain(MARKER)
    expect(writer.errors[0].hint).toContain("lower config.review_gate to standard")
  })

  it("reports a failure no gate changes once", async () => {
    // A review fed by a prototype with no verification fails block routing under any gate.
    const broken = `config:
  name: broken-route
  objective: Ship the bounded change
  blocks:
    - id: proto
      kind: prototype
    - id: decision
      kind: review
      depends_on: [proto]
`
    const dir = await directory({ "broken-route.yaml": broken })
    const { results } = await validateDagTemplateDirectory(dir)
    const route = entry(results, "broken-route.yaml")
    expect(route.valid).toBe(false)
    expect(route.errors).toHaveLength(1)
    expect(route.errors[0].message).toContain("requires exactly one verification ancestor")
    expect(route.errors[0].message).not.toContain(MARKER)
  })
})
