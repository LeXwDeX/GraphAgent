// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { AgentContract } from "@/agent/contract"
import { DagCompose } from "@/dag/compose"
import { Permission } from "@/permission"

/**
 * An agent catalog for the compose tests (#1158), built the way the built-in
 * agents build theirs: the open defaults first, then the role's own rules. The
 * names say what each one is for the composers below.
 */

const open = Permission.fromConfig({ "*": "allow" })
export const readOnlyRules = Permission.merge(
  open,
  Permission.fromConfig({ "*": "deny", read: "allow", grep: "allow", glob: "allow", bash: "allow" }),
)
export const writerRules = open

export const agent = (
  name: string,
  options: {
    permission?: typeof open
    contract?: AgentContract.Declared
    description?: string
    native?: boolean
  } = {},
): DagCompose.CatalogAgent => ({
  name,
  native: options.native ?? false,
  permission: options.permission ?? readOnlyRules,
  ...(options.description !== undefined ? { description: options.description } : {}),
  ...(options.contract ? { contract: options.contract } : {}),
})

export const compose = (
  pattern: "fan_out" | "recursive_split",
  dispatch: string[],
  fallback: string,
): NonNullable<AgentContract.Declared["compose"]> => ({ pattern, dispatch, fallback })

/**
 * - `explore`, `researcher`: public read-only workers (their failure may be skipped)
 * - `auditor`: public read-only, and its failure is the plan's failure
 * - `secret`: read-only but private; `prototyper`: a private writer; `ghost` does not exist
 * - `surveyor`: fan_out over all six, `mapper`: recursive_split over `explore`
 */
export const agents = (): DagCompose.CatalogAgent[] => [
  agent("explore", {
    description: "Reads the code and reports what it finds.",
    contract: { visibility: "public", output: { artifact: "code_findings", task: false } },
  }),
  agent("researcher", {
    description: "Researches outside sources.",
    contract: { visibility: "public", output: { artifact: "research_findings" } },
  }),
  agent("auditor", { contract: { visibility: "public", failure: "fail" } }),
  agent("secret", { contract: { visibility: "private" } }),
  agent("prototyper", {
    permission: writerRules,
    contract: { visibility: "private", output: { artifact: "prototype" } },
  }),
  agent("surveyor", {
    contract: {
      role: "composer",
      output: { artifact: "survey_report" },
      compose: compose("fan_out", ["researcher", "explore", "auditor", "secret", "prototyper", "ghost"], "researcher"),
    },
  }),
  agent("mapper", {
    contract: {
      role: "composer",
      output: { artifact: "project_map" },
      compose: compose("recursive_split", ["explore"], "explore"),
    },
  }),
]

export const catalog = (list: DagCompose.CatalogAgent[] = agents()) => DagCompose.catalogFrom(list)

/** The composer `name` of the catalog, which the test expects to be usable. */
export function composerOf(name: string, list: DagCompose.CatalogAgent[] = agents()): DagCompose.Composer {
  const resolution = DagCompose.resolve(catalog(list), name)
  if (!resolution.available) throw new Error(`expected ${name} to be usable: ${resolution.reason}`)
  return resolution.composer
}
