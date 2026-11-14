// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagEnvironmentCatalogs from "./environment-catalogs"

import { Effect } from "effect"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import type { Provider } from "@/provider/provider"
import { DagSection } from "@/config/dag-section"
import { Dag } from "./dag"
import { DagConfig } from "./config"
import { DagModel } from "./model"
import { DagValidation } from "./validation"

/**
 * The environment-profile catalog loader shared by the workflow tool's
 * authoring and start paths: agent names, model availability, and tier
 * resolution from the project's DAG settings. Passing the services in keeps
 * this module layer-free — callers resolve Agent/Provider from their own
 * composition context.
 */
export const makeCatalogLoader =
  (
    agents: Agent.Interface,
    provider: Provider.Interface,
  ): ((context: {
    directory?: string
    parent?: { id: string; providerID: string }
  }) => Effect.Effect<DagValidation.EnvironmentCatalogs>) =>
  (context) =>
    Effect.gen(function* () {
      if (!context.directory) return {}
      const agentCatalog = yield* agents.list().pipe(Effect.orDie)
      const providerCatalog = yield* provider.list()
      const config = yield* DagSection.dagSection(context.directory)
      const agentsByName = new Map(agentCatalog.map((agent) => [agent.name, agent]))
      const availableModels = new Set(
        Object.values(providerCatalog).flatMap((info) =>
          Object.values(info.models).map((model) => `${model.providerID}/${model.id}`),
        ),
      )
      const resolveModel: NonNullable<DagValidation.EnvironmentCatalogs["resolveModel"]> = (node, defaults) =>
        Effect.sync(() => {
          const resolved = DagModel.resolve({
            node: node.model ?? defaults?.model,
            tier: DagConfig.tierModel(config, {
              required: node.required ?? defaults?.required ?? Dag.DEFAULT_WORKFLOW_CONFIG.nodeRequired,
              workerType: node.worker_type,
            }),
            agent: agentsByName.get(node.worker_type)?.model,
            parent: context.parent ? { modelID: context.parent.id, providerID: context.parent.providerID } : undefined,
          })
          return Boolean(resolved && availableModels.has(`${resolved.providerID}/${resolved.modelID}`))
        })
      return {
        worker_types: new Set(agentCatalog.map((agent) => agent.name)),
        // #946: worktree isolation is only for agents that can edit files.
        // `plan` keeps an edit allow-list for its plan file, so it is excluded
        // explicitly; every other builder is judged by its permission rules.
        writer_types: new Set(
          agentCatalog
            .filter(
              (agent) =>
                agent.name !== "plan" && Permission.disabled(["edit", "write", "patch"], agent.permission).size === 0,
            )
            .map((agent) => agent.name),
        ),
        resolveModel,
      }
    })
