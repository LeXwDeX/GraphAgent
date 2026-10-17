import z from "zod"
import { CallToolResultSchema } from "@modelcontextprotocol/core"
import { isRecord } from "@/util/record"
import type { TriggerResult } from "./trigger-result"

/** Presence, not truthiness: null and empty MCP output are valid replacements. */
export function toolOutputReplacement(result: TriggerResult, mcp = false) {
  if (Object.hasOwn(result, "updatedToolOutput")) return { present: true, value: result.updatedToolOutput } as const
  if (mcp && Object.hasOwn(result, "updatedMCPToolOutput"))
    return { present: true, value: result.updatedMCPToolOutput } as const
  return { present: false } as const
}

// GraphAgent's built-in output contract, rather than Claude's different Bash/Read shapes.
const builtinOutput = z
  .object({
    title: z.string(),
    output: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    attachments: z
      .array(z.object({ type: z.literal("file"), mime: z.string(), url: z.string() }).passthrough())
      .optional(),
  })
  .passthrough()

export function builtinToolOutput(value: unknown) {
  const result = builtinOutput.safeParse(value)
  return result.success ? result.data : undefined
}

/** MCP output has no tool-specific output schema. Non-content values remain model-visible JSON. */
export function mcpToolOutput(value: unknown) {
  const parsed = CallToolResultSchema.safeParse(value)
  if (parsed.success)
    return { ...parsed.data, metadata: isRecord(parsed.data.metadata) ? parsed.data.metadata : undefined }
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : (JSON.stringify(value) ?? "") }],
    metadata: undefined,
  }
}
