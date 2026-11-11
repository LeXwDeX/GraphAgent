import path from "path"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { AgentPart, FilePart, TextPart } from "@graphagent/sdk"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, readText, writeText } from "../util/persistence"

export type PromptInfo = {
  input: string
  mode?: "normal" | "shell"
  /** Memory-only entry: recallable with the history keys, never persisted. */
  ephemeral?: boolean
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | Omit<AgentPart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

export const MAX_HISTORY_ENTRIES = 50

/** JSONL holds only ordinary entries; memory-only entries must never reach it. */
function persisted(entries: readonly PromptInfo[]) {
  return entries.filter((entry) => !entry.ephemeral)
}

function serialize(entries: readonly PromptInfo[]) {
  return entries.map((line) => JSON.stringify(line)).join("\n") + "\n"
}

export function parsePromptHistory(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as PromptInfo
      } catch {
        return undefined
      }
    })
    .filter((line): line is PromptInfo => line !== undefined)
    .slice(-MAX_HISTORY_ENTRIES)
}

export function isDuplicateEntry(previous: PromptInfo | undefined, next: PromptInfo): boolean {
  if (!previous) return false
  return JSON.stringify(previous) === JSON.stringify(next)
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const paths = useTuiPaths()
    const historyPath = path.join(paths.state, "prompt-history.jsonl")
    onMount(async () => {
      const lines = parsePromptHistory(await readText(historyPath).catch(() => ""))
      setStore("history", lines)

      // Rewrite valid retained entries to self-heal corruption and enforce the
      // limit. Memory-only entries never belong in the file.
      const retained = persisted(lines)
      if (retained.length > 0) writeText(historyPath, serialize(retained)).catch(() => {})
    })

    const [store, setStore] = createStore({
      index: 0,
      history: [] as PromptInfo[],
    })

    function appendEntry(item: PromptInfo, options: { persist: boolean; ephemeral?: boolean }) {
      const entry = structuredClone(unwrap(item))
      if (options.ephemeral) entry.ephemeral = true
      if (isDuplicateEntry(store.history.at(-1), entry)) {
        setStore("index", 0)
        return
      }
      let trimmed = false
      setStore(
        produce((draft) => {
          draft.history.push(entry)
          if (draft.history.length > MAX_HISTORY_ENTRIES) {
            draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
            trimmed = true
          }
          draft.index = 0
        }),
      )

      if (trimmed) {
        // An overflow rewrite only carries entries that exist on disk.
        writeText(historyPath, serialize(persisted(store.history))).catch(() => {})
        return
      }
      if (options.persist && !entry.ephemeral) appendText(historyPath, JSON.stringify(entry) + "\n").catch(() => {})
    }

    return {
      move(direction: 1 | -1, input: string) {
        if (!store.history.length) return undefined
        const current = store.history.at(store.index)
        if (!current) return undefined
        if (current.input !== input && input.length) return
        setStore(
          produce((draft) => {
            const next = store.index + direction
            if (Math.abs(next) > store.history.length) return
            if (next > 0) return
            draft.index = next
          }),
        )
        if (store.index === 0) return { input: "", parts: [] }
        return store.history.at(store.index)
      },
      append(item: PromptInfo) {
        appendEntry(item, { persist: true })
      },
      /**
       * Recallable with the arrow keys but kept out of `prompt-history.jsonl`,
       * so sensitive side questions never reach disk. Lost on exit.
       */
      appendEphemeral(item: PromptInfo) {
        appendEntry(item, { persist: false, ephemeral: true })
      },
    }
  },
})
