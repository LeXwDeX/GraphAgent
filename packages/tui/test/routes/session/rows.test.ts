// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStreamBuffer } from "../../../src/context/stream-buffer"
import {
  createRowMeasurements,
  createSessionViewState,
  createTextFacts,
  estimateRowHeight,
  firstVisible,
  isWindowed,
  lastVisible,
  longestLine,
  prefixPositions,
  rowRevision,
  settledPartText,
  stableRows,
  visibleRange,
  WINDOW_MIN_ROWS,
  type Row,
} from "../../../src/routes/session/rows"

const row = (key: string, kind: Row["kind"] = "text", revision = 1): Row => ({
  key,
  messageID: `msg-${key}`,
  partID: `part-${key}`,
  kind,
  revision,
})

describe("isWindowed", () => {
  test("windows a transcript from WINDOW_MIN_ROWS rows and mounts every row below it", () => {
    expect(isWindowed(WINDOW_MIN_ROWS - 1)).toBe(false)
    expect(isWindowed(WINDOW_MIN_ROWS)).toBe(true)
    expect(isWindowed(0)).toBe(false)
  })

  test("leaves the sessions a reader meets in practice fully mounted", () => {
    // On 0.8.3 the native scroll box culls what is off screen: a fully mounted
    // transcript of a few hundred rows types and scrolls faster than a windowed one.
    expect(WINDOW_MIN_ROWS).toBe(2000)
    expect(isWindowed(190)).toBe(false)
  })
})

describe("prefixPositions", () => {
  test("accumulates clamped row heights", () => {
    const rows = [row("a"), row("b"), row("c")]
    expect(prefixPositions(rows, () => 3)).toEqual([0, 3, 6, 9])
    expect(prefixPositions(rows, () => 0)).toEqual([0, 1, 2, 3])
  })

  test("keeps an empty table as a single origin", () => {
    expect(prefixPositions([], () => 5)).toEqual([0])
  })
})

describe("visibleRange", () => {
  const positions = [0, 10, 20, 30, 40, 50]

  test("selects the rows intersecting the viewport", () => {
    expect(visibleRange(positions, 12, 20)).toEqual({ first: 1, last: 3 })
  })

  test("clamps a negative or overscrolled top", () => {
    expect(visibleRange(positions, -50, 15)).toEqual({ first: 0, last: 1 })
    expect(visibleRange(positions, 500, 10)).toEqual({ first: 4, last: 4 })
  })

  test("handles an empty table", () => {
    expect(visibleRange([0], 0, 10)).toEqual({ first: 0, last: -1 })
  })
})

describe("firstVisible and lastVisible", () => {
  const positions = [0, 10, 20, 30, 40]

  test("firstVisible finds the row whose bottom passes the top", () => {
    expect(firstVisible(positions, 0)).toBe(0)
    expect(firstVisible(positions, 9)).toBe(0)
    expect(firstVisible(positions, 10)).toBe(1)
    expect(firstVisible(positions, 41)).toBe(3)
  })

  test("lastVisible never precedes the first visible row", () => {
    expect(lastVisible(positions, 0)).toBe(0)
    expect(lastVisible(positions, 15)).toBe(1)
    expect(lastVisible(positions, 40)).toBe(3)
  })
})

describe("estimateRowHeight", () => {
  test("wraps content by available width", () => {
    expect(estimateRowHeight(row("a", "text"), 13, 10)).toBe(2)
    expect(estimateRowHeight(row("a", "text"), 13, 25)).toBe(4)
    expect(estimateRowHeight(row("a", "user"), 13, 10)).toBe(4)
  })

  test("collapses expandable rows until expanded", () => {
    expect(estimateRowHeight(row("a", "tool"), 40, 0)).toBe(2)
    expect(estimateRowHeight(row("a", "tool"), 40, 10, true)).toBe(4)
    expect(estimateRowHeight(row("a", "reasoning"), 40, 39)).toBe(2)
  })

  test("uses fixed heights for metadata rows", () => {
    expect(estimateRowHeight(row("a", "meta"), 40, 0)).toBe(2)
    expect(estimateRowHeight(row("a", "notice"), 40, 0)).toBe(2)
    expect(estimateRowHeight(row("a", "revert"), 40, 0)).toBe(5)
  })
})

describe("rowRevision", () => {
  test("is stable for equal values and changes with any field", () => {
    expect(rowRevision("abc", 1, true)).toBe(rowRevision("abc", 1, true))
    expect(rowRevision("abc", 1, true)).not.toBe(rowRevision("abc", 1, false))
    expect(rowRevision("abc", 1)).not.toBe(rowRevision("abd", 1))
  })
})

describe("longestLine", () => {
  // The height estimate used to take `Math.max(1, ...text.split("\n").map((line) => line.length))`.
  const reference = (text: string) => Math.max(1, ...text.split("\n").map((line) => line.length))

  test("is the width of the longest line, at least 1", () => {
    for (const text of [
      "",
      "a",
      "abc",
      "ab\ncdef\ng",
      "\n\n",
      "tail\n",
      "\nhead",
      "crlf\r\nlonger line\r\n",
      "一二三\nabc",
    ]) {
      expect(longestLine(text)).toBe(reference(text))
    }
    expect(longestLine("")).toBe(1)
    expect(longestLine("ab\ncdef\ng")).toBe(4)
  })

  test("walks a text of hundreds of thousands of lines without splitting it", () => {
    const text = "x\n".repeat(300_000) + "tail"
    expect(longestLine(text)).toBe(4)
    expect(longestLine(text)).toBe(reference(text))
  })
})

describe("settledPartText", () => {
  // The rule is `StreamBuffer.read` of a part with nothing buffered: the two readers must not drift apart.
  const parts = [
    { id: "t1", type: "text", text: "plain" },
    { id: "t2", type: "text", text: "raw", displayText: "shown by a hook" },
    { id: "t3", type: "text", text: "raw", displayText: "" },
    { id: "t4", type: "text" },
    { id: "r1", type: "reasoning", text: "thinking" },
    { id: "r2", type: "reasoning" },
  ]

  test("reads what the stream buffer reads for a part with nothing buffered", () => {
    const stream = createStreamBuffer()
    for (const part of parts) expect(settledPartText(part)).toBe(stream.read(part))
    expect(settledPartText(parts[1])).toBe("shown by a hook")
    expect(settledPartText(parts[3])).toBe("")
  })

  test("leaves out what a part that is still being written has buffered", () => {
    const stream = createStreamBuffer()
    stream.append("t1", "text", " and more")
    expect(stream.read(parts[0])).toBe("plain and more")
    expect(settledPartText(parts[0])).toBe("plain")
  })
})

describe("createTextFacts", () => {
  const counted = () => {
    const calls: string[] = []
    const normalize = (raw: string) => {
      calls.push(raw)
      return raw.trim()
    }
    return { calls, normalize }
  }

  test("derives the facts of a part once per distinct text", () => {
    const facts = createTextFacts()
    const { calls, normalize } = counted()

    const first = facts.read("p1", "  one\ntwo words  ", normalize)
    expect(first.text).toBe("one\ntwo words")
    expect(first.chars).toBe(9)

    // The same text again, however many times, is the entry that was kept.
    for (let call = 0; call < 50; call++) expect(facts.read("p1", "  one\ntwo words  ", normalize)).toBe(first)
    expect(calls).toHaveLength(1)

    // Another text derives again, and so does another part with the same text.
    expect(facts.read("p1", "one\ntwo words and more", normalize).chars).toBe(18)
    facts.read("p2", "one\ntwo words and more", normalize)
    expect(calls).toHaveLength(3)
  })

  test("hashes the body on first use and keeps the hash", () => {
    const facts = createTextFacts()
    const entry = facts.read("p1", " body ", (raw) => raw.trim())

    expect(entry.hash()).toBe(rowRevision("body"))
    expect(entry.hash()).toBe(entry.hash())
    expect(facts.read("p1", " body ", (raw) => raw.trim()).hash()).toBe(rowRevision("body"))
  })

  test("forgets the parts that are not live, and derives them again when they come back", () => {
    const facts = createTextFacts()
    const { calls, normalize } = counted()
    facts.read("kept", "a", normalize)
    facts.read("gone", "b", normalize)
    expect(facts.size).toBe(2)

    facts.retain(new Set(["kept"]))

    expect(facts.size).toBe(1)
    facts.read("kept", "a", normalize)
    expect(calls).toHaveLength(2)
    facts.read("gone", "b", normalize)
    expect(calls).toHaveLength(3)
  })
})

describe("stableRows", () => {
  test("reuses rows whose kind and revision did not change", () => {
    const first = row("a")
    const previous = new Map([[first.key, first]])
    const changed = row("a", "text", 2)
    const added = row("b")
    const result = stableRows(previous, [changed, added])
    expect(result.rows[0]).toBe(changed)
    expect(result.rows[1]).toBe(added)
    expect(result.byKey.get("a")).toBe(changed)
  })
})

describe("createRowMeasurements", () => {
  test("invalidates measurements on revision or width changes", () => {
    const measurements = createRowMeasurements()
    expect(measurements.get("a", 1, 80)).toBeUndefined()
    measurements.report("a", 1, 80, 7)
    expect(measurements.get("a", 1, 80)).toBe(7)
    expect(measurements.get("a", 2, 80)).toBeUndefined()
    expect(measurements.get("a", 1, 90)).toBeUndefined()
    measurements.clear()
    expect(measurements.get("a", 1, 80)).toBeUndefined()
  })

  test("bumps the version only when a measurement actually changes", () => {
    const measurements = createRowMeasurements()
    const initial = measurements.version()
    measurements.report("a", 1, 80, 7)
    const after = measurements.version()
    expect(after).toBeGreaterThan(initial)
    measurements.report("a", 1, 80, 7)
    expect(measurements.version()).toBe(after)
  })
})

describe("createSessionViewState", () => {
  test("stores flags per part and ignores missing ids", () =>
    createRoot((dispose) => {
      const view = createSessionViewState()
      expect(view.get("p1", "expanded")).toBe(false)
      view.set("p1", "expanded", true)
      view.set("p1", "errorExpanded", true)
      expect(view.get("p1", "expanded")).toBe(true)
      expect(view.get("p1", "errorExpanded")).toBe(true)
      expect(view.get("p2", "expanded")).toBe(false)
      view.set("p1", "expanded", false)
      expect(view.get("p1", "expanded")).toBe(false)
      view.set(undefined, "expanded", true)
      expect(view.state().size).toBe(1)
      dispose()
    }))
})
