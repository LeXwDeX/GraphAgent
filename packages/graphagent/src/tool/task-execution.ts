// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ConfigExecutionV1 } from "@graphagent/core/v1/config/execution"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { Permission } from "@/permission"
import { isRecord } from "@/util/record"

/**
 * Code-level execution mode of a task call (#1357, Appendix A of #1057): foreground (the caller waits) or
 * background (the run is detached and its result comes back as a later message).
 *
 * The prompt criteria in the task tool description (F-1 to F-4, B-1 to B-4; `packages/graphagent/CONTEXT.md`) stay
 * what guides the model's own `background` argument. This module decides what the runtime does with a call, in one
 * place and in one order:
 *
 *   1. hard constraint: an interactive agent (F-1) or one that rewrites the shared context (F-2) refuses an
 *      explicit `background: true`, and no declaration can send it to the background;
 *   2. the call's own `background` argument;
 *   3. the declaration of the command that drives the call (`execution`; only a user-issued command run has one);
 *   4. the declaration of the agent the call runs (`execution`);
 *   5. the foreground.
 *
 * A declaration of `auto` says nothing, so it is skipped like an absent one.
 *
 * The decision is made once, when the call starts, and is recorded in the call's metadata (`record`). Anything that
 * needs the mode of a call that already started reads that record (`recorded`) and never resolves again: the
 * catalog it would resolve against may have changed since.
 */

/** What an agent or command declares: `auto` and an absent declaration both leave the choice to the layers below. */
export type Declared = ConfigExecutionV1.Mode
export type Mode = "foreground" | "background"

/**
 * Which layer settled the mode. `constraint` means a declaration asked for the background and a hard constraint
 * turned it down; when a constraint changed nothing, the layer that spoke is reported. `running` is for a call that
 * only appended input to a task already running in the background: it has no run of its own to decide for, so the
 * resolver never reports it; the task tool does.
 */
const SOURCES = ["constraint", "param", "command", "agent", "default", "running"] as const
export type Source = (typeof SOURCES)[number]
const isSource = (value: unknown): value is Source => SOURCES.some((source) => source === value)

export interface Decision {
  readonly mode: Mode
  readonly source: Source
}

/** What the resolver reads from an agent. `Agent.Info` satisfies it. */
export interface Subject {
  readonly name: string
  /** The effective rules, as `Agent.get` resolves them. */
  readonly permission: PermissionV1.Ruleset
  readonly execution?: Declared
}

/** A hard constraint: the foreground criterion it comes from (F-1, F-2) and why it keeps an agent out of the background. */
export interface Constraint {
  readonly id: "F-1" | "F-2"
  readonly reason: string
}

// The tools through which an agent reaches the user: a question, or handing the plan back for confirmation.
const USER_TOOLS = ["question", "plan_exit"] as const

// Built-in agents that rewrite the context the main agent works from. title and summary are one-shot internal
// generators, not delegation targets, and rewrite nothing the main agent reads.
const SHARED_STATE_AGENTS: ReadonlySet<string> = new Set(["compaction"])

const F1: Constraint = {
  id: "F-1",
  reason: "it works with the user directly, since its rules allow question or plan_exit",
}

const F2: Constraint = {
  id: "F-2",
  reason: "it rewrites the conversation the main agent works from, so it has to finish in step with the turn",
}

// Whether the agent's own rules, and not a blanket `*` rule, are what allows the tool: naming `question` or
// `plan_exit` is how an agent profile opts in to working with the user.
function allowsByName(agent: Pick<Subject, "permission">, tool: string) {
  const rule = Permission.evaluate(tool, "*", agent.permission)
  return rule.action === "allow" && rule.permission === tool
}

/**
 * The hard constraint that covers an agent, if one does.
 *
 * F-1 follows the effective rules, not a name: an agent that names `question` or `plan_exit` and is allowed them
 * is an interactive profile (the built-in `build` and `plan`, or any agent a user opts in), so a rule written later
 * changes the answer. A blanket `"*": "allow"` is not an opt-in. Child sessions never own the human dialog
 * (`ROOT_ONLY_TOOLS`), so F-1 marks what the agent is for; it does not guard against a child asking the user.
 * F-2 is a short list of built-in names, since nothing in an agent's rules says it rewrites shared state.
 */
export function constraintOf(agent: Pick<Subject, "name" | "permission">): Constraint | undefined {
  if (USER_TOOLS.some((tool) => allowsByName(agent, tool))) return F1
  if (SHARED_STATE_AGENTS.has(agent.name)) return F2
  return undefined
}

export type Resolution =
  | ({ readonly type: "resolved" } & Decision)
  | { readonly type: "refused"; readonly constraint: Constraint; readonly message: string }

export interface Input {
  readonly agent: Subject
  /** The call's own `background` argument, when it passed one. */
  readonly param?: boolean
  /** What the command that drives the call declares; none for a call the model made. */
  readonly command?: Declared
}

// The first layer below the constraints that names a mode.
function choose(input: Input): Decision {
  if (input.param !== undefined) return { mode: input.param ? "background" : "foreground", source: "param" }
  if (input.command === "foreground" || input.command === "background")
    return { mode: input.command, source: "command" }
  const declared = input.agent.execution
  if (declared === "foreground" || declared === "background") return { mode: declared, source: "agent" }
  return { mode: "foreground", source: "default" }
}

function refusal(agent: string, constraint: Constraint) {
  return `The "${agent}" agent cannot run in the background (${constraint.id}: ${constraint.reason}). Run it in the foreground instead: leave out the background argument or pass background=false.`
}

/** Decides how a call runs, or refuses it. Pure: the same input always gives the same answer. */
export function resolve(input: Input): Resolution {
  const constraint = constraintOf(input.agent)
  const chosen = choose(input)
  if (constraint === undefined) return { type: "resolved", ...chosen }
  // The caller asked for it by name; saying no is better than quietly doing something else.
  if (input.param === true) return { type: "refused", constraint, message: refusal(input.agent.name, constraint) }
  // A declaration asked for the background and the constraint outranks it.
  if (chosen.mode === "background") return { type: "resolved", mode: "foreground", source: "constraint" }
  return { type: "resolved", ...chosen }
}

/** The fields of a call's metadata that hold its decision. */
export function record(decision: Decision) {
  return { execution: decision.mode, executionSource: decision.source }
}

/** Reads a recorded decision back from a call's metadata (its part, or the job it started); none when there is no complete one. */
export function recorded(metadata: unknown): Decision | undefined {
  if (!isRecord(metadata)) return undefined
  const { execution, executionSource } = metadata
  if (execution !== "foreground" && execution !== "background") return undefined
  return isSource(executionSource) ? { mode: execution, source: executionSource } : undefined
}

export * as TaskExecution from "./task-execution"
