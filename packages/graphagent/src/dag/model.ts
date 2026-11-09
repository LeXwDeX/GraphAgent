// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagModel from "./model"

export type Ref = {
  modelID: string
  providerID: string
}

/**
 * Resolve one DAG node model from most specific to broadest. Persisted node
 * models remain first for compatibility with existing workflows; new workflow
 * tool inputs omit them and normally resolve through the configured DAG tier.
 */
export function resolve(input: {
  node?: Ref
  tier?: Ref
  agent?: Ref
  parent?: Ref
}) {
  return input.node ?? input.tier ?? input.agent ?? input.parent
}
