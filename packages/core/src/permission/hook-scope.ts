export * as PermissionHookScope from "./hook-scope"

import { Context, Effect, Schema } from "effect"
import type { Permission } from "@opencode-ai/schema/permission"

export class Failure extends Schema.TaggedErrorClass<Failure>()("PermissionHookFailure", { message: Schema.String }) {}
export interface Decision {
  behavior?: "allow" | "deny"
  updatedInput?: Record<string, unknown>
  message?: string
  interrupt?: boolean
}
export interface Policy {
  mode?: "default" | "manual" | "acceptEdits" | "dontAsk" | "plan" | "bypassPermissions"
  rules: Permission.Ruleset
}
export interface Hooks {
  policy(): Effect.Effect<Policy, Failure>
  confirm(input: Record<string, unknown>): Effect.Effect<void, Failure>
  request(input: {
    action: string
    resources: readonly string[]
    toolInput: Record<string, unknown>
    metadata?: Record<string, unknown>
  }): Effect.Effect<Decision, Failure>
}
/** One captured invocation. The registry owns no authorization policy. */
export interface State {
  hooks: Hooks
  input: Record<string, unknown>
  preDecision?: "allow" | "ask"
  confirmed: boolean
  pendingInput?: Record<string, unknown>
  stopped?: string
  denied?: boolean
}
export class Service extends Context.Service<Service, State>()("@opencode/PermissionHookScope") {}
