import { Context } from "effect"
export * as SourceProvenance from "./source-provenance"

/** Loader-owned provenance. Public hook JSON cannot grant a source exemption. */
export interface Provenance {
  readonly origin: string
  readonly source: "project" | "user" | "plugin" | "builtin"
}
const agents = new WeakMap<object, Map<string, Provenance>>()
const skills = new WeakMap<object, Provenance>()
export function setAgent(owner: object, id: string, value: Provenance) {
  let current = agents.get(owner)
  if (!current) agents.set(owner, (current = new Map()))
  current.set(id, value)
}
export function agent(owner: object, id: string) {
  return agents.get(owner)?.get(id)
}
export function setSkill(info: object, value: Provenance) {
  skills.set(info, value)
}
export function skill(info: object) {
  return skills.get(info)
}

export const CurrentPlugin = Context.Reference<string | undefined>("@opencode/HookSourcePlugin", {
  defaultValue: () => undefined,
})
const skillSources = new WeakMap<object, Provenance>()
export function setSkillSource(source: object, value: Provenance) {
  skillSources.set(source, value)
}
export function skillSource(source: object) {
  return skillSources.get(source)
}
