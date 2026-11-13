import { SessionAttention } from "@/notification/attention"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ConfigPermissionV1 } from "@graphagent/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@graphagent/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import * as Option from "effect/Option"
import os from "os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { emptyPolicy, updateSessionPolicy, type SessionPolicy } from "./session-policy"
import type { PermissionUpdate } from "@/hook/trigger-result"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Database } from "@graphagent/core/database/database"
import { ChildPolicy } from "@/session/child/policy"
import { AskAdjudicator } from "./ask-adjudicator"
import { EventV2Bridge } from "@/event-v2-bridge"
import { type TriggerResult } from "@/hook/trigger-result"
import { SettingsHook } from "@/hook"
import { Config } from "@/config/config"
import { PermissionHookCapabilities } from "./hook-capabilities"
import { consumerContext } from "@/hook/consumer-context"
import { HookPermissions } from "@/config/permissions"
import { HookPermissionInterrupt } from "./hook-control"
import { Notification } from "@/notification"
import { PermissionV1Event } from "@graphagent/schema/permission-v1"

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
   * The tool's own arguments, merged into the PermissionRequest
   * `tool_input` alongside the legacy permission fields (see hookToolInput).
   */
  readonly toolInput?: Record<string, unknown>
  readonly hookAllowed?: boolean
  readonly toolName?: string
  /** Official `mcp__server__tool` name from the real MCP binding; never derived from `toolName`. */
  readonly canonicalToolName?: string
  /** Real MCP server of the tool that is asking. */
  readonly mcpServer?: { name: string; source: string }
  readonly resolveRuleset?: (
    mode?: "plan",
  ) => Effect.Effect<{ native: PermissionV1.Ruleset; rules: PermissionV1.Ruleset }>
  /** Agent role receiving this call, used to name role-based denials. */
  readonly role?: string
  /** Internal: role-default rules inside the child session permission. */
  readonly roleDefaultIndices?: readonly number[]
  /** Internal: session rules appended after the resolved agent rules. */
  readonly sessionRuleCount?: number
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

function matchingRuleIndex(permission: string, pattern: string, ruleset: PermissionV1.Ruleset) {
  for (let index = ruleset.length - 1; index >= 0; index--) {
    const rule = ruleset[index]
    if (rule && Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) return index
  }
  return -1
}

function roleDenialReason(input: {
  role?: string
  permission: string
  patterns: readonly string[]
  native: PermissionV1.Ruleset
  ruleset: PermissionV1.Ruleset
  resolvedRuleCount: number
  roleDefaultIndices: readonly number[]
  sessionRuleCount: number
}) {
  if (!input.role) return undefined
  if (input.patterns.some((pattern) => evaluate(input.permission, pattern, input.native).action === "deny"))
    return `This tool is not available to the ${input.role} agent.`

  // Session defaults are not marked on the public rule. Only a winning rule
  // inside the located default indices is a role default; an inherited parent
  // or hook rule that wins keeps user wording.
  const roleStart = Math.max(0, input.resolvedRuleCount - input.sessionRuleCount)
  if (
    input.patterns.some((pattern) => {
      const index = matchingRuleIndex(input.permission, pattern, input.ruleset)
      return input.roleDefaultIndices.includes(index - roleStart)
    })
  )
    return `This tool is not available to the ${input.role} agent.`
  return undefined
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

export class Service extends Context.Service<Service, Interface>()("@graphagent/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const capabilities = yield* PermissionHookCapabilities.make()
    const events = yield* EventV2Bridge.Service
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    // The unattended-ask seam (Issue #1026, PR4). Absent until E4 registers its
    // SafetyGuard: the ask path then behaves exactly as before.
    const adjudicator = Option.getOrUndefined(yield* Effect.serviceOption(AskAdjudicator.Service))
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
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
      // A forced ask still needs a dialog unless the unattended adjudicator
      // settles every pattern (`allow`); `forced` is cleared per pattern by
      // such a decision, and only then becomes `needsAsk`.
      let forced = force
      let needsAsk = false
      let explicitAskRequired = false
      // Read once per ask, and only when an adjudicator exists: the run policy
      // of the asking child session (a task's root dag mode may have changed).
      const subject = adjudicator ? yield* ChildPolicy.askOf(database?.db)(request.sessionID) : Option.none()

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
          const reason = roleDenialReason({
            role: options?.role,
            permission: request.permission,
            patterns: [pattern],
            native: resolved.native,
            ruleset,
            resolvedRuleCount: resolved.rules.length,
            roleDefaultIndices: options?.roleDefaultIndices ?? [],
            sessionRuleCount: options?.sessionRuleCount ?? 0,
          })
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
            ...(reason ? { reason } : {}),
          })
        }
        // A run whose policy is `auto` never reaches the user (Issue #1026,
        // PR4 seam; E4 supplies the decision). Deny rules above always win;
        // `explicit` tells the adjudicator whether the matching allow is the
        // user's own, not a role/default rule. Without a registered service
        // nothing happens here.
        if (adjudicator && Option.isSome(subject) && subject.value.ask === "auto") {
          const index = matchingRuleIndex(request.permission, pattern, ruleset)
          const roleStart = Math.max(0, resolved.rules.length - (options?.sessionRuleCount ?? 0))
          const explicit = rule.action === "allow" && !(options?.roleDefaultIndices ?? []).includes(index - roleStart)
          const decision = yield* adjudicator.decide({
            request: { permission: request.permission, patterns: request.patterns, metadata: request.metadata },
            pattern,
            rule: { action: rule.action === "allow" ? "allow" : "ask", explicit },
            owner: subject.value.owner,
            rootSessionID: subject.value.rootSessionID,
          })
          if (decision === "allow") {
            // The adjudicator settled this pattern; a forced ask no longer
            // needs its dialog for it.
            forced = false
            continue
          }
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((entry) => Wildcard.match(request.permission, entry.permission)),
            reason: `dag_safety:${decision.deny.ruleID}: ${decision.deny.reason}`,
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
      if (forced) needsAsk = true

      if (!needsAsk || (options?.confirmed === true && !forced)) return

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
              // Only what this dialog already offers as "always allow", expressed as a session rule update.
              ...(request.always.length
                ? {
                    permissionSuggestions: [
                      {
                        type: "addRules" as const,
                        rules: request.always.map((ruleContent) => ({
                          toolName: options?.canonicalToolName ?? request.permission,
                          ruleContent,
                        })),
                        behavior: "allow" as const,
                        destination: "session",
                      },
                    ],
                  }
                : {}),
            },
            {
              ...(yield* consumerContext(request.sessionID, policy.mode ?? "default").pipe(Effect.orDie)),
              ...(options?.canonicalToolName ? { canonicalToolName: options.canonicalToolName } : {}),
              ...(options?.mcpServer ? { mcpServer: options.mcpServer } : {}),
            },
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
          ) {
            const reason = roleDenialReason({
              role: options?.role,
              permission: request.permission,
              patterns: request.patterns,
              native: refreshed.native,
              ruleset: freshRules,
              resolvedRuleCount: refreshed.rules.length,
              roleDefaultIndices: options?.roleDefaultIndices ?? [],
              sessionRuleCount: options?.sessionRuleCount ?? 0,
            })
            return yield* new PermissionV1.DeniedError({
              ruleset: freshRules,
              ...(reason ? { reason } : {}),
            })
          }
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

const EDIT_TOOLS = ["edit", "write", "apply_patch"]
const READ_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]

function permissionName(tool: string) {
  return EDIT_TOOLS.includes(tool) ? "edit" : READ_TOOLS.includes(tool) ? "read" : tool
}

type GlobToken = "star" | "any" | "optional" | { readonly literal: string }

function globTokens(pattern: string): GlobToken[] {
  const normalized = pattern.replaceAll("\\", "/")
  // Wildcard.match turns a trailing " *" into "( .*)?", so it also matches
  // the string without that suffix. Model the same optional tail here.
  const optionalTail = normalized.endsWith(" *")
  const source = optionalTail ? normalized.slice(0, -2) : normalized
  const tokens: GlobToken[] = []
  // Wildcard.match has no `u` flag: `?` matches one UTF-16 code unit, and an
  // astral code point is two units. Indexing keeps the same tokenization.
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    tokens.push(char === "*" ? "star" : char === "?" ? "any" : { literal: char })
  }
  return optionalTail ? [...tokens, "optional"] : tokens
}

export interface GlobCoversOptions {
  /** Match Wildcard.match on Windows (`i`) or POSIX (no `i`). */
  readonly caseInsensitive?: boolean
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Proves that every path matching `allow` also matches `deny`. The check is
 * intentionally one-sided: unknown or overlapping glob shapes return false so
 * advertisement never hides a tool that may still have an allowed path.
 *
 * Case-insensitive literal comparisons use the JS regex `i` flag directly.
 * The cache is scoped to this call so user-controlled patterns never grow
 * module-global state.
 */
export function globCovers(deny: string, allow: string, options: GlobCoversOptions = {}) {
  const caseInsensitive = options.caseInsensitive ?? process.platform === "win32"
  const literalCache = new Map<string, boolean>()
  const literalEqual = (left: string, right: string) => {
    if (!caseInsensitive) return left === right
    if (left === right) return true
    const key = `${left}\0${right}`
    const cached = literalCache.get(key)
    if (cached !== undefined) return cached
    const result =
      new RegExp(`^(?:${escapeRegExp(left)})$`, "i").test(right) &&
      new RegExp(`^(?:${escapeRegExp(right)})$`, "i").test(left)
    literalCache.set(key, result)
    return result
  }
  const d = globTokens(deny)
  const a = globTokens(allow)
  const memo = new Map<string, boolean>()
  const visit = (di: number, ai: number): boolean => {
    const key = `${di}:${ai}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    let result: boolean
    if (di === d.length) {
      result = ai === a.length
    } else {
      const token = d[di]
      if (token === "star") {
        // `*` is any string, including the empty string.
        result = visit(di + 1, ai) || (ai < a.length && visit(di, ai + 1))
      } else if (token === "optional") {
        // The optional tail matches empty, or a space followed by anything.
        // An allow with the same optional tail is covered as well.
        result =
          visit(di + 1, ai) ||
          (ai < a.length && (a[ai] === "optional" || (typeof a[ai] === "object" && literalEqual(a[ai].literal, " "))))
      } else if (ai === a.length) {
        result = false
      } else {
        const other = a[ai]
        if (token === "any") result = other !== "star" && other !== "optional" && visit(di + 1, ai + 1)
        else result = typeof other === "object" && literalEqual(other.literal, token.literal) && visit(di + 1, ai + 1)
      }
    }
    memo.set(key, result)
    return result
  }
  return visit(0, 0)
}

/**
 * A later allow can still match some call pattern unless every matching deny
 * after it covers the whole allow pattern. Denies that cannot be proven to
 * cover the allow pattern stay cautious.
 */
function hasPotentialAllow(
  permission: string,
  ruleset: PermissionV1.Ruleset,
  denyIndex: number,
  caseInsensitive: boolean,
) {
  return ruleset.some((rule, index) => {
    if (index <= denyIndex || rule.action !== "allow") return false
    if (!Wildcard.match(permission, rule.permission)) return false
    return !ruleset.some((later, laterIndex) => {
      if (laterIndex <= index || later.action !== "deny") return false
      if (!Wildcard.match(permission, later.permission)) return false
      return globCovers(later.pattern, rule.pattern, { caseInsensitive })
    })
  })
}

/**
 * True only when a wildcard deny stays final for this permission. Pattern
 * scoped denies keep the tool advertised because another call pattern may pass.
 */
function universallyDenied(permission: string, ruleset: PermissionV1.Ruleset, caseInsensitive: boolean) {
  const denyIndex = ruleset.findLastIndex(
    (rule) => rule.action === "deny" && rule.pattern === "*" && Wildcard.match(permission, rule.permission),
  )
  if (denyIndex === -1) return false
  return !hasPotentialAllow(permission, ruleset, denyIndex, caseInsensitive)
}

function deniedTools(tools: string[], rulesets: PermissionV1.Ruleset[], options: GlobCoversOptions = {}) {
  const caseInsensitive = options.caseInsensitive ?? process.platform === "win32"
  return new Set(
    tools.filter((tool) => {
      const permission = permissionName(tool)
      return rulesets.some((ruleset) => universallyDenied(permission, ruleset, caseInsensitive))
    }),
  )
}

/**
 * Native rules are checked before configured rules by `Permission.ask`, so a
 * native deny cannot be overridden by a later user allow. Advertisement must
 * apply the same split; flattening both rulesets would expose tools that the
 * execution path always denies.
 */
export function disabledByPolicy(
  tools: string[],
  native: PermissionV1.Ruleset,
  configured: PermissionV1.Ruleset,
  options?: GlobCoversOptions,
): Set<string> {
  return deniedTools(tools, [native, configured], options)
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset, options?: GlobCoversOptions): Set<string> {
  return deniedTools(tools, [ruleset], options)
}

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(SettingsHook.defaultLayer),
  Layer.provide(Notification.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, SettingsHook.node, Notification.node, Config.node])

export * as Permission from "."
