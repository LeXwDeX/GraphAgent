// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { JSONSchema7 } from "@ai-sdk/provider"

/**
 * Model-facing names of the OpenCode-owned MCP resource helpers. They are not
 * server-provided tools: the pipeline builds them from the connected clients'
 * `resources` capability, and the registry lists them in this fixed order.
 */
export const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const

export type McpResourceOp = keyof typeof MCP_RESOURCE_TOOLS

export const MCP_RESOURCE_ORDER: readonly McpResourceOp[] = ["list", "listTemplates", "read"]

type McpResourceDefinition = Readonly<{
  id: string
  description: string
  jsonSchema: JSONSchema7
}>

/** Raw (pre-provider-transform) definitions of the resource helpers. */
export const MCP_RESOURCE_DEFINITIONS: Record<McpResourceOp, McpResourceDefinition> = {
  list: {
    id: MCP_RESOURCE_TOOLS.list,
    description:
      "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
    jsonSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional MCP server name. When omitted, lists resources from every connected server.",
        },
      },
      additionalProperties: false,
    },
  },
  listTemplates: {
    id: MCP_RESOURCE_TOOLS.listTemplates,
    description:
      "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
    jsonSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional MCP server name. When omitted, lists resource templates from every connected server.",
        },
      },
      additionalProperties: false,
    },
  },
  read: {
    id: MCP_RESOURCE_TOOLS.read,
    description:
      "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
    jsonSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "MCP server name exactly as returned by list_mcp_resources.",
        },
        uri: {
          type: "string",
          description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
        },
      },
      required: ["server", "uri"],
      additionalProperties: false,
    },
  },
}
