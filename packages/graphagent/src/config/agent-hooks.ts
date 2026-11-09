// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export type AgentHookSource = "project" | "user" | "builtin"
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