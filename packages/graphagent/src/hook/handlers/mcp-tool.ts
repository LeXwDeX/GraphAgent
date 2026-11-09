// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * `type: "mcp_tool"` hook handler.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 */
import { Cause, Effect, Option } from "effect"
import * as Log from "@/util/log"
import { MCP } from "@/mcp"
import { mcpHookOptions } from "@/mcp/elicitation-binding"
import type { HookCommand, HookEnvelope, HookJSONOutput } from "../types"
import { timeoutFor } from "../exec/command"
import { classifyStdout } from "../exec/output"
import { hookFailureText, type HookHandler } from "./shared"

const log = Log.create({ service: "hook.settings" })

function mcpInput(entry: HookCommand, envelope: HookEnvelope): Record<string, unknown> {
  const read = (key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (value, part) =>
          value && typeof value === "object" ? Object.entries(value).find(([key]) => key === part)?.[1] : undefined,
        envelope,
      )
  const substitute = (value: unknown): unknown => {
    if (typeof value === "string")
      return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
        const found = read(key)
        return found === undefined || found === null ? "" : typeof found === "string" ? found : JSON.stringify(found)
      })
    if (Array.isArray(value)) return value.map(substitute)
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, substitute(nested)]))
    return value
  }
  const input = substitute(entry.input ?? {})
  return input && typeof input === "object" && !Array.isArray(input) ? Object.fromEntries(Object.entries(input)) : {}
}

export const mcpToolHandler: HookHandler = {
  type: "mcp_tool",
  run: Effect.fn("SettingsHook.handler.mcpTool")(function* (entry, envelope, _cwd, _inHook) {
    const mcpSvc = Option.getOrUndefined(yield* Effect.serviceOption(MCP.Service))
    if (!mcpSvc || !entry.server || !entry.tool) return { json: undefined, exitCode: 1, exitBlock: undefined }
    const command = `mcp__${entry.server.replaceAll(":", "_")}__${entry.tool}`
    const timeoutMs = timeoutFor(entry, envelope.hook_event_name)
    const exit = yield* invokeMcpHook(
      mcpSvc,
      command,
      mcpInput(entry, envelope),
      typeof envelope.session_id === "string" ? envelope.session_id : undefined,
    ).pipe(Effect.timeout(timeoutMs), Effect.exit)
    if (exit._tag === "Failure") {
      log.warn("mcp_tool hook failed", { command, error: String(exit.cause) })
      return {
        json: undefined,
        exitCode: Cause.isTimeoutError(Option.getOrUndefined(Cause.findErrorOption(exit.cause))) ? null : 1,
        failureMessage: hookFailureText(exit.cause),
        exitBlock: undefined,
      }
    }
    return { ...exit.value, succeeded: exit.value.succeeded ?? true }
  }),
}

// ── MCP hook execution ──────────────────────────────────────────

/**
 * Resolve and invoke an MCP tool registered as a hook. Format follows the
 * Claude Code protocol:
 *   "mcp__<server>__<tool>"
 *
 * The fork's MCP service stores tools under `sanitize(server)_sanitize(tool)`
 * (see src/mcp/index.ts). We strip the leading `mcp__`, split on `__` for the
 * server/tool boundary, sanitize each side and rejoin with a single
 * underscore to look up the tool. This keeps the on-disk hook config in lock
 * step with Claude Code while staying compatible with the fork's internal
 * tool registry naming.
 *
 * Calls MCP.Service.tools() to get the tool registry and invokes the matching
 * tool with the hook envelope as `arguments`. The first text content item is
 * treated as command stdout: JSON supplies control output, while plain text
 * remains available to event-specific consumers. Other content is ignored.
 */
function invokeMcpHook(
  mcpSvc: MCP.Interface,
  command: string,
  input: Record<string, unknown>,
  sessionID?: string,
): Effect.Effect<{ json?: HookJSONOutput; rawStdout?: string; succeeded?: boolean }, unknown> {
  return Effect.gen(function* () {
    if (!command.startsWith("mcp__")) {
      log.warn("mcp hook command must start with mcp__", { command })
      throw new Error(`Invalid MCP hook command: ${command}`)
    }

    const tools = yield* mcpSvc.tools()
    // Convert CC-format "mcp__server__tool" to internal key "server_tool"
    // (sanitized, single underscore separator).
    const sanitizeIdent = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")
    const stripped = command.slice("mcp__".length)
    const sepIdx = stripped.indexOf("__")
    const internalKey =
      sepIdx === -1
        ? sanitizeIdent(stripped)
        : sanitizeIdent(stripped.slice(0, sepIdx)) + "_" + sanitizeIdent(stripped.slice(sepIdx + 2))
    const tool = tools[internalKey] ?? tools[command]
    if (!tool) {
      log.warn("mcp hook tool not found", {
        command,
        internalKey,
        available: Object.keys(tools).length,
      })
      throw new Error(`MCP hook tool not found: ${command}`)
    }

    const execute = tool.execute
    if (!execute) {
      log.warn("mcp hook tool has no execute()", { command })
      throw new Error(`MCP hook tool has no execute(): ${command}`)
    }

    const result = yield* Effect.promise((signal) =>
      Promise.resolve(
        execute(
          input,
          mcpHookOptions(
            {
              toolCallId: `hook-${Date.now()}`,
              messages: [],
              abortSignal: signal,
            },
            sessionID,
          ),
        ),
      ),
    )

    if (!result || typeof result !== "object" || !("content" in result)) return {}
    if ("isError" in result && result.isError === true) {
      log.warn("mcp hook tool returned isError", { command })
      throw new Error(`MCP hook tool returned isError: ${command}`)
    }

    const content = result.content
    if (!Array.isArray(content)) return {}
    const firstText = content.find(
      (item: unknown): item is { type: "text"; text: string } =>
        item !== null &&
        typeof item === "object" &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )?.text
    if (firstText === undefined) return {}

    const outcome = classifyStdout(firstText)
    if (outcome.kind === "invalid") log.warn("mcp hook returned invalid output", { command, error: outcome.message })
    return {
      json: outcome.kind === "json" ? outcome.value : undefined,
      rawStdout: firstText,
      succeeded: outcome.kind !== "invalid",
    }
  })
}
