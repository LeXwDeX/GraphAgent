// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { Dag } from "@/dag/dag"
import { WorkflowAuthoring } from "@/dag/authoring"
import type { Tool } from "../tool"
import { loadAuthoringSource } from "./files"

type Authoring = ReturnType<typeof WorkflowAuthoring.make>

export interface MutationSessionContext {
  readonly directory: string
  readonly projectID: string
  readonly model: { id: string; providerID: string } | undefined
}

/** Assemble the authoring context shared by extend and replan from a live
 * workflow: its persisted node defaults and workspace, its current node IDs as
 * the known dependency set, and the spec source at `specPath`. */
export const prepareMutation = (
  dag: Dag.Interface,
  authoring: Authoring,
  input: {
    readonly action: "extend" | "replan"
    readonly workflow: { readonly id: string; readonly config: string }
    readonly specPath: string
    readonly session: MutationSessionContext
    readonly ctx: Tool.Context
  },
) =>
  Effect.gen(function* () {
    const workflowConfig = Dag.parseWorkflowConfig(input.workflow.config)
    const knownDependencies = (yield* dag.store.getNodes(input.workflow.id).pipe(Effect.orDie)).map((node) => node.id)
    const source = yield* loadAuthoringSource(
      input.specPath,
      input.session.directory,
      input.session.projectID,
      input.ctx,
    ).pipe(Effect.orDie)
    return yield* authoring.prepare({
      action: input.action,
      source,
      profile: "environment",
      environment: { directory: input.session.directory, parent: input.session.model },
      executionWorkspace: workflowConfig?.workspace,
      known_dependencies: knownDependencies,
      node_defaults: workflowConfig?.node_defaults,
    })
  })
