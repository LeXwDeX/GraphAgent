// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ConfigAgentV1 } from "@graphagent/core/v1/config/agent"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import type { DeepMutable } from "@graphagent/core/schema"
import { Permission } from "@/permission"
import { AgentArtifact } from "./artifact"

/**
 * Agent contracts (#1158): the role, visibility and failure semantics an agent
 * declares, and the catalog rules that follow from them. Everything here is a
 * pure function of agents as `Agent.get` / `Agent.list` return them: the
 * declared contract plus the effective permission rules.
 *
 * Permissions are never repeated in a contract. Whether an agent is read-only
 * is derived from its rules by `isWriterAgent`, the one writer definition the
 * DAG's writer catalog (`writer_types`) shares.
 */

/** A contract as written, in configuration or on a built-in agent: every field optional. */
export type Declared = DeepMutable<ConfigAgentV1.Contract>
export type Compose = NonNullable<Declared["compose"]>

/** What the contract machinery reads from an agent. `Agent.Info` satisfies it. */
export interface Subject {
  readonly name: string
  /** Built-in agents, including ones a user configuration overrides. */
  readonly native?: boolean
  /** The effective rules, as `Agent.get` resolves them: the native rules, then the user's. */
  readonly permission: PermissionV1.Ruleset
  /** The built-in rules alone. Present only on an agent `Agent.get` resolved. */
  readonly nativeRules?: PermissionV1.Ruleset
  readonly contract?: Declared
}

/** A contract with every default filled and the write rule applied. */
export interface Effective {
  readonly role: "worker" | "composer"
  /** `public` only while the agent is read-only; a writer is always `private`. */
  readonly visibility: "public" | "private"
  readonly failure: "skip" | "fail"
  /** The artifact the agent produces; `task` says whether a `task` call owes it (on unless the contract opts out). */
  readonly output?: { readonly artifact: string; readonly task: boolean }
  readonly compose?: Compose
}

// `edit`, `write` and `apply_patch` share the `edit` permission key.
const FILE_TOOLS = ["edit", "write", "apply_patch"]

/**
 * Whether an agent can change files: its effective rules leave the file tools
 * enabled. `plan` keeps an allow-list for its own plan file and is a read-only
 * profile, as it is everywhere the DAG reasons about writers.
 *
 * The DAG's writer catalog and the contract's `public` rule both call this
 * function, so they cannot disagree about who writes.
 */
export function isWriterAgent(agent: Pick<Subject, "name" | "permission">): boolean {
  return agent.name !== "plan" && Permission.disabled(FILE_TOOLS, agent.permission).size === 0
}

/**
 * Whether a call to the file tools is actually refused.
 *
 * The rules an agent runs under arrive in two parts: the built-in (native) rules
 * and the configured ones. `Permission.ask` consults the native part first, so a
 * native deny the configuration appends an allow to still denies. Judging from
 * the flattened list alone therefore disagrees with the runtime; an agent that
 * `Agent.get` resolved carries both parts, and both together answer it the way
 * the runtime will.
 */
export function writesFiles(agent: Subject): boolean {
  if (agent.name === "plan") return false
  if (agent.nativeRules === undefined) return isWriterAgent(agent)
  // A rule the user wrote can only close a tool, never open one the built-in
  // rules deny: `Permission.ask` reads the native rules first. So the tools the
  // user's own additions leave open decide, and among those a native deny wins.
  const configured = agent.permission.slice(agent.nativeRules.length)
  return Permission.disabled(FILE_TOOLS, configured).size === 0 && isWriterAgent(agent)
}

/** Whether the agent declares the composer role. Reads the declaration only; no rules are evaluated. */
export function isComposer(agent: Pick<Subject, "contract">): boolean {
  return agent.contract?.role === "composer"
}

// A worker that declares an artifact owes it to `task` callers unless it says `output.task: false`.
const owedToTask = (output: NonNullable<Declared["output"]>) => output.task !== false

/**
 * The artifact a `task` call to the agent owes its caller: the declared
 * `output.artifact`, unless the contract opts out with `output.task: false`
 * (the artifact then serves composed runs only and task calls stay free text).
 * Reads the declaration alone: no rules are evaluated.
 */
export function taskArtifact(agent: Pick<Subject, "contract">): string | undefined {
  const output = agent.contract?.output
  return output !== undefined && owedToTask(output) ? output.artifact : undefined
}

/**
 * Applies `override` on top of `base`, field by field: a field the override
 * does not set is inherited. `output` and `compose` are replaced whole: a
 * `fallback` can never be paired with a `dispatch` list it was not written for,
 * and restating an `output` without `task` drops an opt-out the base declared,
 * so the default (task calls owe the artifact) applies again.
 */
export function merge(base: Declared | undefined, override: Declared | undefined): Declared | undefined {
  if (base === undefined && override === undefined) return undefined
  const merged: Declared = { ...base }
  if (override?.role !== undefined) merged.role = override.role
  if (override?.visibility !== undefined) merged.visibility = override.visibility
  if (override?.output !== undefined) merged.output = override.output
  if (override?.failure !== undefined) merged.failure = override.failure
  if (override?.compose !== undefined) merged.compose = override.compose
  return merged
}

/**
 * The contract an agent actually has: defaults filled (worker, private, a
 * `failure` derived from the write profile: a writer must succeed, a read-only
 * agent may be skipped, and an artifact owed to task calls), and `public`
 * honoured only while the agent is read-only.
 */
export function effective(agent: Subject): Effective {
  const declared = agent.contract
  const writer = writesFiles(agent)
  return {
    role: declared?.role ?? "worker",
    visibility: declared?.visibility === "public" && !writer ? "public" : "private",
    failure: declared?.failure ?? (writer ? "fail" : "skip"),
    ...(declared?.output ? { output: { artifact: declared.output.artifact, task: owedToTask(declared.output) } } : {}),
    ...(declared?.compose ? { compose: declared.compose } : {}),
  }
}

// A native agent is read-only by default, so one that can write now has had its
// rules overridden; say so, since that is what the user needs to look at.
function writerReason(agent: Subject): string {
  return agent.native === true && agent.contract?.visibility === "public"
    ? `agent "${agent.name}" was overridden to allow writing files, so it is no longer a public read-only agent`
    : `agent "${agent.name}" can write files, so it is not a public read-only agent`
}

/** Why a composer cannot expand into `agent`, or undefined when it can: it exists, is a worker, is public and is read-only. */
function whyNotExpandable(name: string, agent: Subject | undefined): string | undefined {
  if (agent === undefined) return `agent "${name}" does not exist`
  if (isComposer(agent)) return `agent "${name}" is a composer, and a composer cannot dispatch another composer`
  if (writesFiles(agent)) return writerReason(agent)
  if (agent.contract?.visibility !== "public") return `agent "${name}" is not public`
  return undefined
}

export type Availability =
  | {
      readonly available: true
      /** The `dispatch` entries that can be expanded now, in declared order. */
      readonly dispatch: readonly string[]
    }
  | {
      readonly available: false
      /** Names the agent and the cause, ready to show in a `compose` validation error. */
      readonly reason: string
    }

/**
 * Whether the composer `name` can be used with this catalog. A composer is
 * unavailable when its `dispatch` list holds no agent that can be expanded, or
 * when its `fallback` cannot be: the effective catalog decides, so an override
 * that lets `explore` write takes it out of every composer's dispatch list.
 */
export function composerAvailability(catalog: readonly Subject[], name: string): Availability {
  const byName = new Map(catalog.map((agent) => [agent.name, agent]))
  const composer = byName.get(name)
  if (composer === undefined) return { available: false, reason: `agent "${name}" does not exist` }
  if (!isComposer(composer)) return { available: false, reason: `agent "${name}" is not a composer` }

  const unavailable = (cause: string): Availability => ({
    available: false,
    reason: `composer "${name}" is unavailable: ${cause}`,
  })
  const compose = composer.contract?.compose
  if (compose === undefined) return unavailable("it declares no compose block")
  if (!compose.dispatch.includes(compose.fallback))
    return unavailable(`fallback "${compose.fallback}" is not listed in dispatch`)

  const usable: string[] = []
  const causes: string[] = []
  for (const entry of new Set(compose.dispatch)) {
    const cause = whyNotExpandable(entry, byName.get(entry))
    if (cause === undefined) usable.push(entry)
    else causes.push(cause)
  }
  if (usable.length === 0) return unavailable(`no agent in dispatch can be expanded (${causes.join("; ")})`)
  if (!usable.includes(compose.fallback)) {
    const cause = whyNotExpandable(compose.fallback, byName.get(compose.fallback))
    return unavailable(`fallback "${compose.fallback}" cannot be expanded (${cause})`)
  }
  return { available: true, dispatch: usable }
}

export type DiagnosticCode = "public_writable" | "composer_unavailable" | "artifact_unknown"

export interface Diagnostic {
  readonly agent: string
  readonly code: DiagnosticCode
  readonly message: string
}

/**
 * The catalog diagnostics: a `public` agent that can write (treated as private),
 * a composer that cannot be used, and an agent that declares an output artifact
 * the artifact catalog does not hold. Ordered by agent so a rebuilt catalog logs
 * the same lines in the same order.
 */
export function diagnose(catalog: readonly Subject[]): Diagnostic[] {
  const found: Diagnostic[] = []
  for (const agent of catalog) {
    if (agent.contract?.visibility === "public" && writesFiles(agent)) {
      found.push({
        agent: agent.name,
        code: "public_writable",
        message:
          agent.native === true
            ? `${writerReason(agent)}; it is treated as private`
            : `agent "${agent.name}" declares visibility "public" but can write files under its effective permission rules; it is treated as private`,
      })
    }
    if (isComposer(agent)) {
      const availability = composerAvailability(catalog, agent.name)
      if (!availability.available)
        found.push({ agent: agent.name, code: "composer_unavailable", message: availability.reason })
    }
    // Whether or not task calls owe it: a composed run reads the same declaration.
    const artifact = agent.contract?.output?.artifact
    if (artifact !== undefined && !AgentArtifact.has(artifact)) {
      found.push({
        agent: agent.name,
        code: "artifact_unknown",
        message: `agent "${agent.name}" declares output artifact "${artifact}", which is not in the artifact catalog (known: ${AgentArtifact.names().join(", ")})`,
      })
    }
  }
  return found.toSorted((a, b) => a.agent.localeCompare(b.agent) || a.code.localeCompare(b.code))
}

export * as AgentContract from "./contract"
