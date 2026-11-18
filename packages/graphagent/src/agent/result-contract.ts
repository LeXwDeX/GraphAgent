// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { validateAgainstSchema } from "@/dag/runtime/schema-validator"
import { AgentArtifact } from "./artifact"
import { AgentContract, type Subject } from "./contract"

/**
 * The result contract of a worker run through the `task` tool (#1158): an agent
 * that declares `contract.output.artifact` owes its final answer as that
 * artifact, one JSON value, unless it opts out with `output.task: false` (the
 * built-in `explore` does: its task calls stay free text, and the artifact is
 * for composed runs). The contract is the artifact's schema plus three
 * functions: how the worker is told (`prompt`), how the answer is judged
 * (`check`) and how a miss is sent back (`repairPrompt`).
 *
 * It mirrors what a DAG node does with `output_schema`: the schema is appended
 * to the prompt, the final answer is parsed as exactly one JSON value (no
 * fence, no prose) and validated by the same subset validator. A node settles
 * the answer through its capture slot; a task has no node, so the task tool asks
 * these functions instead and owns the correction turn.
 *
 * The built-in `explore` and `general` answer task calls in free text. They are
 * asked for a bounded message rather than an artifact (#1453): a conclusion, its
 * evidence and what is left unresolved (`owesFreeText`, `freeTextPrompt`). That
 * ask is only words after the caller's request; nothing here parses or refuses
 * the answer.
 */

/** The `resultContract` H3 drafted (#1026): the final answer, checked against a schema; plus the artifact's name. */
export interface Contract {
  readonly kind: "final_response"
  /** The artifact type the schema belongs to; named in every message about the contract. */
  readonly artifact: string
  readonly schema: Record<string, unknown>
}

export type Resolution =
  | { readonly kind: "none" }
  | { readonly kind: "contract"; readonly contract: Contract }
  /** The agent declares an artifact the catalog does not hold. */
  | { readonly kind: "unknown"; readonly artifact: string }

/**
 * What `agent` owes a task caller, read from its declared contract: nothing
 * when it declares no artifact or opts out with `output.task: false`.
 */
export function resolve(agent: Pick<Subject, "contract">): Resolution {
  const artifact = AgentContract.taskArtifact(agent)
  if (artifact === undefined) return { kind: "none" }
  const schema = AgentArtifact.schema(artifact)
  if (schema === undefined) return { kind: "unknown", artifact }
  return { kind: "contract", contract: { kind: "final_response", artifact, schema } }
}

/** Why a task cannot start: the agent names an artifact type that does not exist. */
export function unknownMessage(agentName: string, artifact: string): string {
  return `Agent type "${agentName}" declares output artifact "${artifact}", which is not in the artifact catalog (known: ${AgentArtifact.names().join(", ")}). Fix contract.output.artifact in its configuration.`
}

/** The text the task prompt carries after the caller's own request: the schema, and what happens to a miss. */
export function prompt(contract: Contract): string {
  return [
    "",
    "",
    `[OUTPUT CONTRACT] End with exactly one JSON value, a "${contract.artifact}" artifact, matching this schema:`,
    JSON.stringify(contract.schema, null, 2),
    "Use your final assistant answer only: no Markdown fence or surrounding prose. The runtime validates it, and an answer that does not match comes back to you once for correction. Do not ask the user questions from this session; list in not_examined what you did not look at or could not verify.",
  ].join("\n")
}

// The built-in agents whose task calls return free text and owe the caller a bounded one (#1453).
const FREE_TEXT_AGENTS: ReadonlySet<string> = new Set(["explore", "general"])

/**
 * Whether `agent` owes a task caller the free-text return contract: it is the built-in `explore` or `general`
 * (a configuration that overrides one keeps `native`) and owes no artifact to task calls. An agent that owes an
 * artifact is held to that instead; one that is not built in is asked nothing, whatever its name.
 */
export function owesFreeText(agent: Pick<Subject, "name" | "native" | "contract">): boolean {
  return agent.native === true && FREE_TEXT_AGENTS.has(agent.name) && resolve(agent).kind === "none"
}

/**
 * The text the task prompt carries after the caller's own request when the agent owes free text: the final message
 * in three sections, in order.
 */
export function freeTextPrompt(): string {
  const lines = [
    "[RETURN CONTRACT] Your final message is all the caller receives; do not ask the user questions. Write exactly these sections, in order:",
    "Conclusion: the answer, at most 1200 characters.",
    'Evidence: at most 20 lines, each a path:line or a URL, optionally followed by " - " and a one-line note.',
    'Unresolved: what you did not examine or could not verify, or "none".',
  ]
  return ["", "", ...lines].join("\n")
}

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** Whether `text`, a final answer, is exactly one JSON value that satisfies the contract's schema. */
export function check(text: string, contract: Contract): Verdict {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return { ok: false, reason: "the final answer is not one JSON value" }
  }
  const result = validateAgainstSchema(payload, contract.schema)
  return result.ok ? { ok: true } : { ok: false, reason: result.error }
}

/** The turn that sends a miss back: what is wrong, and that the work is not to be redone. */
export function repairPrompt(contract: Contract, reason: string): string {
  return `Your final answer does not satisfy the "${contract.artifact}" artifact contract: ${reason}. Do not redo the work. Resubmit the same result as exactly one JSON value that satisfies the contract, with no Markdown fence and no surrounding prose.`
}

/** The failure of a task whose answer is still not the artifact after its one correction. */
export function failureMessage(contract: Contract, reason: string): string {
  return `Subagent result does not satisfy the "${contract.artifact}" artifact contract after one correction (${reason})`
}

export * as ResultContract from "./result-contract"
