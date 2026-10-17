import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
export type AgentHookSource = "project" | "user" | "plugin" | "builtin"
export interface AgentHookProvenance {
  source: AgentHookSource
  origin: string
}
const origins = new WeakMap<object, Map<string, AgentHookProvenance>>()
export function agentHookProvenance(config: object, name: string) {
  return origins.get(config)?.get(name)
}
export function setAgentHookOrigins(config: object, values: Map<string, AgentHookProvenance>) {
  origins.set(config, values)
}
export function snapshotAgentHooks(config: ConfigV1.Info) {
  return new Map(Object.entries(config.agent ?? {}).map(([name, agent]) => [name, JSON.stringify(agent.hooks)]))
}
/** Called only around an already-authorized plugin callback, never from config fields. */
export function recordPluginAgentHooks(config: ConfigV1.Info, before: Map<string, string | undefined>, origin: string) {
  let values = origins.get(config)
  if (!values) origins.set(config, (values = new Map()))
  for (const [name, agent] of Object.entries(config.agent ?? {})) {
    if (agent.hooks !== undefined && JSON.stringify(agent.hooks) !== before.get(name))
      values.set(name, { source: "plugin", origin })
  }
}
