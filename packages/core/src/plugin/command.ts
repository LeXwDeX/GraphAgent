/// <reference path="../markdown.d.ts" />

export * as CommandPlugin from "./command"

import workflowRouting from "./command/workflow-routing.md" with { type: "text" }
import { DELEGATION_CRITERIA } from "./delegation-criteria"

// The routing text carries `{{delegation_criteria}}`; the tiers are defined once in delegation-criteria.ts (#1454).
export const WorkflowContent = workflowRouting.replace("{{delegation_criteria}}", () => DELEGATION_CRITERIA)
