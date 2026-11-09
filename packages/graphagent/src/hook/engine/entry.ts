// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Single hook entry execution against the handler registry.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import os from "os"
import { Effect, Context } from "effect"
import { HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Log from "@/util/log"
import { FSUtil } from "@graphagent/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { claudeToolResponse } from "../tool-output"
import { claudeTools, translateClaudeInput } from "../match"
import { commandText, httpUrl, resolveHookCwd } from "../exec/command"
import { httpHookUrlAllowed } from "../handlers/http"
import { isRecord } from "../types"
import type { HookCommand, HookEffort, HookEnvelope, HookJSONOutput } from "../types"
import type { HookHandler } from "../handlers/shared"
import type { State } from "./state"

const log = Log.create({ service: "hook.settings" })

export function makeEntryRunner(state: InstanceState<State>, handlers: Record<string, HookHandler>) {
  return Effect.gen(function* () {
    const handlerContext = Context.pick(
      MCP.Service,
      Provider.Service,
      Auth.Service,
      FSUtil.Service,
      ChildProcessSpawner,
      HttpClient.HttpClient,
    )(yield* Effect.context())

    /**
     * Execute a single hook entry. Never throws. Returns the parsed JSON
     * output + a synthetic blocking signal for exit-code-2 protocol.
     */
    const runEntry = Effect.fn("SettingsHook.runEntry")(function* (
      entry: HookCommand,
      envelope: HookEnvelope,
      cwd: string,
      inHook: boolean,
      environmentFile?: string,
      environment?: Record<string, string | undefined>,
      canonicalName?: string,
      projectDir?: string,
      effort?: HookEffort,
      toolOutput?: unknown,
    ) {
      using _ = log.time("runEntry", { type: entry.type, command: commandText(entry).slice(0, 80) })
      const resolvedCwd = resolveHookCwd([cwd, projectDir, os.homedir(), os.tmpdir()])
      if (resolvedCwd !== cwd)
        log.warn("hook working directory unavailable; using fallback", { cwd, fallback: resolvedCwd })
      // CLAUDE_PROJECT_DIR names the project root for the whole session, even
      // when the session was opened in (or moved to) a checkout subdirectory.
      // `root` is resolved at instance creation and always exists.
      const hookProjectDir = projectDir ?? resolvedCwd
      if (entry.type === "http") {
        const settings = (yield* InstanceState.get(state)).settings
        if (!httpHookUrlAllowed(httpUrl(entry), settings.allowedHttpHookUrls)) {
          log.warn("http hook destination rejected by allowedHttpHookUrls", { url: httpUrl(entry) })
          return {
            json: undefined as HookJSONOutput | undefined,
            exitBlock: undefined as string | undefined,
            rawStdout: undefined as string | undefined,
            exitCode: undefined as number | null | undefined,
          }
        }
        if (settings.httpHookAllowedEnvVars !== undefined) {
          const allowed = new Set(settings.httpHookAllowedEnvVars)
          entry = { ...entry, allowedEnvVars: (entry.allowedEnvVars ?? []).filter((name) => allowed.has(name)) }
        }
      }
      const handler = handlers[entry.type]
      if (!handler) {
        // Defensive fallback: handlers table is exhaustive over the schema's 5 types
        // (command/mcp_tool/http/prompt/agent). This guards against future schema additions
        // that miss handler registration. Currently dead-code by construction.
        log.warn("hook type not registered (defensive fallback)", { type: entry.type, command: commandText(entry) })
        return {
          json: undefined as HookJSONOutput | undefined,
          exitBlock: `hook type "${entry.type}" not yet implemented` as string | undefined,
          rawStdout: undefined as string | undefined,
          exitCode: undefined as number | null | undefined,
        }
      }
      const nativeName = typeof envelope.tool_name === "string" ? envelope.tool_name : ""
      const claudeName =
        entry.inputFormat === "claude-code"
          ? (canonicalName ?? claudeTools.get(nativeName.toLowerCase())?.name)
          : undefined
      const adapted = claudeName
        ? {
            ...envelope,
            tool_name: claudeName,
            tool_input: isRecord(envelope.tool_input)
              ? translateClaudeInput(nativeName, envelope.tool_input, true)
              : envelope.tool_input,
            ...(envelope.hook_event_name === "PostToolUse"
              ? {
                  tool_response: claudeToolResponse(
                    nativeName,
                    envelope.tool_input,
                    toolOutput,
                    envelope.tool_response,
                  ),
                }
              : {}),
          }
        : envelope
      const result = yield* handler
        .run(entry, adapted, resolvedCwd, inHook, environmentFile, environment, canonicalName, effort, hookProjectDir)
        .pipe(Effect.updateContext((current: Context.Context<never>) => Context.merge(handlerContext, current)))
      const hso = result.json?.hookSpecificOutput
      if (claudeName && envelope.hook_event_name === "PreToolUse" && hso && "updatedInput" in hso && hso.updatedInput)
        hso.updatedInput = translateClaudeInput(nativeName, hso.updatedInput, false)
      if (
        claudeName &&
        envelope.hook_event_name === "PermissionRequest" &&
        hso &&
        "decision" in hso &&
        hso.decision?.updatedInput
      )
        hso.decision.updatedInput = translateClaudeInput(nativeName, hso.decision.updatedInput, false)
      return result
    })
    return runEntry
  })
}
