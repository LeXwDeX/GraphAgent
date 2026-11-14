/// <reference path="../markdown.d.ts" />

export * as CommandPlugin from "./command"

import workflowRouting from "./command/workflow-routing.md" with { type: "text" }

export const WorkflowContent = workflowRouting
