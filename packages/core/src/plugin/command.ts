/// <reference path="../markdown.d.ts" />

export * as CommandPlugin from "./command"

import { define } from "./internal"
import { Effect } from "effect"
import path from "node:path"
import { Global } from "../global"
import { Location } from "../location"
import PROMPT_INITIALIZE from "./command/initialize.txt"
import PROMPT_REVIEW from "./command/review.txt"
import DAG_AUTO_PROMPT from "./command/dag-auto.txt"
import workflowRouting from "./command/workflow-routing.md" with { type: "text" }
import workflowBlocks from "./command/workflow-blocks.md" with { type: "text" }
import workflowContent from "./command/workflow.md" with { type: "text" }
import orchestrationPolicy from "./command/orchestration-policy.md" with { type: "text" }
import orchestrationDomains from "./command/orchestration-domains.md" with { type: "text" }

export const DagAutoDescription =
  "Assess useful DAG orchestration for a request and adapt the graph to its evidence and dependencies"
export const WorkflowFactsContent = workflowContent
export const WorkflowBlocksContent = workflowBlocks
export const OrchestrationPolicyContent = orchestrationPolicy
export const OrchestrationDomainsContent = orchestrationDomains
export const WorkflowContent = workflowRouting
export const DagAutoContent = DAG_AUTO_PROMPT

/** The project-scoped XDG directory for /dag command spec YAML. */
export function dagSpecsArea(projectID: string) {
  return path.join(Global.Path.data, "workflow-artifacts", projectID, ".dag-specs")
}

/** Substitute the run-specific spec directory into the /dag-auto prompt. */
export function renderDagAutoContent(projectID: string) {
  return DagAutoContent.replaceAll("${dag_specs}", dagSpecsArea(projectID))
}

export const Plugin = define({
  id: "command",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    yield* ctx.command.transform((draft) => {
      draft.update("init", (command) => {
        command.template = PROMPT_INITIALIZE.replace("${path}", location.project.directory)
        command.description = "guided AGENTS.md setup"
      })
      draft.update("review", (command) => {
        command.template = PROMPT_REVIEW.replace("${path}", location.project.directory)
        command.description = "review changes [commit|branch|pr], defaults to uncommitted"
        command.subtask = true
      })
      draft.update("dag-auto", (command) => {
        command.template = renderDagAutoContent(location.project.id)
        command.description = DagAutoDescription
      })
    })
  }),
})
