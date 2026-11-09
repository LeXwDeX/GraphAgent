import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"

interface PendingAppend {
  sessionID?: string
  text: string
}

export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    let current: PromptRef | undefined
    let currentSessionID: string | undefined
    // Appends requested while the target prompt is unmounted (for example
    // before a navigation settles) are applied as soon as it binds.
    const pending: PendingAppend[] = []

    function flush() {
      if (!current) return
      for (let index = 0; index < pending.length;) {
        const item = pending[index]
        if (item.sessionID !== undefined && item.sessionID !== currentSessionID) {
          index += 1
          continue
        }
        pending.splice(index, 1)
        current.append(item.text)
      }
    }

    return {
      get current() {
        return current
      },
      set(ref: PromptRef | undefined, sessionID?: string) {
        current = ref
        currentSessionID = ref ? sessionID : undefined
        flush()
      },
      /** Append text to a session's draft without overwriting it or submitting. */
      appendTo(sessionID: string | undefined, text: string) {
        if (!text) return
        pending.push({ sessionID, text })
        flush()
      },
    }
  },
})
