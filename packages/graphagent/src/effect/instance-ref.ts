import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@graphagent/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~graphagent/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~graphagent/WorkspaceRef", {
  defaultValue: () => undefined,
})
