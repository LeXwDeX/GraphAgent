import { asSchema, type Tool as AITool } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { McpCatalog } from "@/mcp/catalog"
import { MCP_RESOURCE_DEFINITIONS, MCP_RESOURCE_ORDER, type McpResourceOp } from "@/tool/mcp-resource"
import type { ToolEntry } from "@/tool/registry"
import { ToolJsonSchema } from "@/tool/json-schema"
import type { Tool } from "@/tool/tool"

const emptyObjectSchema: JSONSchema7 = { type: "object", properties: {} }

/**
 * Registry entry for a host-builtin tool in tests that mock `ToolRegistry.Service`.
 * The real registry derives the same shape from `Tool.Def`; tests only need a
 * faithful entry so the execution pipeline can wrap it.
 */
export function builtinEntry(
  definition: Tool.Def,
  registrationID = `test:${definition.id}`,
): Extract<ToolEntry, { source: { kind: "builtin" } }> {
  let jsonSchema = definition.jsonSchema
  if (jsonSchema === undefined) {
    try {
      jsonSchema = ToolJsonSchema.fromSchema(definition.parameters as never)
    } catch {
      jsonSchema = emptyObjectSchema
    }
  }
  return {
    id: definition.id,
    source: { kind: "builtin", registrationID },
    effects: definition.effects ?? "unknown",
    description: definition.description,
    jsonSchema,
    definition,
  }
}

/** Registry entries for MCP server tools; mirrors what `ToolRegistry.resolve` builds. */
export function mcpEntries(items: Record<string, AITool>): Extract<ToolEntry, { source: { kind: "mcp" } }>[] {
  return Object.entries(items)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([id, item]) => {
      const schema = asSchema(item.inputSchema).jsonSchema as JSONSchema7
      const binding = McpCatalog.toolBinding(item)
      const server = binding?.server ?? "fixture"
      const tool = binding?.tool ?? id
      return {
        id,
        source: {
          kind: "mcp" as const,
          server,
          tool,
          source: binding?.source ?? "unknown",
          canonicalName: McpCatalog.canonicalToolName({ server, tool }),
          requiresUserInteraction: binding?.requiresUserInteraction === true,
        },
        effects: "unknown" as const,
        description: item.description ?? "",
        jsonSchema: { ...schema, properties: schema.properties ?? {} },
        tool: item,
      }
    })
}

/** Registry entries for the OpenCode-owned MCP resource helpers, in resolution order. */
export function mcpResourceEntries(
  ops: readonly McpResourceOp[] = MCP_RESOURCE_ORDER,
): Extract<ToolEntry, { source: { kind: "mcp-resource" } }>[] {
  return ops.map((op) => {
    const definition = MCP_RESOURCE_DEFINITIONS[op]
    return {
      id: definition.id,
      source: { kind: "mcp-resource" as const, op, registrationID: `mcp-resource:${definition.id}` },
      effects: "read" as const,
      description: definition.description,
      jsonSchema: definition.jsonSchema,
    }
  })
}
