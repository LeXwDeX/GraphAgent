// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { PromptRef } from "../component/prompt"
import { t } from "../i18n"
import { TuiLog } from "../util/log"
import type { CommandRegistry, CommandScope, CommandSpec } from "./registry"

/** One palette row; suggested rows are duplicated with an `suggested:` id prefix. */
export interface PaletteOption {
  id: string
  title: string
  description?: string
  category: string
  footer?: string
  suggested: boolean
}

export interface PalettePrompt {
  readonly current: Pick<PromptRef, "set" | "focus"> | undefined
}

/**
 * Suggestion group shared by every palette scope. Suggestions are duplicated to
 * the top of the list until the user starts typing a filter.
 */
export function suggestedCommandIds(input: {
  scope: CommandScope
  hasSessions: boolean
  connected: boolean
}): ReadonlySet<string> {
  const ids = new Set<string>(["model.list"])
  if (input.hasSessions) ids.add("session.list")
  if (input.scope !== "home") ids.add("session.new")
  if (!input.connected) ids.add("provider.connect")
  return ids
}

export function paletteRows(options: readonly PaletteOption[]): PaletteOption[] {
  const suggestedCategory = t("command.category.suggested")
  return [
    ...options
      .filter((option) => option.suggested)
      .map((option) => ({
        ...option,
        id: `suggested:${option.id}`,
        category: suggestedCategory,
      })),
    ...options,
  ]
}

/** Resolves a suggested-row id back to the command id it duplicates. */
export function paletteCommandId(id: string): string {
  const prefix = "suggested:"
  return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

/**
 * Commands that take arguments prefill the prompt so the user can finish the
 * input; everything else runs through the registry. Builtin commands never
 * reach the model, and server commands submit through `session.command`.
 */
export function selectPaletteCommand(input: {
  registry: CommandRegistry
  spec: CommandSpec
  close: () => void
  prompt: PalettePrompt
  renameTitle?: string
}) {
  input.close()
  const name = input.spec.slash?.name
  const current = input.prompt.current
  if (name && input.spec.slash?.args !== "none" && current) {
    const text = input.spec.id === "session.rename" && input.renameTitle ? `/rename ${input.renameTitle}` : `/${name} `
    current.set({ input: text, parts: [] })
    current.focus()
    return
  }
  void input.registry.run(input.spec.id, { args: "", origin: "palette" }).catch((error) => {
    TuiLog.write("error", "Command failed", error)
  })
}
