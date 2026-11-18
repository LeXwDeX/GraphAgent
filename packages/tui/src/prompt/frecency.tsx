import path from "path"
import { onMount } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, readText, writeText } from "../util/persistence"

type FrecencyRecord = { frequency: number; lastOpen: number }
type FrecencyEntry = { path: string } & FrecencyRecord

export const MAX_FRECENCY_ENTRIES = 1000

export function parseFrecency(text: string) {
  const latest = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as FrecencyEntry
      } catch {
        return undefined
      }
    })
    .filter((line): line is FrecencyEntry => line !== undefined)
    .reduce<Record<string, FrecencyEntry>>((result, entry) => {
      result[entry.path] = entry
      return result
    }, {})
  return Object.values(latest)
    .sort((a, b) => b.lastOpen - a.lastOpen)
    .slice(0, MAX_FRECENCY_ENTRIES)
}

function calculateFrecency(entry?: { frequency: number; lastOpen: number }) {
  if (!entry) return 0
  return entry.frequency / (1 + (Date.now() - entry.lastOpen) / 86400000)
}

/**
 * The file's entries and what was recorded in memory while it was being read, one per path: the record with the later
 * `lastOpen` wins, and a tie goes to memory, the later write. Newest first, under the same limit as `parseFrecency`.
 */
function mergeLoaded(fromFile: readonly FrecencyEntry[], added: Readonly<Record<string, FrecencyRecord>>) {
  const latest = new Map(fromFile.map((entry) => [entry.path, entry]))
  for (const [entryPath, record] of Object.entries(added)) {
    const known = latest.get(entryPath)
    if (!known || record.lastOpen >= known.lastOpen)
      latest.set(entryPath, { path: entryPath, frequency: record.frequency, lastOpen: record.lastOpen })
  }
  return [...latest.values()].sort((a, b) => b.lastOpen - a.lastOpen).slice(0, MAX_FRECENCY_ENTRIES)
}

export const { use: useFrecency, provider: FrecencyProvider } = createSimpleContext({
  name: "Frecency",
  init: () => {
    const paths = useTuiPaths()
    const frecencyPath = path.join(paths.state, "frecency.jsonl")
    // Until the startup read lands, memory holds only what was recorded since mount, not the file's entries. Those
    // records stay out of the file: the load merges them with the file's entries and its rewrite persists them.
    let loaded = false
    onMount(async () => {
      const fromFile = parseFrecency(await readText(frecencyPath).catch(() => ""))
      // Read after the await: this is what was recorded while the read was in flight.
      const lines = mergeLoaded(fromFile, unwrap(store.data))
      loaded = true
      setStore({
        data: Object.fromEntries(
          lines.map((entry) => [entry.path, { frequency: entry.frequency, lastOpen: entry.lastOpen }]),
        ),
      })
      if (lines.length > 0)
        writeText(frecencyPath, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n").catch(() => {})
    })

    const [store, setStore] = createStore({ data: {} as Record<string, FrecencyRecord> })

    function updateFrecency(filePath: string) {
      const absolutePath = path.resolve(paths.cwd, filePath)
      const newEntry = { frequency: (store.data[absolutePath]?.frequency || 0) + 1, lastOpen: Date.now() }
      setStore("data", absolutePath, newEntry)
      if (!loaded) return
      appendText(frecencyPath, JSON.stringify({ path: absolutePath, ...newEntry }) + "\n").catch(() => {})

      if (Object.keys(store.data).length <= MAX_FRECENCY_ENTRIES) return
      const sorted = Object.entries(store.data)
        .sort(([, a], [, b]) => b.lastOpen - a.lastOpen)
        .slice(0, MAX_FRECENCY_ENTRIES)
      setStore("data", Object.fromEntries(sorted))
      writeText(
        frecencyPath,
        sorted.map(([entryPath, entry]) => JSON.stringify({ path: entryPath, ...entry })).join("\n") + "\n",
      ).catch(() => {})
    }

    return {
      getFrecency: (filePath: string) => calculateFrecency(store.data[path.resolve(paths.cwd, filePath)]),
      updateFrecency,
      data: () => store.data,
    }
  },
})
