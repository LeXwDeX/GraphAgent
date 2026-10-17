import path from "node:path"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { PermissionUpdate } from "@/hook/trigger-result"

export interface SessionPolicy {
  rules: PermissionV1.Rule[]
  directories?: string[]
  mode?: "default" | "manual" | "acceptEdits" | "dontAsk" | "plan" | "bypassPermissions"
}
export const emptyPolicy = (): SessionPolicy => ({ rules: [], mode: undefined })
const aliases: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  Agent: "task",
  Task: "task",
  Grep: "grep",
  Glob: "glob",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  TodoWrite: "todowrite",
  Skill: "skill",
}
/**
 * Official `mcp__<server>__<tool>` rule names address the native MCP permission `server_tool`.
 * Server-wide names (`mcp__server`, `mcp__server__*`) cannot be told apart from another server
 * whose name merely starts with `server_`, so they widen only deny/ask rules and never an allow.
 */
export function toolPermission(name: string, behavior?: "allow" | "deny" | "ask") {
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length)
    const split = rest.indexOf("__")
    const server = split < 0 ? rest : rest.slice(0, split)
    const tool = split < 0 ? "*" : rest.slice(split + 2)
    if (!server) return name
    if (tool !== "*") return `${server}_${tool}`
    return behavior === "allow" ? name : `${server}_*`
  }
  return aliases[name] ?? name
}

/** Pure session policy update; persistence is a separate, explicitly authorized boundary. */
export function updateSessionPolicy(
  before: SessionPolicy,
  updates: readonly PermissionUpdate[],
  directory: string,
  allowBypass = false,
) {
  const next = structuredClone(before)
  for (const update of updates) {
    if (update.destination !== "session")
      throw new Error("Persistent permission update requires the configuration writer")
    if (update.type === "setMode") {
      // Only the host-held, session-specific startup capability permits this mode.
      if (update.mode === "bypassPermissions") {
        if (allowBypass) next.mode = "bypassPermissions"
        continue
      }
      if (
        update.mode !== "default" &&
        update.mode !== "manual" &&
        update.mode !== "acceptEdits" &&
        update.mode !== "dontAsk" &&
        update.mode !== "plan"
      )
        throw new Error("Unavailable permission mode: a hook cannot enable classifier or bypass permissions")
      next.mode = update.mode
    } else if (update.type === "addDirectories" || update.type === "removeDirectories") {
      const dirs = new Set(next.directories ?? [])
      for (const value of update.directories) {
        const resolved = path.resolve(directory, value)
        if (update.type === "addDirectories") dirs.add(resolved)
        else dirs.delete(resolved)
      }
      next.directories = [...dirs]
    } else if ("rules" in update) {
      const incoming = update.rules.map((rule) => ({
        permission: toolPermission(rule.toolName, update.behavior),
        pattern: rule.ruleContent ?? "*",
        action: update.behavior,
      }))
      if (update.type === "replaceRules") next.rules = next.rules.filter((rule) => rule.action !== update.behavior)
      for (const rule of incoming) {
        next.rules = next.rules.filter(
          (old) =>
            !(
              old.permission === rule.permission &&
              old.pattern === rule.pattern &&
              (update.type !== "removeRules" || old.action === rule.action)
            ),
        )
        if (update.type !== "removeRules") next.rules.push(rule)
      }
    }
  }
  return next
}
