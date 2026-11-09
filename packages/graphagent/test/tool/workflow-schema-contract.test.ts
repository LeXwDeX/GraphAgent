// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- These wire-shape tests intentionally traverse provider-owned recursive JSON Schema values. */
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProviderTransform } from "../../src/provider/transform"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Parameters } from "../../src/tool/workflow"

const openaiModel = { providerID: "openai", api: { id: "gpt-4.1", npm: "@ai-sdk/openai" } } as never
const azureModel = { providerID: "azure", api: { id: "gpt-4.1", npm: "@ai-sdk/azure" } } as never
const geminiModel = { providerID: "google", api: { id: "gemini-3-pro", npm: "@ai-sdk/google" } } as never
const glmModel = {
  providerID: "local-proxy",
  api: { id: "glm-5.3", npm: "@ai-sdk/openai-compatible" },
} as never

type JsonSchemaNode = {
  type?: string
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  allOf?: JsonSchemaNode[]
  properties?: Record<string, JsonSchemaNode & { enum?: string[] }>
  required?: string[]
}

function rootIsPlainObject(schema: JsonSchemaNode): boolean {
  return (
    schema.type === "object" && schema.anyOf === undefined && schema.oneOf === undefined && schema.allOf === undefined
  )
}

function branches(schema: JsonSchemaNode): JsonSchemaNode[] {
  const nested = schema.properties?.params?.anyOf
  return nested ?? []
}

function branchByAction(schema: JsonSchemaNode, action: string, field: string): JsonSchemaNode[] {
  return branches(schema).filter(
    (branch) => branch.properties?.action?.enum?.includes(action) && field in (branch.properties ?? {}),
  )
}

describe("workflow tool schema contract", () => {
  test("serialized parameters root is a plain object for every provider transport", () => {
    for (const model of [openaiModel, azureModel, geminiModel, glmModel]) {
      const transformed = ProviderTransform.schema(
        model,
        ToolJsonSchema.fromSchema(Parameters as never),
      ) as JsonSchemaNode
      expect(rootIsPlainObject(transformed)).toBe(true)
    }
  })

  test("the union survives intact inside the params property", () => {
    const transformed = ToolJsonSchema.fromSchema(Parameters as never) as JsonSchemaNode
    expect(branches(transformed)).toHaveLength(14)
    expect(transformed.properties?.params).toBeDefined()
    expect(transformed.required).toEqual(["params"])
  })

  test("each action branch keeps its own fields", () => {
    const transformed = ToolJsonSchema.fromSchema(Parameters as never) as JsonSchemaNode
    expect(branchByAction(transformed, "start", "spec_path")).toHaveLength(1)
    expect(branchByAction(transformed, "result", "cursor")).toHaveLength(1)
    const resultBranch = branches(transformed).find((branch) => branch.properties?.action?.enum?.includes("result"))!
    expect(resultBranch.required).toEqual(expect.arrayContaining(["workflow_id", "node_id"]))
  })

  test("decoded shape is { params: { action, ...fields } }", () => {
    const decoded = Schema.decodeUnknownSync(Parameters)({ params: { action: "list" } })
    expect(decoded).toEqual({ params: { action: "list" } })
  })

  test("recovery requires selected nodes and the observed graph revision", () => {
    const params = {
      action: "control",
      operation: "recover",
      workflow_id: "dag_test",
      node_ids: ["C"],
      expected_graph_rev: 3,
    }
    expect(JSON.stringify(Schema.decodeUnknownSync(Parameters)({ params }))).toBe(JSON.stringify({ params }))
    expect(() => Schema.decodeUnknownSync(Parameters)({ params: { ...params, node_ids: [] } })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Parameters)({ params: { ...params, expected_graph_rev: undefined } }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Parameters)({ params: { ...params, expected_graph_rev: 1.5 } })).toThrow()
    for (const model of [openaiModel, azureModel, geminiModel, glmModel]) {
      const schema = ProviderTransform.schema(model, ToolJsonSchema.fromSchema(Parameters as never)) as JsonSchemaNode
      const controls = branchByAction(schema, "control", "node_ids")
      expect(controls).toHaveLength(2)
      expect(controls.map((branch) => branch.properties?.operation.enum)).toEqual(
        expect.arrayContaining([["recover"], ["retarget"]]),
      )
      const recovery = controls.filter((branch) => branch.properties?.operation.enum?.includes("recover"))
      expect(recovery).toHaveLength(1)
      expect(recovery[0].required).toEqual(
        expect.arrayContaining(["operation", "workflow_id", "node_ids", "expected_graph_rev"]),
      )
      expect(recovery[0].properties?.operation.enum).toEqual(["recover"])
    }
  })

  test("root-level action shortcut is rejected — params is the only root field", () => {
    expect(() => Schema.decodeUnknownSync(Parameters)({ action: "list" })).toThrow()
  })
})
