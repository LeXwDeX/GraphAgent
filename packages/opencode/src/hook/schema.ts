import z from "zod"

const PermissionUpdateSchema = z.union([
  z.object({
    type: z.enum(["addRules", "replaceRules", "removeRules"]),
    rules: z.array(z.object({ toolName: z.string(), ruleContent: z.string().optional() })),
    behavior: z.enum(["allow", "deny", "ask"]),
    destination: z.string(),
  }),
  z.object({ type: z.literal("setMode"), mode: z.string(), destination: z.string() }),
  z.object({
    type: z.enum(["addDirectories", "removeDirectories"]),
    directories: z.array(z.string()),
    destination: z.string(),
  }),
])

export const HookCommandSchema = z
  .object({
    type: z.enum(["command", "mcp_tool", "mcp", "http", "prompt", "agent"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    server: z.string().optional(),
    tool: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    url: z.string().optional(),
    prompt: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    timeout: z.number().positive().finite().optional(),
    onFailure: z.enum(["continue", "block"]).optional(),
    continueOnBlock: z.boolean().optional(),
    model: z.string().optional(),
    statusMessage: z.string().optional(),
    once: z.boolean().optional(),
    shell: z.enum(["bash", "powershell"]).optional(),
    inputFormat: z.enum(["opencode", "claude-code"]).optional(),
    if: z.string().optional(),
    async: z.boolean().optional(),
    asyncRewake: z.boolean().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    __sourceDir: z.string().optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.inputFormat !== undefined && entry.type !== "command")
      ctx.addIssue({ code: "custom", message: "inputFormat is only supported for command hooks" })
    if (entry.args !== undefined && entry.type !== "command")
      ctx.addIssue({ code: "custom", message: "args is only supported for command hooks" })
    if (entry.async !== undefined && entry.type !== "command")
      ctx.addIssue({ code: "custom", message: "async is only supported for command hooks" })
    if (entry.asyncRewake !== undefined && entry.type !== "command")
      ctx.addIssue({ code: "custom", message: "asyncRewake is only supported for command hooks" })
    if (entry.onFailure !== undefined && entry.type !== "command" && entry.type !== "http")
      ctx.addIssue({ code: "custom", message: "onFailure is only supported for command and http hooks" })
    if (entry.continueOnBlock !== undefined && entry.type !== "prompt")
      ctx.addIssue({ code: "custom", message: "continueOnBlock is only supported for prompt hooks" })
    if (entry.model !== undefined && entry.type !== "prompt" && entry.type !== "agent")
      ctx.addIssue({ code: "custom", message: "model is only supported for prompt and agent hooks" })
    const value =
      entry.type === "http"
        ? (entry.url ?? entry.command)
        : entry.type === "prompt" || entry.type === "agent"
          ? (entry.prompt ?? entry.command)
          : entry.type === "mcp_tool" && entry.server && entry.tool
            ? `${entry.server}/${entry.tool}`
            : entry.command
    if (!value?.trim())
      ctx.addIssue({ code: "custom", message: `${entry.type} hook requires a nonempty command, url or prompt` })
  })

export const HookSpecificOutputSchema = z.object({
  hookEventName: z.string().optional(),
  permissionDecision: z.enum(["allow", "deny", "ask", "defer"]).optional(),
  permissionDecisionReason: z.string().optional(),
  decision: z
    .object({
      behavior: z.enum(["allow", "deny"]),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      updatedPermissions: z.array(PermissionUpdateSchema).optional(),
      message: z.string().optional(),
      interrupt: z.boolean().optional(),
    })
    .optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  updatedToolOutput: z.unknown().optional(),
  additionalContext: z.string().optional(),
  initialUserMessage: z.string().optional(),
  sessionTitle: z.string().optional(),
  reloadSkills: z.boolean().optional(),
  suppressOriginalPrompt: z.boolean().optional(),
  displayContent: z.string().optional(),
  worktreePath: z.string().optional(),
  retry: z.boolean().optional(),
  updatedMCPToolOutput: z.unknown().optional(),
  action: z.enum(["accept", "decline", "cancel"]).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  watchPaths: z.array(z.string()).optional(),
  displayMessage: z.string().optional(),
  compactSummary: z.string().optional(),
  customSummary: z.string().optional(),
})
export type ParsedHookSpecificOutput = z.infer<typeof HookSpecificOutputSchema>

export const HookOutputSchema = z.object({
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
  terminalSequence: z.string().optional(),
  watchPaths: z.array(z.string()).optional(),
  decision: z.enum(["approve", "block"]).optional(),
  reason: z.string().optional(),
  hookSpecificOutput: HookSpecificOutputSchema.optional(),
})

/** Structured answer returned by Claude-compatible prompt and agent evaluators. */
export const HookEvaluatorOutputSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  impossible: z.boolean().optional(),
})
export type HookEvaluatorOutput = z.infer<typeof HookEvaluatorOutputSchema>
