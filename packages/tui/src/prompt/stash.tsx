import path from "path"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, readText, writeText } from "../util/persistence"
import type { PromptInfo } from "./history"

export type StashEntry = {
  input: string
  parts: PromptInfo["parts"]
  timestamp: number
}

export const MAX_STASH_ENTRIES = 50

function serialize(entries: readonly StashEntry[]) {
  return entries.map((line) => JSON.stringify(line)).join("\n") + "\n"
}

export function parsePromptStash(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as StashEntry
      } catch {
        return undefined
      }
    })
    .filter((line): line is StashEntry => line !== undefined)
    .slice(-MAX_STASH_ENTRIES)
}

/** The file's entries, then what changed in memory while it was being read, newest kept under the limit. */
function mergeLoaded(fromFile: readonly StashEntry[], added: readonly StashEntry[]) {
  return [...fromFile, ...added].slice(-MAX_STASH_ENTRIES)
}

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  init: () => {
    const paths = useTuiPaths()
    const stashPath = path.join(paths.state, "prompt-stash.jsonl")
    // Until the startup read lands, memory holds only what changed since mount, not the stash. Those changes stay out
    // of the file: a rewrite from here would replace entries that were never read, and an append could be read back by
    // the load and merged a second time. The load merges them behind the file's entries and its rewrite persists them.
    let loaded = false
    onMount(async () => {
      const fromFile = parsePromptStash(await readText(stashPath).catch(() => ""))
      // Read after the await: this is what changed while the read was in flight.
      const entries = mergeLoaded(fromFile, unwrap(store.entries))
      loaded = true
      setStore("entries", entries)
      if (entries.length > 0) writeText(stashPath, serialize(entries)).catch(() => {})
    })

    const [store, setStore] = createStore({ entries: [] as StashEntry[] })

    return {
      list() {
        return store.entries
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: Date.now() }))
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.entries.push(stash)
            if (draft.entries.length > MAX_STASH_ENTRIES) {
              draft.entries = draft.entries.slice(-MAX_STASH_ENTRIES)
              trimmed = true
            }
          }),
        )

        if (!loaded) return
        if (trimmed) {
          writeText(stashPath, serialize(store.entries)).catch(() => {})
          return
        }
        appendText(stashPath, JSON.stringify(stash) + "\n").catch(() => {})
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[store.entries.length - 1]
        setStore(produce((draft) => void draft.entries.pop()))
        if (loaded) writeText(stashPath, store.entries.length > 0 ? serialize(store.entries) : "").catch(() => {})
        return entry
      },
      remove(index: number) {
        if (index < 0 || index >= store.entries.length) return
        setStore(produce((draft) => void draft.entries.splice(index, 1)))
        if (loaded) writeText(stashPath, store.entries.length > 0 ? serialize(store.entries) : "").catch(() => {})
      },
    }
  },
})
