// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { usePromptRef } from "../context/prompt"
import { useRoute, type Route } from "../context/route"
import { useSync } from "../context/sync"
import { resolveRootSessionID, type AskSession } from "../ask/ask-queue"

interface PrefillRoute {
  readonly data: Route
  navigate(route: Route): void
}

interface PrefillSync {
  readonly data: { readonly session: readonly AskSession[] }
}

interface PrefillPrompt {
  appendTo(sessionID: string | undefined, text: string): void
}

export interface PrefillRootPromptInput {
  route: PrefillRoute
  sync: PrefillSync
  prompt: PrefillPrompt
}

/**
 * Navigate to the root session, append `text` to its draft (never replacing
 * it) and focus the input without submitting. Returns the root session id, or
 * undefined when no session route is active.
 */
export function prefillRootPrompt(text: string, input: PrefillRootPromptInput): string | undefined {
  const route = input.route.data
  if (route.type !== "session") return undefined
  const rootSessionID = resolveRootSessionID(input.sync.data.session, route.sessionID)
  if (rootSessionID !== route.sessionID) input.route.navigate({ type: "session", sessionID: rootSessionID })
  input.prompt.appendTo(rootSessionID, text)
  return rootSessionID
}

/** Context-bound prefill for subagent decisions; call in component setup. */
export function usePrefillRootPrompt() {
  const route = useRoute()
  const sync = useSync()
  const prompt = usePromptRef()
  return (text: string) => prefillRootPrompt(text, { route, sync, prompt })
}
