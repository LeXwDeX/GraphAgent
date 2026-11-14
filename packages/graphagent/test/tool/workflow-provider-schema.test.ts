// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- These wire-shape tests intentionally traverse provider-owned recursive JSON Schema values and pinned JSON evidence. */
import { describe, expect, test } from "bun:test"
import { Parameters } from "../../src/tool/workflow"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { ProviderTransform } from "../../src/provider/transform"
import { CommandPlugin } from "@graphagent/core/plugin/command"

// Wire-shape regression for the file-backed workflow entry: every action keeps
// its discriminator and owned fields, while graph content stays out of the
// provider call and is supplied through spec_path. The schema root is a plain
// object whose single `params` property carries the discriminated union —
// root-level combinators are outside the OpenAI tools contract (DeepSeek
// rejects them explicitly, GLM answers with empty tool arguments).

const openaiModel = { providerID: "openai", api: { id: "gpt-4.1", npm: "@ai-sdk/openai" } } as never
const azureModel = { providerID: "azure", api: { id: "gpt-4.1", npm: "@ai-sdk/azure" } } as never
const geminiModel = { providerID: "google", api: { id: "gemini-3-pro", npm: "@ai-sdk/google" } } as never
const deepseekModel = {
  providerID: "deepseek",
  api: { id: "deepseek-v4-pro", npm: "@ai-sdk/openai-compatible" },
} as never
const glmModel = {
  providerID: "local-proxy",
  api: { id: "glm-5.3", npm: "@ai-sdk/openai-compatible" },
} as never

type JsonSchemaNode = {
  anyOf?: JsonSchemaNode[]
  required?: string[]
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
  enum?: unknown[]
  [key: string]: unknown
}

function root(schema: JsonSchemaNode): JsonSchemaNode {
  expect(schema.type).toBe("object")
  expect(schema.anyOf).toBeUndefined()
  return schema
}

function branches(transformed: JsonSchemaNode): JsonSchemaNode[] {
  const params = root(transformed).properties?.params
  expect(Array.isArray(params?.anyOf)).toBe(true)
  return params?.anyOf ?? []
}

function branchByAction(transformed: JsonSchemaNode, action: string, withField?: string): JsonSchemaNode[] {
  return branches(transformed).filter((branch) => {
    const actionEnum = branch?.properties?.action?.enum
    if (!Array.isArray(actionEnum) || !actionEnum.includes(action)) return false
    return withField === undefined || branch?.properties?.[withField] !== undefined
  })
}

function branchByOperation(transformed: JsonSchemaNode, operation: string): JsonSchemaNode[] {
  return branches(transformed).filter((branch) => {
    const operationEnum = branch?.properties?.operation?.enum
    return Array.isArray(operationEnum) && operationEnum.includes(operation)
  })
}

// Asserts the node carries properties and returns them for traversal.
function record(node: JsonSchemaNode | undefined): Record<string, JsonSchemaNode> {
  expect(node?.properties).toBeDefined()
  return node?.properties ?? {}
}

describe("workflow provider-facing schema", () => {
  test("base wire shape is a plain-object root carrying the 18-branch union in params", async () => {
    const schema = ToolJsonSchema.fromSchema(Parameters as never) as JsonSchemaNode
    expect(schema.type).toBe("object")
    expect(schema.anyOf).toBeUndefined()
    expect(schema.required).toEqual(["params"])
    expect(branches(schema).length).toBe(18)
    const flat = JSON.stringify(schema)
    expect(flat).not.toContain('"session_id"')
    expect(flat).not.toContain('"project_id"')
    expect(flat).not.toContain('"skills"')
  })

  test("serialized tool definition stays well below the pre-convergence baseline", () => {
    const schema = JSON.stringify(ToolJsonSchema.fromSchema(Parameters as never))
    const total = Buffer.byteLength(CommandPlugin.WorkflowContent) + Buffer.byteLength(schema)
    // Baseline before the 4-action convergence was 21,898 B (description +
    // parameters). The compact draft wire schema is the dominant win: it must
    // stay a small fraction of the old inline graph schema.
    expect(total).toBeLessThan(21_898)
    expect(total).toBeLessThan(12_000)
    expect(Buffer.byteLength(schema)).toBeLessThan(9_000)
    const draft = JSON.stringify(branchByOperation(JSON.parse(schema) as JsonSchemaNode, "draft")[0])
    expect(Buffer.byteLength(draft)).toBeLessThan(3_000)
  })

  test("every action group and operation stays representable after OpenAI transformation", () => {
    const transformed = ProviderTransform.schema(
      openaiModel,
      ToolJsonSchema.fromSchema(Parameters as never),
    ) as JsonSchemaNode
    for (const action of ["spec", "run", "inspect", "control"]) {
      expect(branchByAction(transformed, action).length, action).toBeGreaterThan(0)
    }
    for (const operation of [
      "list",
      "read",
      "draft",
      "validate",
      "start",
      "extend",
      "status",
      "result",
      "pause",
      "resume",
      "cancel",
      "complete",
      "step",
      "cancel_node",
      "replan",
      "recover",
      "extend_timeout",
      "retarget",
    ])
      expect(branchByOperation(transformed, operation).length, operation).toBe(1)
    expect(branchByAction(transformed, "guide")).toEqual([])
    // Action fields do not bleed across branches: the status branch carries
    // no spec/cursor fields.
    const status = branchByOperation(transformed, "status")[0]
    expect(status.required).toContain("workflow_id")
    expect(Object.keys(status.properties ?? {})).toEqual(["action", "operation", "workflow_id"])
  })

  test("OpenAI transformation exposes paths without inline graph objects", () => {
    const transformed = ProviderTransform.schema(
      openaiModel,
      ToolJsonSchema.fromSchema(Parameters as never),
    ) as JsonSchemaNode
    for (const operation of ["start", "extend", "validate"]) {
      expect(branchByOperation(transformed, operation), operation).toHaveLength(1)
      expect(branchByOperation(transformed, operation)[0].properties?.["spec_path"]).toBeDefined()
      expect(branchByOperation(transformed, operation)[0].properties?.["spec"]).toBeUndefined()
    }
    expect(branchByOperation(transformed, "replan")[0].properties?.["spec_path"]).toBeDefined()
    expect(branchByOperation(transformed, "replan")[0].properties?.["spec"]).toBeUndefined()
    expect(Object.keys(record(branchByOperation(transformed, "start")[0]))).toEqual([
      "action",
      "operation",
      "spec_path",
    ])
  })

  test("pins the removed Skill-dependent block surface as red evidence", async () => {
    const before = (await Bun.file(
      new URL("./fixtures/workflow-block-skills-pre-internalization.json", import.meta.url),
    ).json()) as { provider_block_item_fields: string[]; compiled_prompt_fragment: string }
    expect(before.provider_block_item_fields).toContain("skills")
    expect(before.compiled_prompt_fragment).toContain("load these relevant skills")

    const schema = JSON.stringify(ToolJsonSchema.fromSchema(Parameters as never))
    expect(schema).not.toContain('"skills"')
  })

  test("Azure transformation keeps the same params-carried union", () => {
    const transformed = ProviderTransform.schema(
      azureModel,
      ToolJsonSchema.fromSchema(Parameters as never),
    ) as JsonSchemaNode
    expect(root(transformed).type).toBe("object")
    expect(branches(transformed).length).toBe(18)
    expect(branchByOperation(transformed, "start")).toHaveLength(1)
    expect(branchByOperation(transformed, "validate")).toHaveLength(1)
  })

  test("Gemini transformation keeps every file-backed branch", () => {
    const transformed = ProviderTransform.schema(
      geminiModel,
      ToolJsonSchema.fromSchema(Parameters as never),
    ) as JsonSchemaNode
    expect(branches(transformed).length).toBe(18)
    expect(branchByOperation(transformed, "start")[0].properties?.["spec_path"]).toBeDefined()
    expect(branchByOperation(transformed, "start")[0].properties?.["spec"]).toBeUndefined()
    const resultBranch = branchByOperation(transformed, "result")[0]
    expect(resultBranch.required).toEqual(expect.arrayContaining(["workflow_id", "node_id"]))
    expect(Object.keys(record(resultBranch))).toEqual(expect.arrayContaining(["cursor", "limit"]))
  })

  test("OpenAI-compatible transports (DeepSeek, GLM relay) see the same plain-object root", () => {
    for (const model of [deepseekModel, glmModel]) {
      const transformed = ProviderTransform.schema(
        model,
        ToolJsonSchema.fromSchema(Parameters as never),
      ) as JsonSchemaNode
      expect(root(transformed).type).toBe("object")
      expect(branches(transformed)).toHaveLength(18)
      expect(branchByOperation(transformed, "start")).toHaveLength(1)
    }
  })
})
