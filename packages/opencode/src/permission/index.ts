import { SessionAttention } from "@/notification/attention"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import * as Option from "effect/Option"
import os from "os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { emptyPolicy, updateSessionPolicy, type SessionPolicy } from "./session-policy"
import type { PermissionUpdate } from "@/hook/trigger-result"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { type TriggerResult } from "@/hook/trigger-result"
import { SettingsHook } from "@/hook/settings"
import { Config } from "@/config/config"
import { PermissionHookCapabilities } from "./hook-capabilities"
import { consumerContext } from "@/hook/consumer-context"
import { HookPermissions } from "@/config/permissions"
import { HookPermissionInterrupt } from "./hook-control"
import { Notification } from "@/notification"
import { PermissionV1Event } from "@opencode-ai/schema/permission-v1"

export const Event = PermissionV1Event

export interface AskOptions {
  /**
   * Always surface the dialog unless a ruleset rule denies. Used for a hook's
   * `permissionDecision:"ask"`: neither ruleset allows nor earlier "always"
   * approvals may skip it, and an "always" reply elsewhere cannot settle it.
   */
  readonly force?: boolean
  /**
   * The user already confirmed this exact tool call in a forced ask: ask-level rules settle as allowed
   * without another dialog or PermissionRequest hook. Deny rules still apply.
   */
  readonly confirmed?: boolean
  /**
   * The tool's own arguments, merged into PermissionRequest/PermissionDenied
   * `tool_input` alongside the legacy permission fields (see hookToolInput).
   */
  readonly toolInput?: Record<string, unknown>
  readonly hookAllowed?: boolean
  readonly toolName?: string
  readonly resolveRuleset?: (
    mode?: "plan",
  ) => Effect.Effect<{ native: PermissionV1.Ruleset; rules: PermissionV1.Ruleset }>
}

export type AskResult = void | { updatedInput: Record<string, unknown> }

export interface Interface {
  readonly ask: (
    input: PermissionV1.AskInput,
    options?: AskOptions,
  ) => Effect.Effect<AskResult, PermissionV1.Error | HookPermissionInterrupt>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly grantHookBypass?: (sessionID: string) => Effect.Effect<void>
  readonly clearHookPolicy: (sessionID: string) => Effect.Effect<void>
  readonly hookPolicy: (sessionID: string) => Effect.Effect<SessionPolicy & { directories: string[] }>
  readonly applyHookUpdates: (
    sessionID: string,
    updates: readonly PermissionUpdate[],
  ) => Effect.Effect<void, PermissionV1.CorrectedError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
  force?: boolean
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: Map<string, PermissionV1.Rule[]>
  policies: Map<string, SessionPolicy>
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

/**
 * Permission hook `tool_input`: the tool's arguments plus the legacy permission
 * fields existing hooks read (`permission`, `patterns`, `metadata`, `always` /
 * `pattern`, `ruleset`). On a key collision the legacy value wins, so hooks
 * written against the legacy shape keep working.
 */
function hookToolInput(args: Record<string, unknown> | undefined, legacy: Record<string, unknown>) {
  return { ...args, ...legacy }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const capabilities = yield* PermissionHookCapabilities.make()
    const events = yield* EventV2Bridge.Service
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const layerNotification = Option.getOrUndefined(yield* Effect.serviceOption(Notification.Service))
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: new Map<string, PermissionV1.Rule[]>(),
          policies: new Map<string, SessionPolicy>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const clearHookPolicy = Effect.fn("Permission.clearHookPolicy")((sessionID: string) =>
      InstanceState.use(state, (current) => {
        current.policies.delete(sessionID)
        current.approved.delete(sessionID)
      }),
    )

    const clearHookPolicyAndCapability = (sessionID: string) =>
      clearHookPolicy(sessionID).pipe(Effect.andThen(capabilities.clear(sessionID)))

    const hookPolicy = Effect.fn("Permission.hookPolicy")(function* (sessionID: string) {
      const stored = (yield* InstanceState.get(state)).policies.get(sessionID)
      const configured = config ? yield* config.get() : undefined
      return {
        rules: stored?.rules ?? [],
        mode: stored?.mode ?? configured?.hookPermissions?.mode,
        directories: stored?.directories ?? configured?.hookPermissions?.directories ?? [],
      }
    })

    const applyHookUpdates = Effect.fn("Permission.applyHookUpdates")(function* (
      sessionID: string,
      updates: readonly PermissionUpdate[],
    ) {
      const current = yield* InstanceState.get(state)
      const ctx = yield* InstanceState.context
      yield* Effect.sync(() => HookPermissions.validateUpdates(updates))
      const beforeConfig = config ? yield* config.get() : undefined
      const stored = current.policies.get(sessionID)
      const previous = stored ?? emptyPolicy()
      const beforeDirectories = stored?.directories ?? beforeConfig?.hookPermissions?.directories ?? []
      const allowBypass = yield* capabilities.has(sessionID)
      const effectiveUpdates = updates.flatMap((entry) =>
        entry.type === "setMode" && entry.mode === "bypassPermissions"
          ? allowBypass
            ? [{ ...entry, destination: "session" as const }]
            : []
          : [entry],
      )
      const sessionUpdates = effectiveUpdates.filter((entry) => entry.destination === "session")
      const next = yield* Effect.sync(() =>
        updateSessionPolicy(
          { ...previous, directories: beforeDirectories },
          sessionUpdates,
          ctx.directory,
          allowBypass,
        ),
      )
      const persistent = effectiveUpdates.filter((entry) => entry.destination !== "session")
      const afterConfig = persistent.length
        ? config
          ? yield* config
              .updateHookPermissions(persistent)
              .pipe(Effect.mapError((error) => new PermissionV1.CorrectedError({ feedback: error.message })))
          : yield* Effect.die(new Error("Permission configuration service unavailable"))
        : beforeConfig
      const changesDirectories = sessionUpdates.some(
        (entry) => entry.type === "addDirectories" || entry.type === "removeDirectories",
      )
      if (!stored?.directories && !changesDirectories) delete next.directories
      if (sessionUpdates.length) current.policies.set(sessionID, next)
      const nextDirectories = next.directories ?? afterConfig?.hookPermissions?.directories ?? []
      for (const directory of nextDirectories.filter((entry) => !beforeDirectories.includes(entry))) {
        if (settingsHook)
          yield* settingsHook
            .trigger(
              { event: "DirectoryAdded", directory, source: "register_repo_root" },
              yield* consumerContext(sessionID, next.mode ?? afterConfig?.hookPermissions?.mode ?? "default").pipe(
                Effect.orDie,
              ),
            )
            .pipe(Effect.asVoid)
      }
    })

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput, options?: AskOptions) {
      const current = yield* InstanceState.get(state)
      const { pending } = current
      let approved = current.approved.get(input.sessionID)
      if (!approved) current.approved.set(input.sessionID, (approved = []))
      const policy = yield* hookPolicy(input.sessionID)
      const { ruleset: originalRuleset, ...request } = input
      const resolved = options?.resolveRuleset
        ? yield* options.resolveRuleset(policy.mode === "plan" ? "plan" : undefined)
        : { native: [], rules: originalRuleset }
      const ruleset = [...resolved.rules, ...policy.rules]
      const force = options?.force === true
      let needsAsk = force
      let explicitAskRequired = false

      for (const pattern of request.patterns) {
        const nativeRule = evaluate(request.permission, pattern, resolved.native)
        const configuredRule = evaluate(request.permission, pattern, ruleset)
        // Denials are checked BEFORE remembered approvals or any hook result.
        const rule =
          nativeRule.action === "deny"
            ? nativeRule
            : configuredRule.action === "deny" || force
              ? configuredRule
              : evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          // PermissionDenied belongs exclusively to an auto-mode classifier; rule denies are not that event.
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        if (!force && policy.mode === "bypassPermissions" && (yield* capabilities.has(request.sessionID))) continue
        const explicitAsk = ruleset.some(
          (entry) =>
            entry.action === "ask" &&
            entry.permission !== "*" &&
            Wildcard.match(request.permission, entry.permission) &&
            Wildcard.match(pattern, entry.pattern),
        )
        explicitAskRequired ||= explicitAsk
        // This guard is reached only AFTER both native and configured deny branches.
        // A hook allow may skip an implicit question, never a rule-level/forced ask.
        if (!force && !explicitAsk && options?.hookAllowed) continue
        if (!force && policy.mode === "acceptEdits" && request.permission === "edit" && !explicitAsk) continue
        if (
          !force &&
          request.permission === "external_directory" &&
          policy.directories.some(
            (directory) => pattern === path.join(directory, "*") || pattern.startsWith(directory + path.sep),
          )
        )
          continue
        needsAsk = true
      }

      if (!needsAsk || (options?.confirmed === true && !force)) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      if (settingsHook) {
        let refreshedBypass = false
        const hookResult = yield* settingsHook
          .trigger(
            {
              event: "PermissionRequest",
              toolName: options?.toolName ?? request.permission,
              toolInput: hookToolInput(options?.toolInput, {
                permission: request.permission,
                patterns: request.patterns,
                metadata: request.metadata,
                always: request.always,
              }),
              toolUseID: request.tool?.callID,
            },
            yield* consumerContext(request.sessionID, policy.mode ?? "default").pipe(Effect.orDie),
          )
          .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult)))
        yield* SettingsHook.landSystemMessages(hookResult, { sessionID: request.sessionID ?? "" })
        if (hookResult.preventContinuation)
          return yield* new HookPermissionInterrupt({ message: hookResult.stopReason ?? "Stopped by permission hook" })
        const decision = hookResult.permissionRequestDecision
        if (decision?.behavior === "deny") {
          if (decision.interrupt)
            return yield* new HookPermissionInterrupt({ message: decision.message ?? "Stopped by permission hook" })
          if (decision.message) return yield* new PermissionV1.CorrectedError({ feedback: decision.message })
          return yield* new PermissionV1.RejectedError({})
        }
        if (decision?.behavior === "allow" && decision.updatedPermissions?.length) {
          yield* applyHookUpdates(request.sessionID, decision.updatedPermissions)
          const refreshedPolicy = yield* hookPolicy(request.sessionID)
          const refreshed = options?.resolveRuleset
            ? yield* options.resolveRuleset(refreshedPolicy.mode === "plan" ? "plan" : undefined)
            : { native: [], rules: originalRuleset }
          const freshRules = [...refreshed.rules, ...refreshedPolicy.rules]
          explicitAskRequired ||= freshRules.some(
            (entry) =>
              entry.action === "ask" &&
              entry.permission !== "*" &&
              Wildcard.match(request.permission, entry.permission) &&
              request.patterns.some((pattern) => Wildcard.match(pattern, entry.pattern)),
          )
          if (
            refreshedPolicy.mode === "dontAsk" &&
            (force ||
              request.patterns.some((pattern) => evaluate(request.permission, pattern, freshRules).action !== "allow"))
          )
            return yield* new PermissionV1.RejectedError({})
          if (
            request.patterns.some(
              (pattern) =>
                evaluate(request.permission, pattern, refreshed.native).action === "deny" ||
                evaluate(request.permission, pattern, freshRules).action === "deny",
            )
          )
            return yield* new PermissionV1.DeniedError({ ruleset: freshRules })
          refreshedBypass =
            !force && refreshedPolicy.mode === "bypassPermissions" && (yield* capabilities.has(request.sessionID))
        }
        if (
          decision?.behavior === "allow" &&
          decision.updatedInput !== undefined &&
          !isDeepStrictEqual(decision.updatedInput, options?.toolInput)
        )
          return { updatedInput: decision.updatedInput }
        if (hookResult.blocked || hookResult.permissionDecision === "deny") {
          const reason = hookResult.blocked?.reason ?? hookResult.stopReason ?? hookResult.permissionDecisionReason
          if (reason) return yield* new PermissionV1.CorrectedError({ feedback: `Permission hook: ${reason}` })
          return yield* new PermissionV1.RejectedError({})
        }
        // A forced ask (PreToolUse hook `ask`) requires the user's confirmation:
        // a PermissionRequest hook may still deny it, but its allow is ignored.
        if (hookResult.permissionDecision === "allow" || decision?.behavior === "allow") {
          if (!force && (refreshedBypass || !explicitAskRequired)) return undefined
          yield* Effect.logInfo("PermissionRequest hook allow ignored for a hook-forced ask", {
            permission: info.permission,
            "session.id": info.sessionID,
          })
        }
      }
      if (policy.mode === "dontAsk") return yield* new PermissionV1.RejectedError({})
      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred, force })
      return yield* Effect.gen(function* () {
        yield* events.publish(Event.Asked, info)
        const notification =
          Option.getOrUndefined(yield* Effect.serviceOption(Notification.Service)) ?? layerNotification
        if (notification) {
          const attention = Option.getOrUndefined(yield* Effect.serviceOption(SessionAttention.Service))
          yield* (attention ? attention.quiet(request.sessionID, 6_000) : Effect.sleep("6 seconds")).pipe(
            Effect.andThen(() =>
              pending.has(id)
                ? notification.notify({
                    message: `Permission requested: ${request.permission}`,
                    notificationType: "permission_prompt",
                    sessionID: request.sessionID,
                  })
                : Effect.void,
            ),
            Effect.ignore,
            Effect.forkScoped,
          )
        }
        return yield* Deferred.await(deferred)
      }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => pending.delete(id))))
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const current = yield* InstanceState.get(state)
      const { pending } = current
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      const approved = current.approved.get(existing.info.sessionID) ?? []
      current.approved.set(existing.info.sessionID, approved)
      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        if (item.force) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({
      ask,
      reply,
      list,
      applyHookUpdates,
      hookPolicy,
      clearHookPolicy: clearHookPolicyAndCapability,
      grantHookBypass: capabilities.grant,
    })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(SettingsHook.defaultLayer),
  Layer.provide(Notification.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, SettingsHook.node, Notification.node, Config.node])

export * as Permission from "."
