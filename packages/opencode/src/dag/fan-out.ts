// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NodeConfig } from "./dag"
import { AGGREGATOR_CONTRACT, IMPLEMENTATION_SCHEMA, aggregatorEvidenceMapping } from "./blocks"

/**
 * Admission-time expansion of a `fan_out` writer. The planner owns how many
 * packages exist and where their boundaries fall; the engine only turns a
 * shape it can prove safe into parallel writers. Anything else runs the
 * original writer serially, which is always safe, with the reason in its
 * prompt so the degradation is visible rather than silent.
 */
export type FanOutPlan =
  | { readonly kind: "expand"; readonly nodes: NodeConfig[]; readonly writerIDs: string[] }
  | { readonly kind: "single"; readonly node: NodeConfig; readonly reason?: string }

interface WorkPackage {
  id: string
  instruction: string
  write_set: string[]
}

const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function planFanOut(
  writer: NodeConfig,
  sourceOutput: unknown,
  existingNodeIDs: ReadonlySet<string>,
): FanOutPlan {
  const packages = readPackages(sourceOutput)
  if (!Array.isArray(packages)) return declineFanOut(writer, `"${writer.fan_out}" produced no packages list`)
  if (packages.length < 2) return declineFanOut(writer)
  const checked = checkPackages(writer, packages, existingNodeIDs)
  if (typeof checked === "string") return declineFanOut(writer, checked)
  const accepted = checked
  const writerIDs = accepted.map((item) => `${writer.id}--${item.id}`)
  const evidence = evidenceMapping(writerIDs)
  if (typeof evidence === "string") return declineFanOut(writer, evidence)

  const { fan_out: _fanOut, ...definition } = writer
  const writers = accepted.map(
    (item, index): NodeConfig => ({
      ...definition,
      id: writerIDs[index],
      name: `${writer.name} [${item.id}]`,
      report_to_parent: false,
      prompt_template: {
        ...writer.prompt_template,
        inline: `${writer.prompt_template.inline}\n\nAssigned work package — implement only this package and edit only paths inside its write_set; report drift instead of crossing into another package:\n{{fan_out_package}}`,
        input: { ...writer.prompt_template.input, fan_out_package: item },
      },
    }),
  )
  const objective = writer.prompt_template.input?.objective
  const aggregator: NodeConfig = {
    id: writer.id,
    name: `${writer.name}: aggregate fan-out writers`,
    worker_type: "explore",
    depends_on: writerIDs,
    required: writer.required,
    report_to_parent: writer.report_to_parent,
    prompt_template: {
      inline: [
        typeof objective === "string" ? "Workflow objective:\n{{objective}}" : "",
        AGGREGATOR_CONTRACT,
        "Use dependency outputs as evidence and return a concise artifact that downstream blocks can consume. Do not ask the user questions from this child session.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      ...(typeof objective === "string" ? { input: { objective } } : {}),
    },
    ...(writer.worker_config ? { worker_config: writer.worker_config } : {}),
    input_mapping: evidence,
    output_schema: IMPLEMENTATION_SCHEMA,
  }
  return { kind: "expand", nodes: [...writers, aggregator], writerIDs }
}

/** The serial fallback: the writer without its marker, carrying the reason. */
export function declineFanOut(writer: NodeConfig, reason?: string): Extract<FanOutPlan, { kind: "single" }> {
  const { fan_out: _fanOut, ...definition } = writer
  if (!reason || writer.prompt_template.inline === undefined) return { kind: "single", node: definition, reason }
  // The reason can quote planner text; strip braces so it never reads as a placeholder.
  const note = reason.replace(/[{}]/g, "")
  return {
    kind: "single",
    reason,
    node: {
      ...definition,
      prompt_template: {
        ...writer.prompt_template,
        inline: `${writer.prompt_template.inline}\n\nParallel fan-out was declined (${note}). Implement every work package from the plan yourself, in order, as one writer.`,
      },
    },
  }
}

function readPackages(output: unknown): unknown {
  const value = typeof output === "string" ? parseJson(output) : output
  if (typeof value !== "object" || value === null) return undefined
  return Reflect.get(value, "packages")
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The accepted packages, or the reason the shape is not provably safe. */
function checkPackages(
  writer: NodeConfig,
  packages: unknown[],
  existingNodeIDs: ReadonlySet<string>,
): WorkPackage[] | string {
  if (writer.prompt_template.inline === undefined) return "the writer uses a prompt asset, which cannot carry a package"
  const seen = new Set<string>()
  const claimed: { owner: string; path: string }[] = []
  const accepted: WorkPackage[] = []
  for (const [index, item] of packages.entries()) {
    if (!isPackage(item)) return `package ${index} is not { id, instruction, write_set }`
    accepted.push(item)
    if (!PACKAGE_ID.test(item.id)) return `package id "${item.id}" must use only letters, numbers, underscores, and hyphens`
    if (seen.has(item.id)) return `package id "${item.id}" is duplicated`
    seen.add(item.id)
    if (existingNodeIDs.has(`${writer.id}--${item.id}`)) return `node "${writer.id}--${item.id}" already exists`
    if (item.instruction.trim() === "") return `package "${item.id}" has an empty instruction`
    if (item.write_set.length === 0) return `package "${item.id}" declares no write_set`
    for (const raw of item.write_set) {
      const path = normalizeWritePath(raw)
      if (path === undefined) return `package "${item.id}" write_set entry "${raw}" is not a repository-relative path`
      const overlap = claimed.find((other) => other.owner !== item.id && pathsOverlap(other.path, path))
      if (overlap) return `packages "${overlap.owner}" and "${item.id}" overlap at "${overlap.path}" / "${path}"`
      claimed.push({ owner: item.id, path })
    }
  }
  return accepted
}

function isPackage(value: unknown): value is WorkPackage {
  if (typeof value !== "object" || value === null) return false
  const item: Record<string, unknown> = Object.fromEntries(Object.entries(value))
  return (
    typeof item.id === "string" &&
    typeof item.instruction === "string" &&
    Array.isArray(item.write_set) &&
    item.write_set.every((entry) => typeof entry === "string")
  )
}

/** Repository-relative, slash-separated, no traversal; "" means the whole tree. */
function normalizeWritePath(raw: string): string | undefined {
  const path = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "")
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return undefined
  if (path.split("/").some((part) => part === "..")) return undefined
  return path === "." ? "" : path
}

function pathsOverlap(left: string, right: string) {
  if (left === "" || right === "") return true
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function evidenceMapping(writerIDs: string[]): Record<string, string> | string {
  try {
    return aggregatorEvidenceMapping(writerIDs)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export * as DagFanOut from "./fan-out"
