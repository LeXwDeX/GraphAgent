// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1560: with DAG mode on, every `run.start` runs under the strict review gate
// (ADR-0006), whatever the spec's source or declaration. The spec actions must
// judge a spec under the same gate, or `validate` passes a spec the start then
// refuses, and a strict failure must not advise lowering a gate the session
// fixed. The cases run the tool entry points on a real database with no
// execution loop, so a started workflow stays `running`.
import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Exit } from "effect"
import { DagStore } from "@graphagent/core/dag/store"
import { parseWorkflowConfig } from "@/dag/dag"
import { workflowDraftsArea } from "@/dag/runtime/output-ref"
import {
  cleanup,
  draft,
  extend,
  failureText,
  list,
  projectID,
  read,
  repo,
  run,
  seed,
  start,
  validate,
  workflowID,
  writeSpec,
} from "./workflow-harness"

afterEach(async () => {
  cleanup()
  await fs.rm(workflowDraftsArea(projectID), { recursive: true, force: true })
})

const LOWER = "lower config.review_gate"

type Mode = "on" | "off"

const caller = (directory: string, dagMode?: Mode, session = "ses_gate") => ({
  session,
  directory,
  ...(dagMode !== undefined ? { dagMode } : {}),
})

/** A read-only review route. It declares `standard`, so a DAG-mode start proves
 * the session's gate overrides what the spec says. Without `completeness` among
 * the lenses it is valid under standard only. */
const route = (name: string, lenses = "[standards, intent, completeness]") => `config:
  name: ${name}
  review_gate: standard
  objective: Review the bounded change
  blocks:
    - id: survey
      kind: explore
    - id: decision
      kind: review
      depends_on: [survey]
      lenses: ${lenses}
`

const STRICT_OK = route("strict-ok")
const STANDARD_ONLY = route("standard-only", "[standards, intent]")

/** A hand-written node on a write-capable worker: valid as authored, never under strict. */
const nodesWriter = (name: string, gate = "") => `config:
  name: ${name}
${gate}  nodes:
    - id: work
      name: work
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "Do the work"
`

const storedGate = (id: string) =>
  Effect.gen(function* () {
    const workflow = yield* (yield* DagStore.Service).getWorkflow(id)
    return parseWorkflowConfig(workflow?.config ?? "{}")?.review_gate
  })

/** Run `body` with a global workflow library holding `files` and with a release
 * snapshot of builtin templates, restoring both afterwards. */
async function withLibraries<A>(
  input: { global: Record<string, string>; snapshot: Record<string, string> },
  body: () => Promise<A>,
) {
  const config = mkdtempSync(path.join(tmpdir(), "session-gate-global-"))
  mkdirSync(path.join(config, "workflows"), { recursive: true })
  for (const [file, content] of Object.entries(input.global))
    writeFileSync(path.join(config, "workflows", file), content)
  const globals = globalThis as Record<string, unknown>
  const previousSnapshot = globals.GRAPHAGENT_DAG_TEMPLATES
  const previousConfig = process.env.GRAPHAGENT_CONFIG_DIR
  globals.GRAPHAGENT_DAG_TEMPLATES = input.snapshot
  process.env.GRAPHAGENT_CONFIG_DIR = config
  try {
    return await body()
  } finally {
    if (previousSnapshot === undefined) delete globals.GRAPHAGENT_DAG_TEMPLATES
    else globals.GRAPHAGENT_DAG_TEMPLATES = previousSnapshot
    if (previousConfig === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
    else process.env.GRAPHAGENT_CONFIG_DIR = previousConfig
    rmSync(config, { recursive: true, force: true })
  }
}

/** Put a spec in the project library of `directory`, startable by its name. */
const projectSpec = (directory: string, name: string, content: string) => {
  mkdirSync(path.join(directory, ".agents", "workflows"), { recursive: true })
  writeFileSync(path.join(directory, ".agents", "workflows", `${name}.yaml`), content)
}

const draftConfig = (name: string, lenses: readonly ("standards" | "intent" | "completeness")[]) => ({
  name,
  objective: "Review the bounded change",
  blocks: [
    { id: "survey", kind: "explore" as const },
    { id: "decision", kind: "review" as const, depends_on: ["survey"], lenses: [...lenses] },
  ],
})

describe("a start from any source in a DAG-mode session", () => {
  it("persists the strict gate whatever the source, over a spec that declares standard", async () => {
    const dir = repo()
    projectSpec(dir, "project-flow", route("project-flow"))
    await withLibraries(
      { global: { "global-flow.yaml": route("global-flow") }, snapshot: { "snapshot-flow": route("snapshot-flow") } },
      () =>
        run(
          Effect.gen(function* () {
            yield* seed([["ses_gate", dir]])
            const pathSpec = writeSpec(route("path-flow"))
            for (const mode of ["on", "off", undefined] as const) {
              const drafted = yield* draft(
                caller(dir, mode),
                draftConfig(`draft-flow-${mode ?? "unset"}`, ["standards", "intent", "completeness"]),
              )
              expect(drafted.title).toContain("Workflow draft valid")
              const draftPath = /spec_path: (\S+)/.exec(drafted.output)?.[1] ?? ""
              expect(draftPath).not.toBe("")

              // builtin (release snapshot), project, global, path, draft
              for (const source of ["snapshot-flow", "project-flow", "global-flow", pathSpec, draftPath]) {
                const started = yield* start(caller(dir, mode), source)
                expect(started.title).toContain("Workflow started")
                expect(yield* storedGate(workflowID(started.output))).toBe(mode === "on" ? "strict" : "standard")
              }
            }
          }),
        ),
    )
  })

  it("keeps a builtin stage spec strict, as it declares", async () => {
    const dir = repo()
    await withLibraries({ global: {}, snapshot: {} }, () =>
      run(
        Effect.gen(function* () {
          yield* seed([["ses_gate", dir]])
          for (const mode of ["on", "off"] as const) {
            const started = yield* start(caller(dir, mode), "stage-understand", { objective: "Understand it" })
            expect(yield* storedGate(workflowID(started.output))).toBe("strict")
          }
        }),
      ),
    )
  })
})

describe("spec actions and start agree in a DAG-mode session", () => {
  const fixtures = [
    { name: "strict-ok", yaml: STRICT_OK, strictValid: true },
    { name: "standard-only", yaml: STANDARD_ONLY, strictValid: false },
    { name: "nodes-writer", yaml: nodesWriter("nodes-writer"), strictValid: false },
  ] as const

  const listedStartable = (output: string, name: string) => {
    const row = output.split("\n").find((line) => line.startsWith(`${name} [project]`))
    if (row === undefined) throw new Error(`${name} is not listed:\n${output}`)
    return !row.includes("[invalid — not startable]")
  }

  for (const mode of ["on", "off"] as const) {
    it(`gives validate, read, list and start one verdict with DAG mode ${mode}`, async () => {
      const dir = repo()
      for (const fixture of fixtures) projectSpec(dir, fixture.name, fixture.yaml)
      await withLibraries({ global: {}, snapshot: {} }, () =>
        run(
          Effect.gen(function* () {
            yield* seed([["ses_gate", dir]])
            const who = caller(dir, mode)
            const listing = (yield* list(who)).output
            for (const fixture of fixtures) {
              const expected = mode === "off" || fixture.strictValid
              const specFile = writeSpec(fixture.yaml)
              const validated = JSON.parse((yield* validate(who, specFile)).output).valid
              const readValid = JSON.parse((yield* read(who, specFile)).output).validation.valid
              const startable = Exit.isSuccess(yield* Effect.exit(start(who, specFile)))
              expect({
                fixture: fixture.name,
                validated,
                readValid,
                listed: listedStartable(listing, fixture.name),
                startable,
              }).toEqual({
                fixture: fixture.name,
                validated: expected,
                readValid: expected,
                listed: expected,
                startable: expected,
              })
            }
          }),
        ),
      )
    })

    it(`gives draft and start one verdict with DAG mode ${mode}`, async () => {
      const dir = repo()
      await run(
        Effect.gen(function* () {
          yield* seed([["ses_gate", dir]])
          const who = caller(dir, mode)
          for (const [name, lenses, strictValid] of [
            ["draft-strict", ["standards", "intent", "completeness"], true],
            ["draft-standard", ["standards", "intent"], false],
          ] as const) {
            const expected = mode === "off" || strictValid
            const drafted = yield* draft(who, draftConfig(`${name}-${mode}`, lenses))
            expect(
              drafted.title.startsWith(
                expected ? "Workflow draft valid" : "Workflow draft written with validation errors",
              ),
            ).toBe(true)
            const draftPath = /spec_path: (\S+)/.exec(drafted.output)?.[1] ?? ""
            expect(Exit.isSuccess(yield* Effect.exit(start(who, draftPath)))).toBe(expected)
          }
        }),
      )
    })
  }
})

describe("a strict failure in a DAG-mode session", () => {
  it("does not advise lowering the gate, in start or in validate", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_gate", dir]])
        const specFile = writeSpec(nodesWriter("nodes-writer"))

        const refused = yield* failureText(start(caller(dir, "on"), specFile))
        expect(refused).toContain("Workflow start rejected by workflow validation")
        expect(refused).toContain("nodes[work].worker_type")
        expect(refused).toContain("DAG mode fixes the strict review gate at start, so the spec cannot lower it")
        expect(refused).toContain("use the blocks form (objective + blocks)")
        expect(refused).not.toContain(LOWER)

        const validated = JSON.parse((yield* validate(caller(dir, "on"), specFile)).output)
        expect(validated.valid).toBe(false)
        expect(JSON.stringify(validated.errors)).not.toContain(LOWER)
        expect(validated.errors[0].hint).toContain("DAG mode fixes the strict review gate at start")
      }),
    )
  })

  it("still advises lowering a gate the spec declared itself", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_gate", dir]])
        const declared = writeSpec(nodesWriter("declared-strict", "  review_gate: strict\n"))
        for (const mode of ["off", undefined] as const) {
          expect(yield* failureText(start(caller(dir, mode), declared))).toContain(
            "Use the blocks form (objective + blocks) or lower config.review_gate to standard",
          )
        }
      }),
    )
  })

  it("says how to satisfy the rule it broke", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_gate", dir]])
        const refused = yield* failureText(start(caller(dir, "on"), writeSpec(STANDARD_ONLY)))
        expect(refused).toContain('Review block "decision" must include the completeness lens under the strict gate')
        expect(refused).toContain("add completeness to the review block's lenses")
        expect(refused).not.toContain(LOWER)
      }),
    )
  })
})

describe("a mutation keeps the gate its workflow froze at start", () => {
  // A review with the default lenses: valid under standard, not under strict.
  const fragment = () =>
    writeSpec({
      objective: "Review one more thing",
      blocks: [
        { id: "scan-more", kind: "explore" },
        { id: "decision-more", kind: "review", depends_on: ["scan-more"] },
      ],
    })

  it("accepts in a DAG-mode session a fragment that only the frozen standard gate allows", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_gate", dir]])
        const id = workflowID((yield* start(caller(dir, "off"), writeSpec(STANDARD_ONLY))).output)
        expect(yield* storedGate(id)).toBe("standard")
        const extended = yield* extend(caller(dir, "on"), id, fragment())
        expect(extended.title).toContain("Workflow extended")
      }),
    )
  })

  it("refuses, with the session off, a fragment that the frozen strict gate rejects", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_gate", dir]])
        const id = workflowID((yield* start(caller(dir, "on"), writeSpec(STRICT_OK))).output)
        expect(yield* storedGate(id)).toBe("strict")
        const refused = yield* failureText(extend(caller(dir, "off"), id, fragment()))
        expect(refused).toContain("must include the completeness lens under the strict gate")
        expect(refused).toContain(
          "The workflow's strict review gate was frozen at start, so a fragment cannot lower it",
        )
        expect(refused).not.toContain(LOWER)
      }),
    )
  })
})
