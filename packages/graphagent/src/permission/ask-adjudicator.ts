// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { PermissionV1 } from "@graphagent/core/v1/permission"
import type { SessionID } from "@/session/schema"
import type { ChildOwner } from "@/session/child/types"
import type { ChildPolicy } from "@/session/child/policy"
import { Context, type Effect } from "effect"

/**
 * The automatic adjudication seam for unattended child sessions (Issue #1026,
 * PR4). The shape belongs to E4 (#1031), whose SafetyGuard implements it; this
 * module is the one definition both use.
 *
 * `Permission.ask` calls `decide` only for a child run whose effective ask
 * policy is `auto`, after the deny rules have won and before `needsAsk` is
 * set. Production registers `SafetyGuard` (`permission/safety-guard.ts`); an
 * absent service leaves the ask path unchanged.
 */

/** The owner of the run the asking session belongs to; the same `ChildOwner` used by `ChildRuns`. */
export type OwnerKey = ChildOwner

export interface AskRule {
  /** The rule that matched the pattern in the asking session's ruleset. */
  readonly action: "allow" | "ask"
  /**
   * True when the matching allow is one the user wrote for this permission key
   * with a concrete pattern. Role/default rules and whole-key wildcards (a
   * pattern or permission of `*`, as in `bash: "allow"`) are not explicit.
   */
  readonly explicit: boolean
}

export interface DecideInput {
  readonly request: Pick<PermissionV1.AskInput, "permission" | "patterns" | "metadata">
  /** The single pattern being evaluated. */
  readonly pattern: string
  readonly rule: AskRule
  /**
   * The ask is a `force` ask (a hook `permissionDecision: "ask"` or an MCP tool
   * that requires user interaction): no allow rule can settle it, only a human.
   */
  readonly forced: boolean
  readonly owner: OwnerKey
  readonly rootSessionID: SessionID
  /**
   * The `dag.permission` tier in force for this ask (#1324), read by the
   * caller from the global configuration at ask time. `allow` is the M7
   * decision above; `readonly` additionally denies an ask the rules did not
   * already decide (RO-1). `ask` never reaches here: such a run asks the user.
   */
  readonly mode: ChildPolicy.DagPermission
}

/** `allow` means the pattern needs no question; `deny` becomes a tool error carrying the rule. */
export type Decision = "allow" | { readonly deny: { readonly ruleID: string; readonly reason: string } }

export interface Interface {
  readonly decide: (input: DecideInput) => Effect.Effect<Decision>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/AskAdjudicator") {}

export * as AskAdjudicator from "./ask-adjudicator"
