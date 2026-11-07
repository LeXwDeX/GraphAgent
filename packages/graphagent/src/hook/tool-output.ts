import z from "zod"
import { parsePatch } from "diff"
import { CallToolResultSchema } from "@modelcontextprotocol/core"
import { isRecord } from "@/util/record"
import { patchFilePaths } from "./file-changes"
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

/** Opt-in hook wire adapter; native metadata and model-visible output stay unchanged. */
export function claudeToolResponse(tool: string, args: unknown, output: unknown, fallback: unknown): unknown {
  const result = builtinToolOutput(output)
  const input = isRecord(args) ? args : {}
  if (!result) return claudeCoreToolResponse(tool, input, output, fallback)
  const metadata = result.metadata
  const filediff = isRecord(metadata.filediff) ? metadata.filediff : {}
  const display = isRecord(metadata.display) ? metadata.display : {}
  const first = Array.isArray(metadata.files) && isRecord(metadata.files[0]) ? metadata.files[0] : {}
  const filePath =
    metadata.filepath ??
    metadata.filePath ??
    filediff.file ??
    display.path ??
    first.filePath ??
    input.filePath ??
    input.file_path ??
    patchFilePaths(input.patchText ?? input.patch)[0]
  switch (tool.toLowerCase()) {
    case "bash":
      // The builtin combines stdout and stderr; expose that capture as stdout.
      return { stdout: result.output, stderr: "", interrupted: false }
    case "read":
      return { file: { filePath, content: typeof display.text === "string" ? display.text : result.output } }
    case "write":
    case "edit":
    case "apply_patch":
    case "multiedit":
    case "patch":
      return { filePath, structuredPatch: patchHunks(metadata.diff ?? filediff.patch), success: true }
    default:
      return fallback
  }
}

function patchHunks(diff: unknown) {
  if (typeof diff !== "string") return []
  try {
    return parsePatch(diff).flatMap((file) => file.hunks)
  } catch {
    return []
  }
}

/** Core leaves return domain output directly, without the V1 title/output/metadata wrapper. */
function claudeCoreToolResponse(tool: string, input: Record<string, unknown>, output: unknown, fallback: unknown) {
  if (!isRecord(output)) return fallback
  switch (tool.toLowerCase()) {
    case "bash":
      if (typeof output.command !== "string" || typeof output.cwd !== "string" || typeof output.output !== "string")
        return fallback
      // Core retains a combined capture too; splitting on stderr markers could corrupt command output.
      return { stdout: output.output, stderr: "", interrupted: output.timedOut === true }
    case "read":
      if (
        typeof output.content !== "string" ||
        (output.type !== "text-page" && output.encoding !== "utf8" && output.encoding !== "base64")
      )
        return fallback
      return { file: { filePath: input.path ?? input.filePath ?? input.file_path, content: output.content } }
    case "write":
    case "edit":
      if (output.operation !== "write" || typeof output.target !== "string") return fallback
      // These leaves do not retain a unified diff; never manufacture patch positions.
      return { filePath: output.target, structuredPatch: [], success: true }
    case "apply_patch": {
      if (
        !Array.isArray(output.applied) ||
        !isRecord(output.applied[0]) ||
        typeof output.applied[0].target !== "string"
      )
        return fallback
      return { filePath: output.applied[0].target, structuredPatch: [], success: true }
    }
    default:
      return fallback
  }
}
