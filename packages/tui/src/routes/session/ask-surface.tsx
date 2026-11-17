// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, createSignal, type Accessor } from "solid-js"
import { useRoute } from "../../context/route"
import { useSync } from "../../context/sync"
import { askQueue, askRequestID, resolveRootSessionID, type AskRequest } from "../../ask/ask-queue"
import type { AskRequest as BottomAskRequest } from "../../shell/bottom-zone"
import { usePrefillRootPrompt } from "../../session/prefill"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { ChoiceAskPrompt, ConfirmAskPrompt } from "../../ask/local"

export interface AskSurfaceProps {
  ask: AskRequest
  /** Session being viewed; source labels compare against it. */
  currentSessionID: string
  /** Root of the queue's session tree. */
  rootSessionID: string
  /** 1-based position in the shared ask queue. */
  position: number
  total: number
  /** Appends relay text to the root draft without submitting it. */
  prefill?: (text: string) => void
}

/** Routes one queue entry to the permission, question, or local surface. */
export function AskSurface(props: AskSurfaceProps) {
  const sync = useSync()

  if (props.ask.kind === "permission") {
    return (
      <PermissionPrompt
        request={props.ask.request}
        currentSessionID={props.currentSessionID}
        rootSessionID={props.rootSessionID}
        position={props.position}
        total={props.total}
        directory={sync.session.get(props.ask.sessionID)?.directory}
        prefill={props.prefill}
      />
    )
  }

  if (props.ask.kind === "question") {
    return (
      <QuestionPrompt
        request={props.ask.request}
        currentSessionID={props.currentSessionID}
        rootSessionID={props.rootSessionID}
        position={props.position}
        total={props.total}
        directory={sync.session.get(props.ask.sessionID)?.directory}
      />
    )
  }

  if (props.ask.kind === "confirm") return <ConfirmAskPrompt ask={props.ask} />
  return <ChoiceAskPrompt ask={props.ask} />
}

/**
 * Bottom-zone entries for the permission and question stores in the current
 * session tree. The route calls this once and mirrors the result through
 * `setAsk`; confirm/choice entries stay in the bottom zone's local queue.
 */
export function useAskSurfaceRequests(): Accessor<readonly BottomAskRequest[]> {
  const route = useRoute()
  const sync = useSync()
  const prefill = usePrefillRootPrompt()
  const queue = askQueue(() => (route.data.type === "session" ? route.data.sessionID : ""))
  // Entries keep their identity while they stay in the queue. The bottom zone
  // renders the head with `<Show keyed>`, so replacing every entry when the
  // store changes would remount an open permission editor or question draft.
  const entries = new Map<string, { entry: BottomAskRequest; update(props: AskSurfaceProps): void }>()

  return createMemo(() => {
    const current = route.data
    if (current.type !== "session") {
      entries.clear()
      return []
    }
    const rootSessionID = resolveRootSessionID(sync.data.session, current.sessionID)
    const requests = queue()
    const active = new Set<string>()
    const result = requests.map((ask, index) => {
      const key = `${ask.kind}:${askRequestID(ask)}`
      active.add(key)
      const next: AskSurfaceProps = {
        ask,
        currentSessionID: current.sessionID,
        rootSessionID,
        position: index + 1,
        total: requests.length,
        prefill,
      }
      const cached = entries.get(key)
      if (cached) {
        cached.update(next)
        return cached.entry
      }
      const [state, update] = createSignal(next)
      const entry: BottomAskRequest = { id: askRequestID(ask), render: () => <AskSurface {...state()} /> }
      entries.set(key, { entry, update })
      return entry
    })
    for (const key of entries.keys()) if (!active.has(key)) entries.delete(key)
    return result
  })
}
