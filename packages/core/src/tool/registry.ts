export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Option, Predicate, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { PermissionHookScope } from "../permission/hook-scope"
import { canRewritePermission } from "./permission-rewrite"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionConversationHooks } from "../session/conversation-hooks"
import type { SessionToolBatch } from "../session/tool-batch"
import { ContextFoldingToolSourceLedger } from "../session/context-folding/tool-source-ledger"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import {
  contextFolding,
  definition,
  hookFailure,
  permission,
  settle,
  validateName,
  validateInput,
  replaceOutput,
  type AnyTool,
  type RegistrationError,
} from "./tool"
import { Tools } from "./tools"
import { ContextFoldingBuiltins } from "./context-folding-builtins"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
  readonly batch?: SessionToolBatch.Interface
}

type Register = (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>

const registerContextFoldingBuiltin: unique symbol = Symbol("ToolRegistry.registerContextFoldingBuiltin")

export interface Interface {
  readonly materialize: (permissions?: PermissionV2.Ruleset) => Effect.Effect<Materialization>
  /** Ordinary Location registration. It never grants host-builtin provenance. */
  readonly register: Register
  /** Unavailable through the ordinary string-keyed service surface; exposed only through the host-internal layer below. */
  readonly [registerContextFoldingBuiltin]: Register
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly toolInput?: Record<string, unknown>
  readonly stopped?: string
  readonly deferred?: { readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    const sourceLedger = yield* ContextFoldingToolSourceLedger.Service
    type Registration = {
      readonly identity: object
      readonly tool: AnyTool
      readonly sourceKind: "host-builtin" | "custom"
      readonly registrationID: string
    }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const register = (sourceKind: Registration["sourceKind"], operation: string): Register =>
      Effect.fn(operation)(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [
                ...(local.get(name) ?? []),
                {
                  token,
                  registration: {
                    identity: {},
                    tool,
                    sourceKind,
                    registrationID: crypto.randomUUID(),
                  },
                },
              ])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      })

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (
      input: ExecuteInput,
      advertised?: Registration,
      registrationGeneration?: string,
    ) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised.identity)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const originalValidation = yield* validateInput(registration.tool, input.call).pipe(
        Effect.as(undefined),
        Effect.catchTag("LLM.ToolFailure", (error) => Effect.succeed(error)),
      )
      if (originalValidation) return { result: { type: "error" as const, value: originalValidation.message } }
      const hook = Option.getOrUndefined(yield* Effect.serviceOption(SessionConversationHooks.Service))
      const originalInput =
        Predicate.isObject(input.call.input) && !Array.isArray(input.call.input) ? input.call.input : {}
      const before = hook
        ? yield* hook
            .beforeTool({
              sessionID: input.sessionID,
              toolName: input.call.name,
              toolCallID: input.call.id,
              toolInput: originalInput,
              isSingle: input.batch?.isSingle,
            })
            .pipe(Effect.catch((error) => Effect.succeed({ toolInput: originalInput, blocked: error.reason })))
        : { toolInput: originalInput }
      if ("stopped" in before && before.stopped)
        return { result: { type: "text" as const, value: before.stopped }, stopped: before.stopped }
      if ("blocked" in before && before.blocked) return { result: { type: "error" as const, value: before.blocked } }
      if ("deferred" in before && before.deferred)
        return {
          result: { type: "text" as const, value: "" },
          deferred: { id: input.call.id, name: input.call.name, input: originalInput },
        }
      let call = { ...input.call, input: before.toolInput }
      const permissionHooks = "permissionHooks" in before ? before.permissionHooks : undefined
      const permissionState: PermissionHookScope.State | undefined = permissionHooks
        ? {
            hooks: permissionHooks,
            input: before.toolInput,
            confirmed: false,
            preDecision: "permissionDecision" in before ? before.permissionDecision : undefined,
          }
        : undefined
      let executionAttempted = false
      const attempt = (count: number): Effect.Effect<{ output: ToolOutput } | { result: ToolResultValue }> =>
        Effect.gen(function* () {
          const validation = yield* validateInput(registration.tool, call).pipe(
            Effect.as(undefined),
            Effect.catchTag("LLM.ToolFailure", (error) => Effect.succeed(error)),
          )
          if (validation) return { result: { type: "error" as const, value: validation.message } }
          // Unknown tools may not call PermissionV2.assert. Confirm before their
          // first execution; a replacement restarts only this preflight.
          if (
            permissionState &&
            !canRewritePermission(registration.tool) &&
            permissionState.preDecision === "ask" &&
            !permissionState.confirmed
          ) {
            const decision = yield* permissionState.hooks
              .request({ action: permission(registration.tool, call.name), resources: [], toolInput: call.input })
              .pipe(
                Effect.catch((error) =>
                  Effect.succeed<PermissionHookScope.Decision>({ behavior: "deny", message: error.message }),
                ),
              )
            if (decision.behavior === "deny") {
              permissionState.denied = true
              if (decision.interrupt) permissionState.stopped = decision.message ?? "Stopped by permission hook"
              return { result: { type: "error" as const, value: decision.message ?? "Denied by permission hook" } }
            }
            if (decision.updatedInput !== undefined) {
              if (count >= 8)
                return { result: { type: "error" as const, value: "Permission input replacement exceeded limit" } }
              call = { ...call, input: decision.updatedInput }
              permissionState.input = decision.updatedInput
              return yield* attempt(count + 1)
            }
            const confirmation = yield* permissionState.hooks.confirm(call.input).pipe(
              Effect.as(undefined),
              Effect.catch((error) => Effect.succeed(error)),
            )
            if (confirmation) {
              permissionState.denied = true
              return { result: { type: "error" as const, value: confirmation.message } }
            }
            permissionState.confirmed = true
          }
          executionAttempted = true
          const hookInput = "hookInput" in before ? before.hookInput : undefined
          const execution = settle(registration.tool, call, {
            sessionID: input.sessionID,
            agent: input.agent,
            assistantMessageID: input.assistantMessageID,
            toolCallID: input.call.id,
            ...(hookInput ? { hookInput } : {}),
          })
          const pending = yield* (
            permissionState
              ? execution.pipe(Effect.provideService(PermissionHookScope.Service, permissionState))
              : execution
          ).pipe(
            Effect.onInterrupt(() =>
              hook
                ? hook
                    .afterTool({
                      sessionID: input.sessionID,
                      toolName: call.name,
                      toolCallID: call.id,
                      toolInput: call.input,
                      error: "Tool execution interrupted",
                      isInterrupt: true,
                    })
                    .pipe(Effect.interruptible, Effect.timeoutOption("250 millis"), Effect.ignoreCause)
                : Effect.void,
            ),
            Effect.map((output) => ({ output })),
            Effect.catchTag("LLM.ToolFailure", (failure) =>
              Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
            ),
          )
          if (permissionState?.pendingInput !== undefined) {
            if (!canRewritePermission(registration.tool) || count >= 8) {
              permissionState.denied = true
              return {
                result: {
                  type: "error" as const,
                  value: "Permission input replacement cannot safely restart this tool",
                },
              }
            }
            call = { ...call, input: permissionState.pendingInput }
            permissionState.input = permissionState.pendingInput
            permissionState.pendingInput = undefined
            return yield* attempt(count + 1)
          }
          return pending
        })
      const attempted = yield* attempt(0)
      // PreToolUse context stays with a rejected or failed result of the call it governed.
      const pending =
        "result" in attempted && attempted.result.type === "error" && "feedback" in before && before.feedback
          ? { result: { type: "error" as const, value: `${attempted.result.value}\n\n${before.feedback}` } }
          : attempted
      if (permissionState?.stopped)
        return { result: { type: "text" as const, value: permissionState.stopped }, stopped: permissionState.stopped }
      if ((permissionState?.denied || !executionAttempted) && "result" in pending) return pending
      if (permissionState?.denied)
        return { result: { type: "error" as const, value: "Tool continued after permission denial" } }
      // A completed invocation can still be a hook-facing failure: the shell
      // reports a nonzero exit as ordinary output, and the tool declares the
      // failure text. The result itself stays successful for the model.
      const hookError =
        "result" in pending
          ? undefined
          : hook
            ? yield* hookFailure(registration.tool, call, pending.output.structured)
            : undefined
      const after = hook
        ? yield* hook
            .afterTool({
              sessionID: input.sessionID,
              toolName: call.name,
              toolCallID: call.id,
              toolInput: call.input,
              ...("result" in pending
                ? { error: String(pending.result.value) }
                : hookError !== undefined
                  ? { error: hookError }
                  : { output: pending.output.structured }),
            })
            .pipe(Effect.catch((error) => Effect.succeed({ feedback: error.reason })))
        : {}
      const stopped = "stopped" in after && after.stopped ? { stopped: after.stopped } : {}
      if ("result" in pending) {
        const feedback = "feedback" in after ? after.feedback : undefined
        return {
          ...pending,
          ...(feedback ? { result: { type: "error" as const, value: `${pending.result.value}\n\n${feedback}` } } : {}),
          ...stopped,
        }
      }
      let output = pending.output
      if ("hasReplacement" in after && after.hasReplacement)
        output = yield* replaceOutput(registration.tool, call, after.replacement).pipe(
          Effect.catchTag("LLM.ToolFailure", () => Effect.succeed(pending.output)),
        )
      if ("feedback" in before && before.feedback)
        output = ToolOutput.make(output.structured, [...output.content, { type: "text", text: before.feedback }])
      if ("feedback" in after && after.feedback)
        output = ToolOutput.make(output.structured, [...output.content, { type: "text", text: after.feedback }])
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return { result, ...(bounded.outputPaths.length > 0 ? { outputPaths: bounded.outputPaths } : {}), ...stopped }
      const source =
        advertised && registrationGeneration
          ? {
              sourceKind: advertised.sourceKind,
              registrationID: advertised.registrationID,
              registrationGeneration,
              instructions: contextFolding(advertised.tool).instructions,
            }
          : undefined
      if (source)
        yield* sourceLedger.record({
          sessionID: input.sessionID,
          assistantMessageID: input.assistantMessageID,
          callID: input.call.id,
          toolName: input.call.name,
          source,
        })
      return {
        result,
        output: bounded.output,
        ...(bounded.outputPaths.length > 0 ? { outputPaths: bounded.outputPaths } : {}),
        ...(call.input !== originalInput ? { toolInput: call.input } : {}),
        ...stopped,
      }
    })

    return Service.of({
      register: register("custom", "ToolRegistry.register"),
      [registerContextFoldingBuiltin]: register("host-builtin", "ToolRegistry.registerContextFoldingBuiltin"),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = []) {
        const registrations = new Map<string, Registration>(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
        const ordered = [...registrations.entries()]
        const registrationGeneration = yield* sourceLedger.activate(
          ordered.map(([toolName, registration]) => ({
            toolName,
            sourceKind: registration.sourceKind,
            registrationID: registration.registrationID,
            instructions: contextFolding(registration.tool).instructions,
          })),
        )
        return {
          definitions: ordered.map(([name, registration]) => definition(name, registration.tool)),
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration, registrationGeneration)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
    })
  }),
)

const ledgerRegistryLayer = registryLayer.pipe(Layer.provideMerge(ContextFoldingToolSourceLedger.layer))

export const layer = Layer.mergeAll(
  Layer.effect(
    Tools.Service,
    Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
  ),
  Layer.effect(
    ContextFoldingBuiltins.Service,
    Service.use((registry) =>
      Effect.succeed(ContextFoldingBuiltins.Service.of({ register: registry[registerContextFoldingBuiltin] })),
    ),
  ),
).pipe(Layer.provideMerge(ledgerRegistryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const defaultLayer = layer.pipe(
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
)
