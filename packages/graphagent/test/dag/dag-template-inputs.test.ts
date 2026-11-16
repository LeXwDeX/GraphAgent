// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1073: template inputs at the Workflow Authoring Check. A start document may
// declare `inputs` and refer to them as `{{name}}`; the call fills them. These
// cases pin the substitution rules (declared names only, typed whole-field
// placeholders, no second scan of a value), the supply rules (required, default,
// type, unknown), and the way an instantiated document is decoded and reported.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagTemplateInputs } from "@/dag/template-inputs"
import { validateDagTemplateDirectory } from "../../script/dag-template-validation"

const authoring = WorkflowAuthoring.make()

const values = (supplied: Record<string, unknown>): DagTemplateInputs.Supply => ({ kind: "values", values: supplied })

/** A document with a few inputs around one explore block. */
const spec = (inputs: unknown, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  title: "Template {{objective}}",
  inputs,
  config: {
    name: "templated",
    objective: "Goal: {{objective}}",
    blocks: [{ id: "scan", kind: "explore", instruction: "Look at {{paths}}" }],
    ...config,
  },
  ...extra,
})

const declarations = {
  objective: { description: "The request" },
  paths: { type: "array", default: ["src"] },
}

const instantiate = (document: unknown, supply?: DagTemplateInputs.Supply) =>
  DagTemplateInputs.instantiate(document, supply)

const messages = (outcome: DagTemplateInputs.Outcome) => outcome.diagnostics.map((entry) => entry.message)

describe("declarations", () => {
  it("reads type, description, and default; an input without a default is required", () => {
    const list = DagTemplateInputs.declarationsOf({
      inputs: {
        objective: {},
        depth: { type: "number", default: 2 },
        note: { description: "Say more", default: "" },
        fast: { type: "boolean", default: false },
      },
    })
    expect(list.map((entry) => [entry.name, entry.type, entry.required])).toEqual([
      ["objective", "string", true],
      ["depth", "number", false],
      ["note", "string", false],
      ["fast", "boolean", false],
    ])
    expect(list[2].description).toBe("Say more")
    // An empty-string default still counts as a default.
    expect(list[2].default).toBe("")
  })

  it("accepts a bare name as a required string input", () => {
    expect(DagTemplateInputs.declarationsOf({ inputs: { objective: null } }).map((entry) => entry.required)).toEqual([
      true,
    ])
  })

  it("summarizes required inputs with a star and optional ones with their default", () => {
    const list = DagTemplateInputs.declarationsOf({
      inputs: {
        objective: {},
        scope: { type: "array", default: [] },
        paths: { type: "array", default: ["a", "b"] },
        depth: { type: "number", default: 2 },
        command: { default: "bun run typecheck && bun test --timeout 30000 everything" },
        strict: { type: "boolean", default: true },
        required_list: { type: "array" },
      },
    })
    expect(DagTemplateInputs.summary(list)).toBe(
      'objective*, scope:array=[0 items], paths:array=[2 items], depth:number=2, command="bun run typecheck && bu…", strict:boolean=true, required_list:array*',
    )
  })

  it("is empty for a document without inputs and for a malformed declaration list", () => {
    expect(DagTemplateInputs.declarationsOf({ config: {} })).toEqual([])
    expect(DagTemplateInputs.declarationsOf("text")).toEqual([])
    expect(DagTemplateInputs.declarationsOf({ inputs: ["objective"] })).toEqual([])
  })
})

describe("instantiation", () => {
  it("replaces declared placeholders in every string, titles included, and drops the declarations", () => {
    const outcome = instantiate(spec(declarations), values({ objective: "ship it", paths: ["a", "b"] }))
    expect(outcome.diagnostics).toEqual([])
    expect(outcome.value).toEqual({
      title: "Template ship it",
      config: {
        name: "templated",
        objective: "Goal: ship it",
        blocks: [{ id: "scan", kind: "explore", instruction: "Look at a, b" }],
      },
    })
    expect(outcome.supplied).toEqual(["objective", "paths"])
    expect(outcome.defaulted).toEqual([])
  })

  it("uses the default of an omitted input and reports it", () => {
    const outcome = instantiate(spec(declarations), values({ objective: "ship it" }))
    expect(outcome.value).toMatchObject({ config: { blocks: [{ instruction: "Look at src" }] } })
    expect(outcome.supplied).toEqual(["objective"])
    expect(outcome.defaulted).toEqual(["paths"])
  })

  it("leaves a placeholder that names no declared input exactly as written", () => {
    const document = spec(declarations, {
      nodes: undefined,
      blocks: [{ id: "scan", kind: "explore", instruction: "Use {{scan-notes}} and {{ other }}, then {{objective}}" }],
    })
    const outcome = instantiate(document, values({ objective: "ship it" }))
    expect(outcome.value).toMatchObject({
      config: { blocks: [{ instruction: "Use {{scan-notes}} and {{ other }}, then ship it" }] },
    })
  })

  it("accepts spaces inside the braces", () => {
    const outcome = instantiate(spec(declarations, { objective: "{{  objective  }}" }), values({ objective: "x" }))
    expect(outcome.value).toMatchObject({ config: { objective: "x" } })
  })

  it("gives a field that is exactly one placeholder the input's own type", () => {
    const acceptance = [{ id: "AC1", text: "It works" }]
    const outcome = instantiate(
      spec(
        {
          objective: {},
          acceptance: { type: "array" },
          depth: { type: "number", default: 3 },
          deep: { type: "boolean", default: true },
        },
        {
          acceptance: "{{acceptance}}",
          max_concurrency: "{{depth}}",
          review_gate: "{{deep}}",
        },
      ),
      values({ objective: "x", acceptance }),
    )
    expect(outcome.value).toMatchObject({ config: { acceptance, max_concurrency: 3, review_gate: true } })
    expect(outcome.origins.map((origin) => origin.input).sort()).toEqual(["acceptance", "deep", "depth"])
  })

  it("renders a non-string input inside text: scalars joined, an empty list as (none), structures as JSON", () => {
    const outcome = instantiate(
      spec(
        {
          objective: {},
          a: { type: "array", default: [] },
          b: { type: "array", default: [1, "x", true] },
          c: { type: "array", default: [{ id: 1 }] },
          n: { type: "number", default: 7 },
        },
        {
          objective: "{{objective}}|{{a}}|{{b}}|{{c}}|{{n}}",
        },
      ),
      values({ objective: "o" }),
    )
    expect(outcome.value).toMatchObject({ config: { objective: 'o|(none)|1, x, true|[{"id":1}]|7' } })
  })

  it("never scans a substituted value again, and treats replacement patterns literally", () => {
    const outcome = instantiate(
      spec({ objective: {}, other: { default: "SHOULD NOT APPEAR" } }, { objective: "Goal: {{objective}}" }),
      values({ objective: "see {{other}} and $& and $1" }),
    )
    expect(outcome.value).toMatchObject({ config: { objective: "Goal: see {{other}} and $& and $1" } })
  })

  it("keeps a value with YAML-significant text a plain string: it cannot add structure", () => {
    const hostile = 'x"\nblocks:\n  - id: injected\n    kind: coding\n#'
    const outcome = instantiate(
      spec({ objective: {} }, { objective: "Goal: {{objective}}" }),
      values({ objective: hostile }),
    )
    expect(outcome.value).toMatchObject({
      config: { objective: `Goal: ${hostile}`, blocks: [{ id: "scan" }] },
    })
    // The value stayed text: no block with the injected id exists as a key.
    expect(JSON.stringify(outcome.value)).not.toContain('"id":"injected"')
  })

  it("does not touch object keys or the declarations' own text", () => {
    const outcome = instantiate(
      spec({ objective: { description: "Use {{objective}} here" } }, { "{{objective}}": "key stays" }),
      values({ objective: "x" }),
    )
    expect(outcome.value).toMatchObject({ config: { "{{objective}}": "key stays" } })
  })

  it("warns about a declared input that no placeholder uses", () => {
    const outcome = instantiate(spec({ objective: {}, ignored: { default: "x" } }), values({ objective: "x" }))
    expect(outcome.diagnostics).toHaveLength(1)
    expect(outcome.diagnostics[0]).toMatchObject({ severity: "warning", path: "inputs.ignored" })
    expect(outcome.diagnostics[0].message).toContain(
      'input "ignored" is declared but no {{ignored}} placeholder uses it',
    )
  })
})

describe("supplying inputs", () => {
  const errors = (supply?: DagTemplateInputs.Supply, document: unknown = spec(declarations)) =>
    messages(instantiate(document, supply))

  it("reports a required input that was not supplied, with every declared input", () => {
    const outcome = instantiate(spec(declarations), values({}))
    expect(messages(outcome)).toEqual(['required input "objective" was not supplied'])
    expect(outcome.diagnostics[0].hint).toContain("Declared inputs: objective*, paths:array=[1 item]")
    expect(outcome.diagnostics[0].path).toBe("inputs.objective")
  })

  it("treats no supply like an empty one: required inputs are still required", () => {
    expect(errors(undefined)).toEqual(['required input "objective" was not supplied'])
  })

  it("rejects an input the spec does not declare", () => {
    expect(errors(values({ objective: "x", scope: "y" }))).toEqual(['input "scope" is not declared by this spec'])
  })

  it("rejects a value of the wrong type for each declared type", () => {
    const typed = spec({
      s: { default: "" },
      n: { type: "number", default: 0 },
      b: { type: "boolean", default: false },
      a: { type: "array", default: [] },
    })
    expect(errors(values({ s: 1 }), typed)).toEqual(['input "s" must be a string, got a number'])
    expect(errors(values({ n: "1" }), typed)).toEqual(['input "n" must be a number, got a string'])
    expect(errors(values({ n: Number.NaN }), typed)).toEqual(['input "n" must be a number, got a number'])
    expect(errors(values({ b: "true" }), typed)).toEqual(['input "b" must be a boolean, got a string'])
    expect(errors(values({ a: { 0: "x" } }), typed)).toEqual(['input "a" must be an array, got an object'])
    expect(errors(values({ a: null }), typed)).toEqual(['input "a" must be an array, got null'])
  })

  it("rejects inputs for a document that declares none, and accepts an empty call", () => {
    const plain = { config: { name: "p", objective: "x", blocks: [{ id: "a", kind: "explore" }] } }
    expect(errors(values({ objective: "x" }), plain)).toEqual([
      "this spec declares no inputs, but the call passed inputs: objective",
    ])
    expect(instantiate(plain, values({}))).toMatchObject({ declared: false, diagnostics: [], value: plain })
    expect(instantiate(plain)).toMatchObject({ declared: false, diagnostics: [], value: plain })
  })

  it("rejects a declaration that cannot be used", () => {
    expect(errors(values({}), spec({ "bad name": {} }))[0]).toContain('input name "bad name" must start with a letter')
    expect(errors(values({}), spec({ n: { type: "number", default: "two" } }))[0]).toContain(
      'input "n" declares type number but its default is a string',
    )
    expect(errors(values({}), spec({ n: { type: "float" } }))[0]).toContain('input "n" is not a valid declaration')
    expect(errors(values({}), spec({ n: { colour: "red" } }))[0]).toContain('input "n" is not a valid declaration')
    expect(errors(values({}), spec(["objective"]))[0]).toContain("inputs must be a mapping")
  })

  it("stands a sample in for a required input, and prefers a default over a sample", () => {
    const outcome = instantiate(
      spec(
        { objective: {}, n: { type: "number" }, paths: { type: "array", default: ["src"] } },
        { objective: "{{objective}}:{{n}}:{{paths}}" },
      ),
      { kind: "sample" },
    )
    expect(outcome.diagnostics.filter((entry) => entry.severity === "error")).toEqual([])
    expect(outcome.value).toMatchObject({ config: { objective: "sample:1:src" } })
    expect(outcome.supplied).toEqual([])
  })
})

// A sample must satisfy the field it fills, not only the declared type, or a
// template whose real callers pass valid values is judged unstartable.
describe("sample values follow the field they fill", () => {
  const sampled = (inputs: unknown, config: Record<string, unknown>) =>
    instantiate(spec(inputs, config), { kind: "sample" }).value

  it("gives a required list an element of the shape the field takes", () => {
    expect(sampled({ objective: {}, acceptance: { type: "array" } }, { acceptance: "{{acceptance}}" })).toMatchObject({
      config: { acceptance: [{ id: "sample", text: "sample" }] },
    })
  })

  it("takes an allowed value for a string field that only allows some, and a number for a numeric one", () => {
    expect(
      sampled({ objective: {}, gate: {}, width: { type: "number" } }, { review_gate: "{{gate}}", max_concurrency: "{{width}}" }),
    ).toMatchObject({ config: { review_gate: "strict", max_concurrency: 1 } })
  })

  it("leaves a list of plain references empty: any element would name a block that is not there", () => {
    expect(
      sampled(
        { objective: {}, after: { type: "array" } },
        { blocks: [{ id: "scan", kind: "explore" }, { id: "next", kind: "explore", depends_on: "{{after}}" }] },
      ),
    ).toMatchObject({ config: { blocks: [{ id: "scan" }, { id: "next", depends_on: [] }] } })
  })

  it("keeps the type sample where the placeholder sits inside text or the field is not known", () => {
    expect(
      sampled({ objective: {}, paths: { type: "array" } }, { objective: "Scope: {{paths}}", unknown_field: "{{paths}}" }),
    ).toMatchObject({ config: { objective: "Scope: (none)", unknown_field: [] } })
  })

  it("never replaces a declared default", () => {
    expect(
      sampled({ objective: {}, acceptance: { type: "array", default: [{ id: "AC9", text: "kept" }] } }, { acceptance: "{{acceptance}}" }),
    ).toMatchObject({ config: { acceptance: [{ id: "AC9", text: "kept" }] } })
  })
})

describe("the Workflow Authoring Check", () => {
  const source = (document: unknown) => ({ kind: "inline" as const, value: document, source: "<template>" })
  const prepare = (document: unknown, template?: DagTemplateInputs.Supply) =>
    Effect.runPromise(
      authoring.prepare({
        action: "start",
        source: source(document),
        profile: "portable",
        ...(template ? { template } : {}),
      }),
    )

  it("compiles the instantiated document and returns the template as written", async () => {
    const document = spec(declarations)
    const result = await prepare(document, values({ objective: "ship it" }))
    expect(result.errors).toEqual([])
    expect(result.template).toEqual({ supplied: ["objective"], defaulted: ["paths"] })
    // The document shows the template, declarations and placeholders included.
    expect(result.document).toEqual(document)
    if (result.prepared?.action !== "start") throw new Error("expected a prepared start")
    expect(result.prepared.title).toBe("Template ship it")
    expect(result.prepared.config.name).toBe("templated")
    expect(String(result.prepared.nodes[0].prompt_template.input?.objective)).toBe("Goal: ship it")
    expect(String(result.prepared.nodes[0].prompt_template.input?.instruction)).toBe("Look at src")
  })

  it("rejects a call that leaves a required input out, without starting from placeholders", async () => {
    const result = await prepare(spec(declarations))
    expect(result.valid).toBe(false)
    expect(result.prepared).toBeUndefined()
    expect(result.errors.map((entry) => entry.code)).toEqual(["template.inputs"])
  })

  it("does not reuse a cached result across different inputs", async () => {
    const document = spec(declarations)
    const first = await prepare(document, values({ objective: "one" }))
    const second = await prepare(document, values({ objective: "two" }))
    const names = [first, second].map((result) =>
      result.prepared?.action === "start" ? String(result.prepared.nodes[0].prompt_template.input?.objective) : "",
    )
    expect(names).toEqual(["Goal: one", "Goal: two"])
    // The same call again is served from the cache and keeps the template note.
    expect((await prepare(document, values({ objective: "one" }))).template).toEqual(first.template)
  })

  it("names the input behind a field that fails to decode", async () => {
    const result = await prepare(
      spec({ objective: {}, acceptance: { type: "array" } }, { acceptance: "{{acceptance}}" }),
      values({ objective: "x", acceptance: [{ id: "AC1" }] }),
    )
    expect(result.valid).toBe(false)
    const leaf = result.errors.find((entry) => entry.path.includes('["acceptance"][0]["text"]'))
    expect(leaf?.hint).toContain('this value comes from input "acceptance"')
  })

  it("rejects a spec whose own graph is invalid even when the inputs are fine", async () => {
    const result = await prepare(
      spec(declarations, { blocks: [{ id: "scan", kind: "explore", depends_on: ["missing"] }] }),
      values({ objective: "x" }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((entry) => entry.message.includes('unknown block "missing"'))).toBe(true)
  })

  it("surfaces the unused-input warning without failing the start", async () => {
    const result = await prepare(spec({ objective: {}, ignored: { default: "x" } }), values({ objective: "x" }))
    expect(result.valid).toBe(true)
    expect(result.warnings.map((entry) => entry.path)).toContain("inputs.ignored")
  })

  it("still validates a start document that declares nothing exactly as before", async () => {
    const result = await prepare({ config: { name: "p", objective: "x", blocks: [{ id: "a", kind: "explore" }] } })
    expect(result.valid).toBe(true)
    expect(result.template).toBeUndefined()
  })

  it("keeps template inputs out of an extend or replan fragment", async () => {
    const extend = await Effect.runPromise(
      authoring.prepare({
        action: "extend",
        source: source({ objective: "x", blocks: [{ id: "a", kind: "explore" }], inputs: { x: {} } }),
      }),
    )
    expect(extend.valid).toBe(false)
  })
})

describe("template directory validation (release and CI gate)", () => {
  const directory = async (files: Record<string, string>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "template-inputs-"))
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content)
    return dir
  }

  const FROM_OBJECTIVE = `inputs:
  objective: {}
  scope: { default: "the repository" }
config:
  name: from-objective
  objective: "Do it. Request: {{objective}}. Scope: {{scope}}"
  blocks:
    - id: scan
      kind: explore
`

  it("accepts a template that starts from objective alone and notes one that declares no inputs", async () => {
    const dir = await directory({
      "from-objective.yaml": FROM_OBJECTIVE,
      "plain.yaml": "config:\n  name: plain\n  objective: x\n  blocks:\n    - id: scan\n      kind: explore\n",
    })
    try {
      const { results } = await validateDagTemplateDirectory(dir)
      const byName = Object.fromEntries(results.map((entry) => [entry.name, entry]))
      expect(byName["from-objective.yaml"].valid).toBe(true)
      expect(byName["from-objective.yaml"].warnings).toEqual([])
      expect(byName["plain.yaml"].valid).toBe(true)
      expect(byName["plain.yaml"].warnings.map((entry) => entry.message)).toEqual([
        "template declares no inputs, so it can only start as written",
      ])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects a template that needs more than objective, or does not declare it", async () => {
    const dir = await directory({
      "needs-more.yaml": FROM_OBJECTIVE.replace('scope: { default: "the repository" }', "scope: {}"),
      "no-objective.yaml": FROM_OBJECTIVE.replace("  objective: {}\n", "").replace("Request: {{objective}}. ", ""),
    })
    try {
      const { results } = await validateDagTemplateDirectory(dir)
      const byName = Object.fromEntries(results.map((entry) => [entry.name, entry]))
      expect(byName["needs-more.yaml"].valid).toBe(false)
      expect(byName["needs-more.yaml"].errors.map((entry) => entry.message)).toEqual([
        'required input "scope" was not supplied',
      ])
      expect(byName["no-objective.yaml"].valid).toBe(false)
      expect(byName["no-objective.yaml"].errors.map((entry) => entry.message)).toEqual([
        'input "objective" is not declared by this spec',
      ])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
