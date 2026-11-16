// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1073: a saved or builtin workflow that declares `inputs` starts straight
// from `run.start { spec_path, inputs }`, with no draft and no rewritten file.
// The cases run the tool entry points on a real database; the global
// workflow scope is pointed at an empty directory so a user's own workflows
// never shadow the builtin stage specs.
import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"
import { DagStore } from "@graphagent/core/dag/store"
import { parseWorkflowConfig } from "@/dag/dag"
import {
  cleanup,
  failureText,
  list,
  read,
  repo,
  run,
  seed,
  start,
  validate,
  withEmptyGlobalConfig,
  workflowID,
} from "./workflow-harness"

afterEach(cleanup)

const caller = (directory: string) => ({ session: "ses_template", directory })

const ReadPayload = Schema.Struct({
  spec: Schema.Struct({
    inputs: Schema.Record(Schema.String, Schema.Unknown),
    config: Schema.Struct({ objective: Schema.String }),
  }),
  validation: Schema.Struct({ valid: Schema.Boolean, errors: Schema.Array(Schema.Unknown) }),
})

const storedConfig = (id: string) =>
  Effect.gen(function* () {
    const workflow = yield* (yield* DagStore.Service).getWorkflow(id)
    const config = parseWorkflowConfig(workflow?.config ?? "{}")
    if (!config) throw new Error("workflow config is not readable")
    return config
  })

describe("run.start { spec_path, inputs } on a builtin stage spec", () => {
  it("starts the stage from the request alone and carries it into every child prompt", async () => {
    const dir = repo()
    await withEmptyGlobalConfig(() =>
      run(
        Effect.gen(function* () {
          yield* seed([["ses_template", dir]])
          const result = yield* start(caller(dir), "stage-understand", { objective: "Make session recovery durable" })
          expect(result.title).toBe("Workflow started: stage-understand")
          expect(result.output).toContain("Inputs: objective.")
          const config = yield* storedConfig(workflowID(result.output))
          expect(config.nodes.length).toBeGreaterThan(0)
          for (const entry of config.nodes)
            expect(String(entry.prompt_template.input?.objective)).toContain("Make session recovery durable")
          // The generic stage purpose stays beside the request.
          expect(String(config.nodes[0]?.prompt_template.input?.objective)).toContain("Understand the request")
        }),
      ),
    )
  })

  it("replaces the acceptance list with a typed input and reports which inputs used their default", async () => {
    const dir = repo()
    await withEmptyGlobalConfig(() =>
      run(
        Effect.gen(function* () {
          yield* seed([["ses_template", dir]])
          const acceptance = [
            { id: "AC1", text: "Recovery survives a restart" },
            { id: "AC2", text: "No event is replayed twice" },
          ]
          const result = yield* start(caller(dir), "stage-implement", { objective: "Implement recovery", acceptance })
          expect(result.output).toContain("Inputs: objective, acceptance, verify_command (default).")
          expect((yield* storedConfig(workflowID(result.output))).acceptance).toEqual(acceptance)
        }),
      ),
    )
  })

  it("falls back to the declared default when an optional input is omitted", async () => {
    const dir = repo()
    await withEmptyGlobalConfig(() =>
      run(
        Effect.gen(function* () {
          yield* seed([["ses_template", dir]])
          const result = yield* start(caller(dir), "stage-review", { objective: "Review the change" })
          const config = yield* storedConfig(workflowID(result.output))
          expect(config.acceptance?.map((item) => item.id)).toEqual(["AC1"])
          expect(result.output).toContain("acceptance (default)")
        }),
      ),
    )
  })

  it("names the missing input and every declared input instead of starting", async () => {
    const dir = repo()
    await withEmptyGlobalConfig(() =>
      run(
        Effect.gen(function* () {
          yield* seed([["ses_template", dir]])
          const text = yield* failureText(start(caller(dir), "stage-implement"))
          expect(text).toContain("Workflow start rejected by workflow validation")
          expect(text).toContain('required input "objective" was not supplied')
          expect(text).toContain("Declared inputs: objective*, acceptance")
          expect((yield* (yield* DagStore.Service).listWorkflows()).length).toBe(0)
        }),
      ),
    )
  })

  it("rejects an input the spec does not declare and one of the wrong type", async () => {
    const dir = repo()
    await withEmptyGlobalConfig(() =>
      run(
        Effect.gen(function* () {
          yield* seed([["ses_template", dir]])
          const unknown = yield* failureText(start(caller(dir), "stage-understand", { objective: "x", scope: "src" }))
          expect(unknown).toContain('input "scope" is not declared by this spec')
          expect(unknown).toContain("Declared inputs: objective*")
          const wrongType = yield* failureText(
            start(caller(dir), "stage-implement", { objective: "x", acceptance: "AC1: it works" }),
          )
          expect(wrongType).toContain('input "acceptance" must be an array')
        }),
      ),
    )
  })

  it("refuses inputs for a spec that declares none", async () => {
    const dir = repo()
    await withEmptyGlobalConfig(() =>
      run(
        Effect.gen(function* () {
          yield* seed([["ses_template", dir]])
          mkdirSync(path.join(dir, ".agents", "workflows"), { recursive: true })
          writeFileSync(
            path.join(dir, ".agents", "workflows", "plain.yaml"),
            "config:\n  name: plain\n  objective: Map it\n  blocks:\n    - id: scan\n      kind: explore\n",
          )
          const text = yield* failureText(start(caller(dir), "plain", { objective: "x" }))
          expect(text).toContain("declares no inputs")
          // No inputs at all keeps the original behavior.
          expect((yield* start(caller(dir), "plain")).title).toBe("Workflow started: plain")
        }),
      ),
    )
  })

  it("starts a project saved workflow with its own inputs", async () => {
    const dir = repo()
    await withEmptyGlobalConfig(() =>
      run(
        Effect.gen(function* () {
          yield* seed([["ses_template", dir]])
          mkdirSync(path.join(dir, ".agents", "workflows"), { recursive: true })
          writeFileSync(
            path.join(dir, ".agents", "workflows", "audit.yaml"),
            [
              "inputs:",
              "  objective: { description: What to audit }",
              "  paths: { type: array, default: [src] }",
              "  depth: { type: number, default: 2 }",
              "config:",
              '  name: "audit"',
              '  objective: "Audit: {{objective}}"',
              "  blocks:",
              "    - id: scan",
              "      kind: explore",
              '      instruction: "Read {{paths}} to depth {{depth}}"',
              "",
            ].join("\n"),
          )
          const result = yield* start(caller(dir), "audit", { objective: "the cache layer", depth: 3 })
          const config = yield* storedConfig(workflowID(result.output))
          const scan = config.nodes.find((entry) => entry.id === "scan")
          expect(scan?.prompt_template.input).toMatchObject({
            objective: "Audit: the cache layer",
            instruction: "Read src to depth 3",
          })
        }),
      ),
    )
  })
})

// A template is judged on its own with sample values for its required inputs.
// A sample that breaks a constraint on the input's value is no defect of the
// template: a strict writer needs 1-50 acceptance items, and the empty list a
// required `array` input used to be sampled as made every such template look
// unstartable.
describe("judging a template on its own", () => {
  const strictWriter = (blocks: string[]) =>
    [
      "inputs:",
      "  objective: {}",
      "  acceptance: { type: array }",
      "config:",
      "  name: strict-writer",
      "  review_gate: strict",
      '  objective: "Ship it. Request: {{objective}}"',
      '  acceptance: "{{acceptance}}"',
      "  blocks:",
      ...blocks,
      "",
    ].join("\n")

  const WRITER = ["    - id: impl", "      kind: coding"]
  const VERIFY = ["    - id: checks", "      kind: verify", "      depends_on: [impl]"]
  // The strict gate also wants a required final gate behind the review decision.
  const REVIEW = [
    "    - id: decision",
    "      kind: review",
    "      depends_on: [checks]",
    "      lenses: [standards, intent, completeness]",
    "    - id: final",
    "      kind: synthesize",
    "      depends_on: [decision]",
  ]

  const withLibrary = <E, R>(files: Record<string, string>, body: (dir: string) => Effect.Effect<void, E, R>) =>
    Effect.gen(function* () {
      const dir = repo()
      yield* seed([["ses_template", dir]])
      mkdirSync(path.join(dir, ".agents", "workflows"), { recursive: true })
      for (const [name, content] of Object.entries(files))
        writeFileSync(path.join(dir, ".agents", "workflows", `${name}.yaml`), content)
      yield* body(dir)
    })

  it("does not call a strict writer template with a required acceptance list unstartable", async () => {
    await withEmptyGlobalConfig(() =>
      run(
        withLibrary({ "strict-writer": strictWriter([...WRITER, ...VERIFY, ...REVIEW]) }, (dir) =>
          Effect.gen(function* () {
            const listing = (yield* list(caller(dir))).output
            expect(listing).toContain("strict-writer [project]")
            expect(listing).toContain("inputs: objective*, acceptance:array*")
            expect(listing).not.toContain("[invalid")
            const payload = Schema.decodeUnknownSync(ReadPayload)(
              JSON.parse((yield* read(caller(dir), "strict-writer")).output),
            )
            expect(payload.validation).toEqual({ valid: true, errors: [] })
            // The template starts once the caller supplies what it requires.
            const result = yield* start(caller(dir), "strict-writer", {
              objective: "Make it durable",
              acceptance: [{ id: "AC1", text: "It survives a restart" }],
            })
            expect(result.title).toBe("Workflow started: strict-writer")
          }),
        ),
      ),
    )
  })

  it("still flags a real structural defect of the template", async () => {
    await withEmptyGlobalConfig(() =>
      run(
        // The writer has no review behind it: a defect whatever acceptance the caller passes.
        withLibrary({ "unreviewed-writer": strictWriter([...WRITER, ...VERIFY]) }, (dir) =>
          Effect.gen(function* () {
            const listing = (yield* list(caller(dir))).output
            expect(listing).toContain("unreviewed-writer [project] [invalid — not startable]")
            expect(listing).toContain('Writer block "impl" has no downstream review gate')
            const payload = Schema.decodeUnknownSync(ReadPayload)(
              JSON.parse((yield* read(caller(dir), "unreviewed-writer")).output),
            )
            expect(payload.validation.valid).toBe(false)
          }),
        ),
      ),
    )
  })
})

describe("spec list, read, and validate for templates", () => {
  it("lists the declared inputs of each stage spec and how to start one", async () => {
    const dir = repo()
    await withEmptyGlobalConfig(() =>
      run(
        Effect.gen(function* () {
          yield* seed([["ses_template", dir]])
          const listing = (yield* list(caller(dir))).output
          expect(listing).toContain("stage-implement [builtin]")
          expect(listing).not.toContain("[invalid")
          expect(listing).toMatch(/inputs: objective\*, acceptance:array=\[1 item\], verify_command="none"/)
          expect(listing).toContain('spec_path:"<name>",inputs:{...}')
        }),
      ),
    )
  })

  it("reads a template as written, with its declarations and placeholders, and judges it valid", async () => {
    const dir = repo()
    await withEmptyGlobalConfig(() =>
      run(
        Effect.gen(function* () {
          yield* seed([["ses_template", dir]])
          const payload = Schema.decodeUnknownSync(ReadPayload)(
            JSON.parse((yield* read(caller(dir), "stage-design")).output),
          )
          expect(Object.keys(payload.spec.inputs)).toEqual(["objective"])
          expect(payload.spec.config.objective).toContain("{{objective}}")
          expect(payload.validation.valid).toBe(true)
        }),
      ),
    )
  })

  it("validates a template against its inputs the way start does", async () => {
    const dir = repo()
    await withEmptyGlobalConfig(() =>
      run(
        Effect.gen(function* () {
          yield* seed([["ses_template", dir]])
          const bare = yield* validate(caller(dir), "stage-review")
          expect(bare.title).toContain("failed")
          expect(bare.output).toContain('required input \\"objective\\" was not supplied')
          const filled = yield* validate(caller(dir), "stage-review", { objective: "Review the change" })
          expect(filled.title).toContain("passed")
          const wrong = yield* validate(caller(dir), "stage-review", { objective: "x", acceptance: [{ id: "AC1" }] })
          expect(wrong.title).toContain("failed")
          // The failing field names the input that filled it.
          expect(wrong.output).toContain('this value comes from input \\"acceptance\\"')
        }),
      ),
    )
  })
})
