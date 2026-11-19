// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Option, type Schema } from "effect"
import { CommandPlugin } from "@graphagent/core/plugin/command"
import { Dag } from "@/dag/dag"
import { DagBudget } from "@/dag/budget"
import { DagControl } from "@/dag/control"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionRole } from "@/session/role"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagEnvironmentCatalogs } from "@/dag/environment-catalogs"
import { argumentAction, bound, formatSchemaFailures } from "../schema-error"
import { Tool } from "../tool"
import { controlWorkflow } from "./control"
import { inspectWorkflow } from "./inspect"
import { repairFlatWorkflowCall } from "./render"
import { runWorkflow } from "./run"
import { Parameters, type Metadata } from "./schema"
import { draftSpec, listSpecs, readSpec, validateSpec } from "./spec"

// Re-exported so the committed workflow library and wire-shape tests can
// import them from the tool module without reaching into the directory.
export { Parameters, Parameters as WorkflowParameters, StartSpec } from "./schema"
export { resultTargetFields, worktreeResultFields } from "./render"

const id = "workflow"

/** Pre-convergence action names. A call carrying one of these explains the
 * exact new shape instead of a bare union-discriminator failure. */
const RETIRED_ACTIONS: Record<string, string> = {
  start: 'use {params:{action:"run",operation:"start",spec_path}}',
  extend: 'use {params:{action:"run",operation:"extend",workflow_id,spec_path}}',
  status: 'use {params:{action:"inspect",operation:"status",workflow_id}}',
  result: 'use {params:{action:"inspect",operation:"result",workflow_id,node_id}}',
  list: 'use {params:{action:"spec",operation:"list"}}',
  read: 'use {params:{action:"spec",operation:"read",spec_path}}',
  draft:
    'use {params:{action:"spec",operation:"draft",config}}; config expects one graph shape: nodes[...] or blocks[...]',
  validate: 'use {params:{action:"spec",operation:"validate",spec_path}}',
  guide: "the guide action was removed; the tool description carries the routing rules",
  extend_timeout: 'use {params:{action:"control",operation:"extend_timeout",workflow_id,node_id,timeout_ms}}',
}

const ACTIONS_SUMMARY =
  "spec {list|read|draft|validate}; run {start|extend}; inspect {status|result}; control {pause|resume|step|cancel|complete|cancel_node|replan|recover|extend_timeout|retarget}. Put graph content in a spec file or draft config."

/** Permission patterns from the pre-convergence schema. It asked for the bare
 * action name (control also for `control:<operation>`), so a configured deny
 * such as workflow:{"start":"deny"} must keep matching after actions gained
 * operation groups. Control patterns are unchanged and need no mapping beyond
 * the retired top-level extend_timeout action. */
const retiredActionPermissionPattern = (action: string, operation: string): string | undefined => {
  if (action !== "control") return operation
  return operation === "extend_timeout" ? "extend_timeout" : undefined
}

export const WorkflowTool = Tool.define<
  typeof Parameters,
  Metadata,
  Dag.Service | DagControl.Service | Session.Service | Agent.Service | Provider.Service
>(
  id,
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const control = yield* DagControl.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    // Optional so harnesses without a Config service stay valid; the service
    // lookup needs no environment requirement of its own.
    const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    // #1031 M5: optional so harnesses without the budget service stay valid.
    const budget = Option.getOrUndefined(yield* Effect.serviceOption(DagBudget.Service))

    const authoring = WorkflowAuthoring.make({
      loadEnvironment: DagEnvironmentCatalogs.makeCatalogLoader(agents, provider),
      // Production reads the user's hot global `dag.max_total_nodes` cap on
      // every start validation.
      ...(config ? { config } : {}),
    })

    return {
      description: CommandPlugin.WorkflowContent,
      effects: "unknown",
      parameters: Parameters,
      structuredOutput: true,
      parseOptions: { onExcessProperty: "error" },
      repairContainerFields: ["params"],
      repairArguments: repairFlatWorkflowCall,
      formatValidationError: (error, input) => {
        const attempted = argumentAction(input)
        const detail = formatSchemaFailures(error, 2, attempted)
        const retired =
          attempted !== undefined && Object.hasOwn(RETIRED_ACTIONS, attempted) ? RETIRED_ACTIONS[attempted] : undefined
        const message =
          attempted === "send" || attempted === "receive" || attempted === "observe"
            ? `workflow has no ${attempted} action; use agent {params:{action:"${attempted}", ...}} for messaging and inspect {status} for graph progress.`
            : retired !== undefined
              ? `workflow no longer has a ${attempted} action; ${retired}.`
              : "workflow call rejected by the action schema."
        return bound(`${message}${detail ? ` Details: ${detail}.` : ""} ${ACTIONS_SUMMARY}`, 480)
      },
      execute: (call: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const params = call.params
          const callingSession = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
          if (SessionRole.isChild(callingSession)) {
            return yield* Effect.die(
              new Error("Workflow orchestration is available only to the main conversation, not child agents"),
            )
          }
          const retiredPattern = retiredActionPermissionPattern(params.action, params.operation)
          yield* ctx.ask({
            permission: id,
            // Both checks apply: a fine-grained allow must never bypass a
            // pre-existing group deny or approval requirement. The retired-action
            // pattern keeps a deny configured against the old bare action
            // name (e.g. start/extend/status) effective after convergence.
            patterns: [
              params.action,
              `${params.action}:${params.operation}`,
              ...(retiredPattern ? [retiredPattern] : []),
            ],
            always: ["*"],
            metadata: {
              action: params.action,
              operation: params.operation,
              ...("workflow_id" in params ? { workflow_id: params.workflow_id } : {}),
              ...("node_id" in params ? { node_id: params.node_id } : {}),
            },
          })
          const session = {
            directory: callingSession.directory,
            projectID: callingSession.projectID,
            model: callingSession.model,
            dagMode: callingSession.dagMode,
          }
          switch (params.action) {
            case "spec":
              switch (params.operation) {
                case "list":
                  return yield* listSpecs(authoring, session)
                case "read":
                  return yield* readSpec(authoring, params.spec_path, session, ctx)
                case "draft":
                  return yield* draftSpec(authoring, params.config, params.title, session, ctx)
                case "validate":
                  return yield* validateSpec(authoring, params.spec_path, params.profile, params.inputs, session, ctx)
                default:
                  return yield* Effect.die(new Error("unreachable workflow spec operation"))
              }
            case "run":
              return yield* runWorkflow({ dag, control, ...(budget ? { budget } : {}), authoring, sessionID: ctx.sessionID, session, ctx }, params)
            case "inspect":
              return yield* inspectWorkflow(
                { dag, sessionID: ctx.sessionID, children: ctx.children, ...(config ? { config } : {}) },
                params,
              )
            case "control":
              return yield* controlWorkflow({ dag, control, authoring, sessionID: ctx.sessionID, session, ctx }, params)
            default:
              return yield* Effect.die(new Error("unreachable workflow action"))
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
