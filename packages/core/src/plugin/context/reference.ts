import type { Reference } from "@graphagent/schema/reference"
import type { Hooks } from "./registration"

export interface ReferenceDraft {
  add(name: string, source: Reference.LocalSource | Reference.GitSource): void
  remove(name: string): void
  list(): readonly (readonly [string, Reference.LocalSource | Reference.GitSource])[]
}

export type ReferenceHooks = Hooks<{
  transform: ReferenceDraft
}>
