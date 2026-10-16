import type { Tool } from "./tool"
const audited = new WeakSet<Tool.AnyTool>()
/** Host-internal: only the audited shipped leaf marks its actual canonical instance. */
export function markPermissionRewrite<T extends Tool.AnyTool>(tool: T): T {
  audited.add(tool)
  return tool
}
export function canRewritePermission(tool: Tool.AnyTool) {
  return audited.has(tool)
}
