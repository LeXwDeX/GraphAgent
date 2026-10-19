import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { CommandPlugin } from "@opencode-ai/core/plugin/command"
import { WorkflowAuthoring } from "../../src/dag/authoring"
import { DagValidation } from "../../src/dag/validation"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

const node = {
  id: "work",
  name: "work",
  worker_type: "general",
  depends_on: [],
  prompt_template: { inline: "Do the work" },
}

const start = {
  config: {
    name: "one-node",
    nodes: [node],
  },
}

describe("WorkflowAuthoring source-to-graph seam", () => {
  it.effect("maps high-frequency field drift to the field that exists", () =>
    Effect.gen(function* () {
      const authoring = WorkflowAuthoring.make()
      const result = yield* authoring.prepare({
        action: "start",
        source: {
          kind: "yaml",
          source: "drift.yaml",
          content: [
            "config:",
            "  name: drift",
            "  objective: Field drift probe.",
            "  blocks:",
            "    - id: a",
            "      kind: coding",
            "      worker: general",
          ].join("\n"),
        },
        profile: "portable",
      })
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.hint.includes('Did you mean "worker_type"?'))).toBe(true)
    }),
  )

  // issue #425: bare timeout vocabulary at block level must point at the
  // worker_config wrapper instead of the generic fallback.
  it.effect("hints bare block-level timeout fields toward worker_config", () =>
    Effect.gen(function* () {
      const authoring = WorkflowAuthoring.make()
      for (const wrong of ["timeout: 100", "timeout_ms: 100"]) {
        const result = yield* authoring.prepare({
          action: "start",
          source: {
            kind: "yaml",
            source: "drift.yaml",
            content: [
              "config:",
              "  name: drift",
              "  objective: Timeout drift probe.",
              "  blocks:",
              "    - id: a",
              "      kind: coding",
              `      ${wrong}`,
            ].join("\n"),
          },
          profile: "portable",
        })
        expect(result.valid).toBe(false)
        expect(result.errors.some((e) => e.hint.includes('Did you mean "worker_config: { timeout_ms }"?'))).toBe(true)
      }
    }),
  )

  it.effect("keeps block worker_config strict — unknown nested keys stay rejected", () =>
    Effect.gen(function* () {
      const authoring = WorkflowAuthoring.make()
      const result = yield* authoring.prepare({
        action: "start",
        source: {
          kind: "yaml",
          source: "strict.yaml",
          content: [
            "config:",
            "  name: strict",
            "  objective: Strictness probe.",
            "  blocks:",
            "    - id: a",
            "      kind: coding",
            "      worker_config:",
            "        foo: 1",
          ].join("\n"),
        },
        profile: "portable",
      })
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === DagValidation.DIAGNOSTIC_CODES.schemaInvalid)).toBe(true)
    }),
  )

  it.effect("prepares start, extend, and replan through one action-aware interface", () =>
    Effect.gen(function* () {
      const authoring = WorkflowAuthoring.make()
      const inputs = [
        { action: "start" as const, value: start },
        { action: "extend" as const, value: { nodes: [{ ...node, id: "extend" }] } },
        {
          action: "replan" as const,
          value: { fragment: { name: "replacement", nodes: [{ ...node, id: "replacement" }] } },
        },
      ]

      for (const input of inputs) {
        const result = yield* authoring.prepare({
          action: input.action,
          source: { kind: "inline", value: input.value },
          profile: "portable",
        })
        expect(result.valid).toBe(true)
        expect(result.prepared?.action).toBe(input.action)
        expect(result.prepared?.nodes).toHaveLength(1)
        if (input.action === "start") {
          expect(result.prepared).toMatchObject({
            action: "start",
            title: "one-node",
            config: { name: "one-node", mode: "standard", nodes: [{ id: "work" }] },
          })
        }
      }
    }),
  )

  it.effect("treats inline values strictly but adapts legacy model hints only at the YAML boundary", () =>
    Effect.gen(function* () {
      const authoring = WorkflowAuthoring.make()
      const inline = yield* authoring.prepare({
        action: "start",
        source: {
          kind: "inline",
          value: {
            config: {
              name: "inline-model",
              node_defaults: { model: { providerID: "openai", modelID: "gpt-4.1" } },
              nodes: [{ ...node, model: { providerID: "openai", modelID: "gpt-4.1" } }],
            },
          },
        },
        profile: "portable",
      })
      expect(inline.valid).toBe(false)
      expect(inline.errors.map((error) => error.code)).toContain(DagValidation.DIAGNOSTIC_CODES.schemaInvalid)

      const yaml = yield* authoring.prepare({
        action: "start",
        source: {
          kind: "yaml",
          source: "legacy.yaml",
          content: [
            "config:",
            "  name: legacy-model",
            "  node_defaults:",
            "    model: { providerID: openai, modelID: gpt-4.1 }",
            "  nodes:",
            "    - id: work",
            "      name: work",
            "      worker_type: general",
            "      depends_on: []",
            "      model: { providerID: openai, modelID: gpt-4.1 }",
            "      prompt_template: { inline: Do the work }",
          ].join("\n"),
        },
        profile: "portable",
      })
      expect(yaml.valid).toBe(true)
      expect(yaml.warnings.filter((warning) => warning.code === DagValidation.DIAGNOSTIC_CODES.modelLegacyPin)).toEqual(
        [
          expect.objectContaining({ severity: "warning", path: "config.node_defaults.model" }),
          expect.objectContaining({ severity: "warning", path: "config.nodes[work].model" }),
        ],
      )
      expect(yaml.prepared?.nodes[0]?.model).toEqual({ providerID: "openai", modelID: "gpt-4.1" })
      expect(yaml.prepared?.action === "start" ? yaml.prepared.config.node_defaults?.model : undefined).toEqual({
        providerID: "openai",
        modelID: "gpt-4.1",
      })

      const replan = yield* authoring.prepare({
        action: "replan",
        source: {
          kind: "yaml",
          source: "legacy-replan.yaml",
          content: [
            "fragment:",
            "  name: legacy-replan",
            "  node_defaults:",
            "    model: { providerID: openai, modelID: gpt-4.1 }",
            "  nodes:",
            "    - id: work",
            "      name: work",
            "      worker_type: general",
            "      depends_on: []",
            "      prompt_template: { inline: Do the work }",
          ].join("\n"),
        },
        profile: "portable",
      })
      expect(replan.prepared?.nodes[0]?.model).toEqual({ providerID: "openai", modelID: "gpt-4.1" })
      expect(replan.warnings).toContainEqual(
        expect.objectContaining({
          code: DagValidation.DIAGNOSTIC_CODES.modelLegacyPin,
          severity: "warning",
          path: "fragment.node_defaults.model",
        }),
      )

      // Removing the legacy fields restores tier selection without warning;
      // inherited persisted defaults must not be mistaken for newly authored pins.
      for (const action of ["start", "replan"] as const) {
        const graph = { name: "tier-selected", nodes: [node] }
        const clean = yield* authoring.prepare({
          action,
          source: {
            kind: "yaml",
            source: `${action}.yaml`,
            content: JSON.stringify(action === "start" ? { config: graph } : { fragment: graph }),
          },
          node_defaults: { model: { providerID: "openai", modelID: "gpt-4.1" } },
          profile: "portable",
        })
        expect(clean.valid).toBe(true)
        expect(
          clean.warnings.filter((warning) => warning.code === DagValidation.DIAGNOSTIC_CODES.modelLegacyPin),
        ).toEqual([])
      }
    }),
  )

  it.effect("reports malformed YAML as stable diagnostics instead of throwing", () =>
    Effect.gen(function* () {
      const result = yield* WorkflowAuthoring.make().prepare({
        action: "start",
        source: { kind: "yaml", source: "broken.yaml", content: "config: [unclosed" },
        profile: "portable",
      })
      expect(result).toMatchObject({
        source: "broken.yaml",
        profile: "portable",
        valid: false,
        errors: [{ code: DagValidation.DIAGNOSTIC_CODES.schemaInvalid, path: "$" }],
        warnings: [],
      })
      expect(result.prepared).toBeUndefined()
    }),
  )

  it.effect("keeps portable caching but refreshes live environment catalogs", () =>
    Effect.gen(function* () {
      let loads = 0
      const authoring = WorkflowAuthoring.make({
        loadEnvironment: () => {
          loads += 1
          return Effect.succeed({
            worker_types: new Set(loads === 1 ? ["general"] : []),
          })
        },
      })
      const input = {
        action: "start" as const,
        source: { kind: "inline" as const, value: start },
      }
      const portable = yield* authoring.prepare({ ...input, profile: "portable" })
      expect(portable.valid).toBe(true)
      expect(loads).toBe(0)

      const first = yield* authoring.prepare({ ...input, profile: "environment" })
      const second = yield* authoring.prepare({ ...input, profile: "environment" })
      expect(first.valid).toBe(true)
      expect(second.valid).toBe(false)
      expect(second.prepared).toBeUndefined()
      expect(loads).toBe(2)
    }),
  )

  it.effect("fails closed when environment validation has no catalog loader", () =>
    Effect.gen(function* () {
      const result = yield* WorkflowAuthoring.make().prepare({
        action: "start",
        source: { kind: "inline", value: start },
        profile: "environment",
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: DagValidation.DIAGNOSTIC_CODES.environmentUnavailable,
          path: "$environment",
        }),
      )
      expect(result.prepared).toBeUndefined()
    }),
  )

  it.effect("keeps source identity distinct when equal content is cached", () =>
    Effect.gen(function* () {
      const authoring = WorkflowAuthoring.make()
      const content = Bun.YAML.stringify(start)
      const first = yield* authoring.prepare({
        action: "start",
        source: { kind: "yaml", source: "first.yaml", content },
      })
      const second = yield* authoring.prepare({
        action: "start",
        source: { kind: "yaml", source: "second.yaml", content },
      })
      expect(first.source).toBe("first.yaml")
      expect(second.source).toBe("second.yaml")
    }),
  )
})

describe("WorkflowAuthoring action-specific recovery hints (#775)", () => {
  const prepareInline = (action: "extend" | "replan", value: unknown) =>
    WorkflowAuthoring.make().prepare({
      action,
      source: { kind: "inline", value },
      profile: "portable",
    })

  // The exact envelope sentence validation.ts attaches to every extend hint.
  const EXTEND_ENVELOPE = 'or { "nodes": [...] }'

  it.effect("nested fields never receive envelope-level relocation hints", () =>
    Effect.gen(function* () {
      for (const action of ["start", "extend", "replan"] as const) {
        const graph = {
          name: "nested",
          objective: "Inspect nesting",
          blocks: [{ id: "a", kind: "coding", name: "wrong" }],
        }
        const value =
          action === "start"
            ? { config: graph }
            : action === "replan"
              ? { fragment: graph }
              : { objective: graph.objective, blocks: graph.blocks }
        const result = yield* WorkflowAuthoring.make().prepare({
          action,
          source: { kind: "inline", value },
          profile: "portable",
        })
        expect(result.valid).toBe(false)
        const errors = result.errors.filter((error) => error.path.endsWith('["blocks"][0]["name"]'))
        expect(errors.length).toBeGreaterThan(0)
        for (const error of errors) {
          expect(error.hint).toContain('Did you mean "id"?')
          expect(error.hint).not.toContain('"name" belongs')
        }
      }
      const result = yield* prepareInline("extend", { nodes: [{ ...node, name: 42 }] })
      expect(result.valid).toBe(false)
      const error = result.errors.find((error) => error.path.endsWith('["nodes"][0]["name"]'))
      expect(error).toBeDefined()
      expect(error!.hint).not.toContain('"name" belongs')
      expect(error!.hint).not.toContain('Did you mean "blocks')
    }),
  )

  it.effect("an invalid start envelope passed to extend is steered by the extend envelope, not start fields", () =>
    Effect.gen(function* () {
      const result = yield* prepareInline("extend", {
        title: "Implement session recovery",
        config: {
          name: "implement-session-recovery",
          objective: "Implement session recovery with focused tests.",
          blocks: [{ id: "map", kind: "explore" }],
        },
      })
      expect(result.valid).toBe(false)
      expect(result.prepared).toBeUndefined()
      expect(result.errors.length).toBeGreaterThan(0)
      for (const error of result.errors) {
        expect(error.hint).not.toContain('Did you mean "config"')
        expect(error.hint).not.toContain("config.objective")
        expect(error.hint).not.toContain("objective lives inside config")
        expect(error.hint).not.toContain("name+objective+blocks")
        expect(error.hint).toContain(EXTEND_ENVELOPE)
      }
    }),
  )

  it.effect("extraneous graph fields on extend are rejected without recommending name or graph budgets", () =>
    Effect.gen(function* () {
      const result = yield* prepareInline("extend", {
        name: "extend-with-start-fields",
        objective: "Extend the workflow.",
        blocks: [{ id: "extra", kind: "explore" }],
        max_concurrency: 5,
      })
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
      for (const error of result.errors) {
        expect(error.hint).not.toContain('Did you mean "max_concurrency"')
        expect(error.hint).not.toContain("name+objective+blocks")
        expect(error.hint).not.toContain("config.objective")
        expect(error.hint).toContain(EXTEND_ENVELOPE)
      }
    }),
  )

  it.effect("start keeps its config-envelope hints (no regression)", () =>
    Effect.gen(function* () {
      const result = yield* WorkflowAuthoring.make().prepare({
        action: "start",
        source: {
          kind: "inline",
          value: {
            objective: "misplaced",
            config: {
              name: "start-envelope",
              objective: "Objective placement probe.",
              blocks: [{ id: "a", kind: "coding" }],
            },
          },
        },
        profile: "portable",
      })
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.hint.includes("config.objective"))).toBe(true)
      expect(result.errors.some((e) => e.hint.includes("objective lives inside config"))).toBe(true)
    }),
  )

  it.effect("a replan fragment carrying start-only fields points at the fragment envelope", () =>
    Effect.gen(function* () {
      const result = yield* prepareInline("replan", {
        fragment: {
          title: "Replacement wave",
          name: "replan-envelope",
          nodes: [
            {
              id: "work",
              name: "work",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "Do the work" },
            },
          ],
        },
      })
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
      for (const error of result.errors) {
        expect(error.hint).not.toContain('Did you mean "config"')
        expect(error.hint).not.toContain("config.objective")
        expect(error.hint).toContain('"fragment"')
      }
    }),
  )

  it.effect("keeps every block-guide YAML envelope executable, including added extend examples", () =>
    Effect.gen(function* () {
      const guide = CommandPlugin.WorkflowBlocksContent
      const examples = (heading: string) => {
        const section = guide.slice(guide.indexOf(`### ${heading}`))
        const next = section.indexOf("\n### ", 1)
        const scoped = next === -1 ? section : section.slice(0, next)
        const matches = [...scoped.matchAll(/```yaml\n([\s\S]*?)```/g)]
        expect(matches.length).toBeGreaterThan(0)
        return matches.map((match) => match[1] ?? "")
      }
      const authoring = WorkflowAuthoring.make()
      const inputs = [
        { action: "start" as const, contents: examples("Start file") },
        { action: "extend" as const, contents: examples("Extend file") },
        { action: "replan" as const, contents: examples("Replan file") },
      ]

      for (const input of inputs) {
        for (const content of input.contents) {
          const result = yield* authoring.prepare({
            action: input.action,
            source: { kind: "yaml", source: `${input.action}.yaml`, content },
            profile: "portable",
          })
          expect(result.errors).toEqual([])
          expect(result.valid).toBe(true)
          expect(result.prepared?.nodes.length).toBeGreaterThan(0)
        }
      }
    }),
  )
})

describe("WorkflowAuthoring replan envelope (P0-B)", () => {
  const replanPrepare = (content: string[]) =>
    WorkflowAuthoring.make().prepare({
      action: "replan",
      source: { kind: "yaml", source: "replan.yaml", content: content.join("\n") },
      profile: "portable",
    })

  const nodeLines = [
    "  - id: work",
    "    name: work",
    "    worker_type: general",
    "    depends_on: []",
    "    prompt_template: { inline: Do the work }",
  ]

  it.effect("audit #1: a top-level nodes graph reports the missing fragment envelope, not the union error", () =>
    Effect.gen(function* () {
      const result = yield* replanPrepare(["name: rebuild", "nodes:", ...nodeLines])
      expect(result.valid).toBe(false)
      const envelope = result.errors.find((error) =>
        error.message.includes('missing required top-level key "fragment"'),
      )
      expect(envelope).toBeDefined()
      expect(envelope?.code).toBe(DagValidation.DIAGNOSTIC_CODES.replanEnvelopeMissing)
      expect(envelope?.path).toBe("$")
      expect(envelope?.hint).toContain('Move "nodes" under "fragment".')
      expect(result.errors.some((error) => error.hint.includes("blocks graphs need name+objective+blocks"))).toBe(false)
    }),
  )

  it.effect('audit #2: a top-level config (start envelope) is told replan requires "fragment"', () =>
    Effect.gen(function* () {
      const result = yield* replanPrepare([
        "config:",
        "  name: rebuild",
        "  nodes:",
        ...nodeLines.map((line) => `  ${line}`),
      ])
      expect(result.valid).toBe(false)
      const envelope = result.errors.find((error) =>
        error.message.includes('missing required top-level key "fragment"'),
      )
      expect(envelope?.hint).toContain('"config" is the start envelope; replan requires "fragment".')
    }),
  )

  it.effect("a top-level blocks graph is told to move name/objective/blocks under fragment", () =>
    Effect.gen(function* () {
      const result = yield* replanPrepare([
        "name: rebuild",
        "objective: Rebuild the thing.",
        "blocks:",
        "  - id: a",
        "    kind: coding",
      ])
      expect(result.valid).toBe(false)
      const envelope = result.errors.find((error) =>
        error.message.includes('missing required top-level key "fragment"'),
      )
      expect(envelope?.hint).toContain('Move "name", "objective", and "blocks" under "fragment".')
    }),
  )

  it.effect("a correct fragment envelope is unaffected (no false positive)", () =>
    Effect.gen(function* () {
      const result = yield* replanPrepare(["fragment:", "  name: rebuild", "  nodes:", ...nodeLines])
      expect(result.errors).toEqual([])
      expect(result.valid).toBe(true)
      expect(result.prepared?.nodes).toHaveLength(1)
    }),
  )
})

describe("WorkflowAuthoring replan start-only capture fields", () => {
  const replanPrepare = (content: string[]) =>
    WorkflowAuthoring.make().prepare({
      action: "replan",
      source: { kind: "yaml", source: "replan.yaml", content: content.join("\n") },
      profile: "portable",
    })

  const nodeLines = [
    "  - id: work",
    "    name: work",
    "    worker_type: general",
    "    depends_on: []",
    "    prompt_template: { inline: Do the work }",
  ]

  it.effect("rejects a nodes replan fragment that specifies delivery_node with a field-specific diagnostic", () =>
    Effect.gen(function* () {
      const result = yield* replanPrepare([
        "fragment:",
        "  name: rebuild",
        "  delivery_node: work",
        "  nodes:",
        ...nodeLines,
      ])
      expect(result.valid).toBe(false)
      expect(result.prepared).toBeUndefined()
      const error = result.errors.find((diagnostic) => diagnostic.path === "fragment.delivery_node")
      expect(error).toBeDefined()
      expect(error?.code).toBe(DagValidation.DIAGNOSTIC_CODES.schemaInvalid)
      expect(error?.message).toContain("delivery_node only applies to start")
      expect(error?.hint).toContain('Remove "delivery_node" from the fragment.')
    }),
  )

  it.effect("rejects a blocks replan fragment that specifies delivery_node", () =>
    Effect.gen(function* () {
      const result = yield* replanPrepare([
        "fragment:",
        "  name: rebuild",
        "  objective: Rebuild the thing.",
        "  delivery_node: diagnose",
        "  blocks:",
        "    - id: diagnose",
        "      kind: debug",
        "      instruction: Reproduce the failure.",
      ])
      expect(result.valid).toBe(false)
      const error = result.errors.find((diagnostic) => diagnostic.path === "fragment.delivery_node")
      expect(error).toBeDefined()
      expect(error?.code).toBe(DagValidation.DIAGNOSTIC_CODES.schemaInvalid)
    }),
  )

  it.effect("rejects result_protocol on replans", () =>
    Effect.gen(function* () {
      const result = yield* replanPrepare([
        "fragment:",
        "  name: rebuild",
        "  result_protocol: final_response",
        "  nodes:",
        ...nodeLines,
      ])
      expect(result.valid).toBe(false)
      const error = result.errors.find((diagnostic) => diagnostic.path === "fragment.result_protocol")
      expect(error).toBeDefined()
      expect(error?.code).toBe(DagValidation.DIAGNOSTIC_CODES.schemaInvalid)
    }),
  )

  it.effect("accepts the same config for start", () =>
    Effect.gen(function* () {
      const result = yield* WorkflowAuthoring.make().prepare({
        action: "start",
        source: {
          kind: "yaml",
          source: "start.yaml",
          content: [
            "config:",
            "  name: capture",
            "  delivery_node: work",
            "  result_protocol: final_response",
            "  nodes:",
            ...nodeLines,
          ].join("\n"),
        },
        profile: "portable",
      })
      expect(result.errors).toEqual([])
      expect(result.valid).toBe(true)
      expect(result.prepared?.action).toBe("start")
    }),
  )

  it.effect("keeps ordinary replans and historical config fields working", () =>
    Effect.gen(function* () {
      const result = yield* replanPrepare([
        "fragment:",
        "  name: rebuild",
        "  max_total_nodes: 40",
        "  node_defaults:",
        "    required: true",
        "  nodes:",
        ...nodeLines,
      ])
      expect(result.errors).toEqual([])
      expect(result.valid).toBe(true)
      expect(result.prepared?.nodes).toHaveLength(1)
    }),
  )
})
