// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Composer expansion, the part that is known before a workflow runs (#1158).
 *
 * A composer is an agent that plans instead of working (D4): its structured
 * output is a plan, and the engine, not the agent, turns the plan into read-only
 * worker nodes inside the current DAG. This module owns what can be decided
 * without running anything:
 *
 * - the limits (`dag.compose.*`, read from the user's global config only),
 * - the composer catalog, derived from the effective agent catalog,
 * - the plan schema of one composer, a pure function the runtime reuses to check
 *   a plan again when it expands it (the catalog may have changed since),
 * - the split and join prompts,
 * - the compile step: a composer node becomes a split node `<id>--split` (the
 *   composer, asked for the plan) and an expansion slot `<id>` that carries the
 *   `expand` marker and is already the definition of the join node that replaces it.
 *
 * Expanding a stored plan is here too, as pure functions (`planExpansion`,
 * `degrade`): the plan's children, the join node that replaces the slot, and the
 * degraded path when a plan cannot be expanded. So is the join node's admission
 * check (`checkJoin`): whether the children left it anything to join. The
 * scheduler's admission seam, next to the `fan_out` expansion of ADR-0004
 * (`DagComposeExpansion`), reads the stored state, calls them and writes the
 * result, with `Dag.extend` for an expansion and a node failure for a refused
 * join. Nested expansion, cancellation and budget are still to come (#1158
 * PR3b-2); until they land the submission gate below keeps such a graph from
 * being submitted.
 */

import { AgentArtifact } from "@/agent/artifact"
import { AgentContract } from "@/agent/contract"
import { isRecord } from "@/util/record"
import type { DagConfig } from "./config"
import type { NodeConfig } from "./dag"
import { validateAgainstSchema } from "./runtime/schema-validator"

// ============================================================================
// Limits
// ============================================================================

export interface Limits {
  /** Most items one plan may hold. */
  readonly maxChildren: number
  /** Deepest nesting; a top-level compose block is depth 1. */
  readonly maxDepth: number
  /** Most nodes one top-level compose block may expand into, nested expansions included. */
  readonly maxSubtreeNodes: number
}

/** What `dag.compose` means when the user sets nothing. The accepted ranges (2-12, 1-3, 10-80) live in the config schema. */
export const DEFAULT_LIMITS: Limits = { maxChildren: 6, maxDepth: 2, maxSubtreeNodes: 40 }

/**
 * The effective limits. They come from the user's global `dag` section only
 * (`Config.dagGlobal`): the config loader strips `dag.compose` from project
 * files, so a shared project cannot widen what its workflows may spend. Do not
 * read them from `DagSection`, which merges project values.
 */
export function limits(dag: Pick<DagConfig.Dag, "compose"> | undefined): Limits {
  const compose = dag?.compose
  return {
    maxChildren: compose?.max_children ?? DEFAULT_LIMITS.maxChildren,
    maxDepth: compose?.max_depth ?? DEFAULT_LIMITS.maxDepth,
    maxSubtreeNodes: compose?.max_subtree_nodes ?? DEFAULT_LIMITS.maxSubtreeNodes,
  }
}

// ============================================================================
// Composer catalog
// ============================================================================

/** An agent a plan may name. */
export interface Worker {
  readonly name: string
  readonly description?: string
  /** The artifact its contract declares as output. */
  readonly artifact?: string
  /** `fail`: its work is required; `skip`: the plan can go on without it. */
  readonly failure: "skip" | "fail"
}

export interface Composer {
  readonly name: string
  readonly pattern: "fan_out" | "recursive_split"
  /** The agents a plan may name, in the order the contract lists them: only those that exist now, are public and are read-only. */
  readonly dispatch: readonly Worker[]
  /** The worker that takes the whole task when a plan cannot be expanded. */
  readonly fallback: string
  /** The artifact the join node produces, when the composer declares one. */
  readonly artifact?: string
}

export type Resolution =
  { readonly available: true; readonly composer: Composer } | { readonly available: false; readonly reason: string }

/** The effective agent catalog, reduced to what composing needs. */
export interface Catalog {
  /** Every agent name. */
  readonly agents: ReadonlySet<string>
  /** Every agent that declares the composer role, usable or not. */
  readonly composers: ReadonlyMap<string, Resolution>
}

/** An agent as `Agent.list` returns it. */
export type CatalogAgent = AgentContract.Subject & { readonly description?: string }

/** The composer catalog of the effective agents. A composer is usable when `AgentContract.composerAvailability` says so. */
export function catalogFrom(agents: readonly CatalogAgent[]): Catalog {
  const byName = new Map(agents.map((agent) => [agent.name, agent]))
  const composers = new Map<string, Resolution>()
  for (const agent of agents) {
    if (!AgentContract.isComposer(agent)) continue
    const availability = AgentContract.composerAvailability(agents, agent.name)
    const declared = agent.contract?.compose
    if (!availability.available || declared === undefined) {
      composers.set(agent.name, {
        available: false,
        reason: availability.available ? `composer "${agent.name}" declares no compose block` : availability.reason,
      })
      continue
    }
    const dispatch = availability.dispatch.flatMap((name) => {
      const worker = byName.get(name)
      return worker === undefined ? [] : [workerOf(worker)]
    })
    const artifact = AgentContract.effective(agent).output?.artifact
    composers.set(agent.name, {
      available: true,
      composer: {
        name: agent.name,
        pattern: declared.pattern,
        dispatch,
        fallback: declared.fallback,
        ...(artifact !== undefined ? { artifact } : {}),
      },
    })
  }
  return { agents: new Set(byName.keys()), composers }
}

function workerOf(agent: CatalogAgent): Worker {
  const contract = AgentContract.effective(agent)
  return {
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    ...(contract.output ? { artifact: contract.output.artifact } : {}),
    failure: contract.failure,
  }
}

/** Whether `name` is an agent that declares the composer role, usable or not. */
export function isComposer(catalog: Catalog | undefined, name: string): boolean {
  return catalog?.composers.has(name) === true
}

/** The composer `name` in this catalog, or why it cannot be used: the reason names the agent and the cause. */
export function resolve(catalog: Catalog, name: string): Resolution {
  const composer = catalog.composers.get(name)
  if (composer !== undefined) return composer
  return {
    available: false,
    reason: catalog.agents.has(name) ? `agent "${name}" is not a composer` : `agent "${name}" does not exist`,
  }
}

// ============================================================================
// The plan: schema and check
// ============================================================================

export interface PlanItem {
  readonly id: string
  readonly agent: string
  readonly instruction: string
  readonly scope?: readonly string[]
  readonly required?: boolean
  readonly split?: boolean
}

export interface Plan {
  readonly rationale: string
  readonly items: readonly PlanItem[]
  readonly not_planned: readonly string[]
}

/** An item id becomes part of a node id (`<slot>--<id>`), the way a fan-out package id does. */
const ITEM_ID = "^[A-Za-z0-9][A-Za-z0-9_-]*$"

const agentNote = (worker: Worker) =>
  `${worker.name} (${worker.artifact ?? "free text"}, ${worker.failure === "fail" ? "required" : "may be skipped"})`

/**
 * The JSON schema of a plan from this composer: the `output_schema` of its split
 * node, and what the runtime checks a plan against again before it expands it.
 * Pure, and written with the keywords the DAG's subset validator enforces.
 *
 * - `agent` is an enum of the composer's dispatchable agents, so a private,
 *   unknown or writable agent is a schema violation the composer is shown and can repair.
 * - `items` holds at most `limits.maxChildren`.
 * - `split` exists only for a `recursive_split` composer.
 * - `required` may be left out: `itemRequired` then takes the agent's contract.
 *
 * The subset validator has no conditional keyword, so one rule cannot be stated
 * here: an item that names an agent whose failure is `fail` may not set
 * `required: false`. `checkPlan` enforces it, and is the re-validation to call.
 */
export function planSchema(composer: Composer, limits: Limits): Record<string, unknown> {
  const recursive = composer.pattern === "recursive_split"
  const failing = composer.dispatch.filter((worker) => worker.failure === "fail").map((worker) => worker.name)
  return {
    type: "object",
    description: "How to expand this task into workers: why, which workers, and what is left out",
    required: ["rationale", "items", "not_planned"],
    additionalProperties: false,
    properties: {
      rationale: { type: "string", minLength: 1, description: "Why the work is divided this way" },
      items: {
        type: "array",
        maxItems: limits.maxChildren,
        description: `One worker per item, at most ${limits.maxChildren}; each runs read-only, in parallel with the others`,
        items: {
          type: "object",
          required: ["id", "agent", "instruction"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: ITEM_ID,
              description: "A short name, unique in the plan: letters, numbers, hyphens and underscores",
            },
            agent: {
              type: "string",
              enum: composer.dispatch.map((worker) => worker.name),
              description: `The worker that takes the item: ${composer.dispatch.map(agentNote).join("; ")}`,
            },
            instruction: {
              type: "string",
              minLength: 1,
              description: "What the worker must do, self-contained: it sees nothing of this plan or the other items",
            },
            scope: {
              type: "array",
              items: { type: "string" },
              description: "The directories, files or topics the item covers, so items do not overlap",
            },
            required: {
              type: "boolean",
              description:
                "true when the conclusion cannot stand without this item. Leave it out to take the agent's default" +
                (failing.length > 0
                  ? `; ${failing.join(", ")} always count as required and cannot be set to false`
                  : ""),
            },
            ...(recursive
              ? {
                  split: {
                    type: "boolean",
                    description:
                      "true when the item is still too large for one worker: it is planned again, one level deeper",
                  },
                }
              : {}),
          },
        },
      },
      not_planned: {
        type: "array",
        items: { type: "string" },
        description: "What the plan deliberately leaves out, each with the reason; empty only when nothing is left out",
      },
    },
  }
}

/**
 * Whether an item's work is required, meaning the conclusion cannot stand
 * without it. An item that names a `fail` agent always is, whatever it says. For
 * any other agent the plan's own `required` decides, and an item that leaves it
 * out is not.
 */
export function itemRequired(item: Pick<PlanItem, "agent" | "required">, composer: Composer): boolean {
  const worker = composer.dispatch.find((candidate) => candidate.name === item.agent)
  if (worker?.failure === "fail") return true
  return item.required ?? false
}

export type PlanCheck = { readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly error: string }

/**
 * Checks a split node's output against this composer's current plan schema and
 * the rules the schema cannot state: no item names a `fail` agent and sets
 * `required: false`, and no two items produce the same node id (an item's own id,
 * or `<id>--split` for one that splits). The output may be the JSON text the node
 * stored. The error reads well enough to show to the composer or to log.
 */
export function checkPlan(output: unknown, composer: Composer, limits: Limits): PlanCheck {
  const value = typeof output === "string" ? parseJson(output) : output
  if (value === undefined) return { ok: false, error: "the plan is not one JSON value" }
  const shape = validateAgainstSchema(value, planSchema(composer, limits))
  if (!shape.ok) return { ok: false, error: shape.error }
  const plan = readPlan(value)
  if (plan === undefined) return { ok: false, error: "the plan does not have the plan shape" }
  const problems = planProblems(plan, composer)
  return problems.length > 0 ? { ok: false, error: problems.join("; ") } : { ok: true, plan }
}

function planProblems(plan: Plan, composer: Composer): string[] {
  const problems: string[] = []
  const producedBy = new Map<string, string>()
  for (const item of plan.items) {
    const worker = composer.dispatch.find((candidate) => candidate.name === item.agent)
    if (worker?.failure === "fail" && item.required === false)
      problems.push(
        `item "${item.id}" names "${item.agent}", whose work is required (failure: fail); it cannot be marked required: false`,
      )
    for (const id of item.split === true ? [item.id, `${item.id}--split`] : [item.id]) {
      const owner = producedBy.get(id)
      if (owner === undefined) producedBy.set(id, item.id)
      else if (owner === item.id) problems.push(`item id "${id}" is used twice`)
      else problems.push(`item "${item.id}" produces the node id "${id}", which item "${owner}" already produces`)
    }
  }
  return problems
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The plan as a typed value. The schema check already ran, so this only narrows. */
function readPlan(value: unknown): Plan | undefined {
  if (!isRecord(value) || typeof value.rationale !== "string" || !Array.isArray(value.items)) return undefined
  const items: PlanItem[] = []
  for (const entry of value.items) {
    if (!isRecord(entry)) return undefined
    const { id, agent, instruction, scope, required, split } = entry
    if (typeof id !== "string" || typeof agent !== "string" || typeof instruction !== "string") return undefined
    items.push({
      id,
      agent,
      instruction,
      ...(Array.isArray(scope) ? { scope: scope.filter((part) => typeof part === "string") } : {}),
      ...(typeof required === "boolean" ? { required } : {}),
      ...(typeof split === "boolean" ? { split } : {}),
    })
  }
  const notPlanned = Array.isArray(value.not_planned)
    ? value.not_planned.filter((part) => typeof part === "string")
    : []
  return { rationale: value.rationale, items, not_planned: notPlanned }
}

// ============================================================================
// Prompts
// ============================================================================

/** Where in the expansion a plan is made: the part of the split prompt only the runtime knows for a nested plan. */
export interface Position {
  /** 1 for a top-level compose block. */
  readonly depth: number
  /** Nodes the subtree may still add, nested expansions and joins included. */
  readonly remainingNodes: number
}

/** The position of the plan a compose block asks for when it is compiled: the top level, with the whole quota left. */
export function topPosition(limits: Limits): Position {
  return { depth: 1, remainingNodes: limits.maxSubtreeNodes }
}

// An agent description is user-controlled text that ends up in a prompt template: braces would read as placeholders.
const oneLine = (text: string) => text.replace(/[{}]/g, "").replace(/\s+/g, " ").trim()

/** What the split node is asked: the plan, the agents it may use and the room it has. */
export function splitContract(composer: Composer, limits: Limits, position: Position): string {
  const agents = composer.dispatch.map((worker) => {
    const produces = worker.artifact ? `produces ${worker.artifact}` : "answers in free text"
    const failure = worker.failure === "fail" ? "its work is required" : "the plan can go on without it"
    const about = worker.description ? `. ${oneLine(worker.description)}` : ""
    return `- ${worker.name}: ${produces}; ${failure}${about}`
  })
  const rules = [
    "Planning rules:",
    "- Divide by what has to be found out, not by size alone. Give each item an id (letters, numbers, hyphens, underscores), an instruction a worker can follow without seeing this task or the other items, and a scope.",
    `- At most ${limits.maxChildren} items. Overlapping items waste work; a gap hides a question, so name every gap in not_planned with the reason.`,
    "- required: set true on an item whose absence would make the conclusion unsound. Leave it out to take the agent's default; an agent whose work is required always counts as required.",
    ...(composer.pattern === "recursive_split"
      ? [
          "- split: set true on an item that is still too large for one worker; it is then planned again, one level deeper. Use it only while the depth below allows.",
        ]
      : []),
    `- Depth ${position.depth} of ${limits.maxDepth}. The whole expansion may add at most ${position.remainingNodes} more nodes (every item, nested plan and join counts); an item the room cannot cover runs as a plain worker instead.`,
  ]
  return [
    "You plan how this task is expanded; you do not do the work. Return one JSON plan with rationale, items and not_planned. The engine runs each item as its own read-only worker, in parallel, and then joins their results. You cannot dispatch workers, edit files or ask the user questions from this child session.",
    `Agents an item may name:\n${agents.join("\n")}`,
    rules.join("\n"),
  ].join("\n\n")
}

/** How the join prompt opens: also what `taskPrompt` cuts at to get the task back. */
const JOIN_OPENING = "You join the results of an expansion."

/** What the join node is asked: merge the results, and say what is missing. */
export function joinContract(composer: Composer): string {
  return [
    `${JOIN_OPENING} The input holds the plan and, for each item, its status and the artifact it produced or the reason it did not. Combine them into one decision-ready result: compare the items, settle conflicts by evidence strength, and keep material uncertainty.`,
    "Every item that failed, was skipped or produced nothing goes into not_examined with its reason, together with what the plan left out: a missing result is never covered work. Do not invent results the input does not hold.",
    composer.artifact !== undefined
      ? `Return the ${composer.artifact} artifact. Do not ask the user questions from this child session.`
      : "Do not ask the user questions from this child session.",
  ].join("\n\n")
}

// ============================================================================
// Compile: a composer node becomes a split node and an expansion slot
// ============================================================================

/** A reason a composer node cannot be submitted, written for a validation diagnostic. */
export interface Problem {
  /** The node or block id. */
  readonly node: string
  readonly path: string
  readonly message: string
  readonly hint: string
}

export interface Compiled {
  readonly nodes: NodeConfig[]
  readonly problems: Problem[]
}

/** The id of the split node that plans the expansion of the slot `slotID`. */
export function splitID(slotID: string): string {
  return `${slotID}--split`
}

/**
 * The first input alias of the slot `slotID` that falls in the namespace its
 * expansion writes into: the split node, every child and the fallback are
 * `<slotID>--…`, and the join node reads each of them under its own id. An authored
 * alias there would be overwritten by the expansion's binding, and the split and the
 * join would read the same name as different inputs.
 */
export function reservedAlias(slotID: string, mapping: NodeConfig["input_mapping"]): string | undefined {
  return Object.keys(mapping ?? {}).find((alias) => alias.startsWith(`${slotID}--`))
}

/**
 * A node that expands: a compose block's node, or a hand-written node whose worker
 * is a composer. A block of another kind that names a composer as its worker
 * override is not one: that is an ordinary worker choice, and `compose` is the block
 * that plans.
 */
function composerNode(node: NodeConfig, catalog: Catalog): boolean {
  if (node.expand !== undefined || node.generated_helper === "split") return false
  // A replan fragment names a live node to restart or cancel; that is not the node's definition.
  if (node.restart === true || node.cancel === true) return false
  return node.block === "compose" || (node.block === undefined && isComposer(catalog, node.worker_type))
}

/**
 * Compiles every composer node of an already block-compiled or hand-written graph
 * into its split node and expansion slot, and reports the composer nodes it cannot
 * compile (the node is then returned as it was). Without a catalog (the portable
 * profile) nothing can be resolved and every node is returned as it was.
 *
 * The slot keeps the node's own id, so everything bound to it stays bound. It is
 * the join node already written: the composer, the join prompt, the artifact the
 * composer declares, `required` and `report_to_parent` as authored, and `expand`
 * naming the split node whose plan replaces it at admission. It depends on the
 * split node alone, because the children it will wait for are not known yet.
 */
export function compileNodes(nodes: readonly NodeConfig[], catalog: Catalog | undefined, limits: Limits): Compiled {
  if (catalog === undefined) return { nodes: [...nodes], problems: [] }
  const compiled: NodeConfig[] = []
  const problems: Problem[] = []
  for (const node of nodes) {
    if (!composerNode(node, catalog)) {
      compiled.push(node)
      continue
    }
    const checked = checkNode(node, catalog)
    if ("problem" in checked) {
      problems.push(checked.problem)
      compiled.push(node)
      continue
    }
    compiled.push(...splitAndSlot(node, checked.composer, limits))
  }
  return { nodes: compiled, problems }
}

function checkNode(node: NodeConfig, catalog: Catalog): { composer: Composer } | { problem: Problem } {
  const block = node.block === "compose"
  const subject = block ? `compose block "${node.id}"` : `node "${node.id}"`
  const refuse = (message: string, hint: string): { problem: Problem } => ({
    problem: {
      node: node.id,
      path: block ? `config.blocks[${node.id}].worker_type` : `nodes[${node.id}].worker_type`,
      message: `${subject}: ${message}`,
      hint,
    },
  })
  const resolution = resolve(catalog, node.worker_type)
  if (!resolution.available)
    return refuse(
      resolution.reason,
      'worker_type must name an agent whose contract declares role "composer" and whose dispatch list holds public, read-only agents',
    )
  if (node.prompt_template.inline === undefined)
    return refuse(
      `composer "${node.worker_type}" cannot run with a prompt asset (prompt_template.id): its prompts are built from the node's inline prompt`,
      "Give the node an inline prompt_template, or use a compose block",
    )
  if (node.fan_out !== undefined || node.review !== undefined)
    return refuse(
      `composer "${node.worker_type}" cannot carry ${node.fan_out !== undefined ? "fan_out" : "review"}: it plans read-only work`,
      "Remove the field; fan_out belongs to a coding writer and review to a review worker",
    )
  const alias = reservedAlias(node.id, node.input_mapping)
  if (alias !== undefined)
    return {
      problem: {
        node: node.id,
        path: block ? `config.blocks[${node.id}].input_mapping` : `nodes[${node.id}].input_mapping`,
        message: `${subject}: input alias "${alias}" is reserved: the expansion binds the split node and its children under "${node.id}--…"`,
        hint: `Rename the alias (and its placeholder) so that it does not start with "${node.id}--"`,
      },
    }
  return { composer: resolution.composer }
}

function splitAndSlot(node: NodeConfig, composer: Composer, limits: Limits): NodeConfig[] {
  const planID = splitID(node.id)
  const inline = node.prompt_template.inline ?? ""
  const { input } = node.prompt_template
  const shared = {
    worker_type: composer.name,
    // A composer only produces data (D4): its nodes never write, whatever the agent's own rules say.
    workspace_writes: "deny" as const,
    ...(node.worker_config ? { worker_config: { ...node.worker_config } } : {}),
    ...(node.workspace !== undefined ? { workspace: node.workspace } : {}),
    ...(node.isolation !== undefined ? { isolation: node.isolation } : {}),
    ...(node.model ? { model: { ...node.model } } : {}),
    ...(node.block ? { block: node.block } : {}),
  }
  const split: NodeConfig = {
    ...shared,
    id: planID,
    name: `${node.name}: plan the expansion`,
    depends_on: [...node.depends_on],
    // A split that fails must not fail the workflow: the slot still runs, and degrades.
    required: false,
    report_to_parent: false,
    prompt_template: {
      inline: `${inline}\n\n${splitContract(composer, limits, topPosition(limits))}`,
      ...(input ? { input: { ...input } } : {}),
    },
    ...(node.input_mapping ? { input_mapping: { ...node.input_mapping } } : {}),
    ...(node.condition !== undefined ? { condition: node.condition } : {}),
    ...(node.skip_ok !== undefined ? { skip_ok: node.skip_ok } : {}),
    output_schema: planSchema(composer, limits),
    generated_helper: "split",
  }
  const artifact = composer.artifact === undefined ? undefined : AgentArtifact.schema(composer.artifact)
  const outputSchema = node.output_schema ?? artifact
  const slot: NodeConfig = {
    ...shared,
    id: node.id,
    name: node.name,
    depends_on: [planID],
    ...(node.required !== undefined ? { required: node.required } : {}),
    ...(node.report_to_parent !== undefined ? { report_to_parent: node.report_to_parent } : {}),
    ...(node.skip_ok !== undefined ? { skip_ok: node.skip_ok } : {}),
    prompt_template: {
      inline: `${inline}\n\n${joinContract(composer)}`,
      ...(input ? { input: { ...input } } : {}),
    },
    // The prompt keeps the bindings the node was written with; their sources are upstream of the split node.
    input_mapping: node.input_mapping
      ? { ...node.input_mapping }
      : Object.fromEntries(node.depends_on.map((dependency) => [dependency, dependency])),
    ...(outputSchema ? { output_schema: { ...outputSchema } } : {}),
    expand: planID,
  }
  return [split, slot]
}

// ============================================================================
// Expansion: the plan becomes children, and the slot becomes the join node
// ============================================================================

/** What the join node keeps of an expansion: the persisted `NodeConfig.join`. */
export type Join = NonNullable<NodeConfig["join"]>

/** A node id: the pattern block ids and fan-out package ids follow. */
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** The id of the child that runs the plan item `itemID` of the slot `slotID`. */
export function childID(slotID: string, itemID: string): string {
  return `${slotID}--${itemID}`
}

/** The id of the one worker that takes the whole task when a slot cannot be expanded. */
export function fallbackID(slotID: string): string {
  return `${slotID}--fallback`
}

/** What a composed worker is told besides its task. It never writes and never asks (the node is unattended). */
const READ_ONLY_RULES =
  "You run read-only: do not edit files, and do not ask the user questions from this child session. Cite what you read, and say what you did not look at and why."
const ITEM_RULES = `You are one worker of several, each given a separate part of a larger task; answer only this part. ${READ_ONLY_RULES}`

/**
 * The task of a compose block as the author wrote it, taken back from the slot's
 * prompt, which is that task followed by the join contract. A slot that does not
 * carry the contract is returned whole.
 */
export function taskPrompt(inline: string): string {
  const cut = inline.lastIndexOf(`\n\n${JOIN_OPENING}`)
  return cut === -1 ? inline : inline.slice(0, cut)
}

/** A reason as one line of prompt text: braces would read as placeholders, parentheses end the note early. */
function note(reason: string): string {
  return reason.replace(/[{}]/g, "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)
}

export interface ExpansionInput {
  /** The expansion slot as persisted: carries `expand`. */
  readonly slot: NodeConfig
  readonly composer: Composer
  readonly limits: Limits
  /** The split node as the store has it. Only a completed one holds a plan. */
  readonly source:
    { readonly status: string; readonly output: unknown; readonly errorReason?: string | null } | undefined
  /** Every node id of the workflow now, so a child never takes an id that is used. */
  readonly existingNodeIDs: ReadonlySet<string>
  /** Where this plan sits; a top-level compose block when left out. */
  readonly position?: Position
}

/**
 * What replaces the slot. Either way the fragment holds the join node under the
 * slot's id plus its new children, so one `Dag.extend` makes the change.
 *
 * - `expand`: one child per plan item.
 * - `fallback`: one child that takes the whole task, with the reason the plan was
 *   not expanded. The reason is also what the join node and the coverage section report.
 */
export type Expansion =
  | { readonly kind: "expand"; readonly nodes: NodeConfig[] }
  | { readonly kind: "fallback"; readonly nodes: NodeConfig[]; readonly reason: string }

/**
 * Turns the split node's plan into the nodes that replace the slot, deciding
 * everything from the persisted plan, the slot's definition and the catalog and
 * limits as they are now, so planning again after a crash gives the same node ids
 * and definitions. The plan is checked again (`checkPlan`: the catalog may have
 * changed since the split node ran), and anything that cannot be expanded degrades
 * to one fallback worker instead of failing the workflow: a plan that is missing,
 * invalid or empty, an agent that can no longer be expanded, a plan the subtree
 * has no room for, and a child id that is taken or is not a node id.
 *
 * A `split: true` item runs as a plain worker here; nested expansion is not
 * written yet (#1158 PR3b-2).
 */
export function planExpansion(input: ExpansionInput): Expansion {
  const { slot, composer, limits, source, existingNodeIDs } = input
  const planID = slot.expand ?? splitID(slot.id)
  const position = input.position ?? topPosition(limits)
  const decline = (reason: string) => degrade(slot, composer, reason)
  if (source === undefined) return decline(`the split node "${planID}" is gone`)
  if (source.status !== "completed")
    return decline(`the split node "${planID}" ${source.status}${source.errorReason ? `: ${source.errorReason}` : ""}`)
  const checked = checkPlan(source.output, composer, limits)
  if (!checked.ok) return decline(`the plan was rejected: ${checked.error}`)
  const { items } = checked.plan
  if (items.length === 0) return decline("the plan has no items")
  if (items.length > position.remainingNodes)
    return decline(
      `the plan has ${items.length} items but the expansion has room for ${position.remainingNodes} more nodes (dag.compose.max_subtree_nodes)`,
    )
  const children: NodeConfig[] = []
  const joined: Join["items"] = []
  for (const item of items) {
    const id = childID(slot.id, item.id)
    if (!NODE_ID.test(id)) return decline(`node id "${id}" is not a valid node id`)
    if (existingNodeIDs.has(id)) return decline(`node "${id}" already exists`)
    const worker = composer.dispatch.find((candidate) => candidate.name === item.agent)
    if (worker === undefined) return decline(`item "${item.id}" names "${item.agent}", which cannot be expanded`)
    const required = itemRequired(item, composer)
    children.push(
      childNode(slot, planID, {
        id,
        name: `${slot.name} [${item.id}]`,
        worker,
        // D9: a required item fails the workflow only when the block is required; in an optional block it stays
        // optional here, and the join node's admission check is what finds it missing.
        required: slot.required === true && required,
        prompt: itemPrompt(item),
        mapping: {},
      }),
    )
    joined.push({ id: item.id, node: id, agent: item.agent, required })
  }
  return { kind: "expand", nodes: [...children, joinNode(slot, planID, joined, children)] }
}

/**
 * The expansion that does not split: one child, the composer's `fallback` worker,
 * takes the whole task as the block's author wrote it, and the join node reads its
 * result. `reason` says why the plan was not expanded; it is written into both
 * prompts, kept as `join.degraded`, and left to the caller to log.
 */
export function degrade(
  slot: NodeConfig,
  composer: Composer,
  reason: string,
): Extract<Expansion, { kind: "fallback" }> {
  const planID = slot.expand ?? splitID(slot.id)
  const why = note(reason)
  const id = fallbackID(slot.id)
  const worker = composer.dispatch.find((candidate) => candidate.name === composer.fallback) ?? {
    name: composer.fallback,
    failure: "skip" as const,
  }
  const child = childNode(slot, planID, {
    id,
    name: `${slot.name} [fallback]`,
    worker,
    // The whole task is the block's own work: it is as required as the block.
    required: slot.required === true,
    prompt: {
      inline: [
        taskPrompt(slot.prompt_template.inline ?? ""),
        `Compose expansion was degraded (${why}). Nothing was split: you take the whole task alone.`,
        READ_ONLY_RULES,
      ].join("\n\n"),
      ...(slot.prompt_template.input ? { input: { ...slot.prompt_template.input } } : {}),
    },
    // It does the whole task, so it reads what the block read.
    mapping: { ...slot.input_mapping },
  })
  // Not an item the plan could leave out: that no worker produced anything is `compose_no_results`, not a missing item.
  const joined: Join["items"] = [{ id: "fallback", node: id, agent: worker.name, required: false }]
  return { kind: "fallback", reason, nodes: [child, joinNode(slot, planID, joined, [child], why)] }
}

interface ChildSpec {
  readonly id: string
  readonly name: string
  readonly worker: Worker
  readonly required: boolean
  readonly prompt: NodeConfig["prompt_template"]
  readonly mapping: Record<string, string>
}

/**
 * A worker the plan asked for. It waits for the split node alone, sees what its
 * prompt and mapping give it (an item is self-contained: an empty mapping keeps
 * the plan out of its context), never writes (`workspace_writes: "deny"`), never
 * reports to the parent, and produces the artifact its agent declares. It keeps
 * the block's workspace and timeout. It takes no model of the block's: that is the
 * composer's choice, and a worker resolves its own.
 */
function childNode(slot: NodeConfig, planID: string, spec: ChildSpec): NodeConfig {
  const artifact = spec.worker.artifact === undefined ? undefined : AgentArtifact.schema(spec.worker.artifact)
  return {
    id: spec.id,
    name: spec.name,
    worker_type: spec.worker.name,
    depends_on: [planID],
    required: spec.required,
    report_to_parent: false,
    workspace_writes: "deny",
    prompt_template: spec.prompt,
    input_mapping: spec.mapping,
    ...(slot.worker_config ? { worker_config: { ...slot.worker_config } } : {}),
    ...(slot.workspace !== undefined ? { workspace: slot.workspace } : {}),
    ...(artifact ? { output_schema: artifact } : {}),
  }
}

/** The task of one plan item, kept out of the template text: the plan's words are data, not placeholders. */
function itemPrompt(item: PlanItem): NodeConfig["prompt_template"] {
  const scope = (item.scope ?? []).filter((entry) => entry.trim() !== "")
  return {
    inline: [
      "{{compose_instruction}}",
      ...(scope.length > 0 ? ["Scope, so that this item does not overlap the others:\n{{compose_scope}}"] : []),
      ITEM_RULES,
    ].join("\n\n"),
    input: {
      compose_instruction: item.instruction,
      ...(scope.length > 0 ? { compose_scope: scope.map((entry) => `- ${entry}`).join("\n") } : {}),
    },
  }
}

/**
 * The slot, now the join node: the same definition under the same id, so every
 * binding to it stays, minus the marker, plus what it joins. It waits for every
 * child and reads the plan and each child's result by node id (the keys of the
 * Context its prompt describes): a child that failed or was skipped reaches it as
 * the scheduler's placeholder text, an artifact as itself. The mapping the slot
 * had, the block's own inputs, is kept.
 */
function joinNode(
  slot: NodeConfig,
  planID: string,
  items: Join["items"],
  children: readonly NodeConfig[],
  degraded?: string,
): NodeConfig {
  const { expand: _expand, ...definition } = slot
  const join: Join = { plan: planID, items, ...(degraded !== undefined ? { degraded } : {}) }
  return {
    ...definition,
    depends_on: children.map((child) => child.id),
    prompt_template: { ...slot.prompt_template, inline: `${slot.prompt_template.inline ?? ""}\n\n${joinInput(join)}` },
    input_mapping: {
      ...slot.input_mapping,
      [planID]: planID,
      ...Object.fromEntries(children.map((child) => [child.id, child.id])),
    },
    join,
  }
}

/** Tells the join node what each key of its Context is, and whether the plan was followed. */
function joinInput(join: Join): string {
  return [
    ...(join.degraded !== undefined
      ? [
          `Compose expansion was degraded (${join.degraded}): one worker took the whole task, so nothing was compared across items. Say so in not_examined.`,
        ]
      : []),
    "Expansion input, by key of the Context:",
    `- "${join.plan}": the plan this expansion followed.`,
    ...join.items.map((item) =>
      join.degraded !== undefined
        ? `- "${item.node}": the whole task, by ${item.agent}.`
        : `- "${item.node}": item "${item.id}", by ${item.agent}; ${item.required ? "required" : "may be skipped"}.`,
    ),
    'A key that holds an artifact is that item\'s result. A key that holds text starting with "Dependency" says the item failed, was skipped or was aborted, and why: the item is not covered.',
  ].join("\n")
}

// ============================================================================
// The join node's admission check
// ============================================================================

/** The error class of a join node refused because the work of a required item is missing. */
export const REQUIRED_MISSING = "compose_required_missing"
/** The error class of a join node refused because none of its items produced anything. */
export const NO_RESULTS = "compose_no_results"

/** What the check reads of an item's child: its row as the store keeps it. */
export interface JoinChild {
  readonly status: string
  readonly output: unknown
}

export type JoinVerdict =
  | { readonly kind: "run" }
  | {
      readonly kind: "refuse"
      readonly errorClass: typeof REQUIRED_MISSING | typeof NO_RESULTS
      /** Reads as the tail of `Dependency "<join>" failed: ...`, which is what a dependent is given. */
      readonly reason: string
    }

/** A child produced something when it completed with an output; a null one is the scheduler's "completed without output". */
function produced(child: JoinChild | undefined): boolean {
  return child?.status === "completed" && child.output !== null && child.output !== undefined
}

/** One item and what became of its child, as the reason a join node is refused names it. */
function outcome(item: Join["items"][number], child: JoinChild | undefined): string {
  const state = child === undefined ? "gone" : child.status === "completed" ? "completed without output" : child.status
  return `"${item.id}" (${item.node}: ${state})`
}

/**
 * Whether a join node may run, decided before any model call from what its
 * children left behind. `child` finds the row of an item's child by node id; a
 * child counts when it completed with an output, so a failed, skipped, aborted,
 * cancelled or vanished one does not.
 *
 * - A required item whose child has nothing refuses the join node with
 *   `compose_required_missing`. In an optional block the child of a required item
 *   is optional, so its failure reaches the join node and is found here. In a
 *   required block a required child that fails already failed the workflow, and
 *   the join node never became ready; what is left to find is a child that
 *   completed without an output.
 * - A join node none of whose children has anything refuses with
 *   `compose_no_results`. The fallback worker of a degraded expansion is the
 *   only child then, and is not an item the plan could have left out, so its
 *   failure takes this path too.
 *
 * Either way the node fails with its own `required` deciding what that costs: an
 * optional join node hands its dependents the failure as their placeholder, and a
 * required one fails the workflow. The first check wins when both would refuse.
 */
export function checkJoin(join: Join, child: (node: string) => JoinChild | undefined): JoinVerdict {
  const missing = join.items.filter((item) => !produced(child(item.node)))
  const list = (items: readonly Join["items"][number][]) =>
    items.map((item) => outcome(item, child(item.node))).join(", ")
  const required = missing.filter((item) => item.required)
  if (required.length > 0)
    return {
      kind: "refuse",
      errorClass: REQUIRED_MISSING,
      reason: `Compose join did not run: required ${required.length === 1 ? "item" : "items"} ${list(required)} produced no result`,
    }
  if (missing.length < join.items.length) return { kind: "run" }
  return {
    kind: "refuse",
    errorClass: NO_RESULTS,
    reason:
      join.items.length === 0
        ? "Compose join did not run: the expansion has no item to join"
        : join.degraded !== undefined
          ? `Compose join did not run: the fallback worker produced no result: ${list(missing)}`
          : `Compose join did not run: no item produced a result: ${list(missing)}`,
  }
}

// ============================================================================
// The submission gate (goes away with the runtime expansion)
// ============================================================================

/**
 * The scheduler cannot expand a slot yet (#1158 PR3b), so a graph that holds a
 * compose block or a composer node must not be submitted: it would run the
 * half-built join node as an ordinary node. The Workflow Authoring Check calls
 * this for every graph it prepares, and the runtime expansion removes the call
 * together with this function.
 */
export function gate(nodes: readonly NodeConfig[]): Problem[] {
  return nodes
    .filter((node) => node.expand !== undefined || (node.block === "compose" && node.generated_helper === undefined))
    .map((node) => {
      const block = node.block === "compose"
      return {
        node: node.id,
        path: block ? `config.blocks[${node.id}]` : `nodes[${node.id}]`,
        message: `compose 的运行时展开尚未启用（#1158 PR3b）: ${block ? "compose block" : "composer node"} "${node.id}" cannot be submitted yet, because the engine cannot expand it while the workflow runs`,
        hint: "Use explore and plan blocks instead, or fan the work out by hand with run.extend",
      }
    })
}

export * as DagCompose from "./compose"
