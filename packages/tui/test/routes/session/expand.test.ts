// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { toggleExpand } from "../../../src/routes/session/expand"
import { createSessionViewState, type Row, type ViewFlag } from "../../../src/routes/session/rows"

function row(partID: string | undefined, kind: Row["kind"] = "tool"): Row {
  return { key: partID ? `part:${partID}` : "notice:msg", messageID: "msg", partID, kind, revision: 0 }
}

/** `foldOf` over a table: a part folds under the flag the table gives it, and parts the table lacks do not fold. */
function folds(table: Record<string, ViewFlag | undefined>) {
  return (item: Row) => (item.partID ? table[item.partID] : undefined)
}

const open = (view: ReturnType<typeof createSessionViewState>, partID: string) => view.get(partID, "expanded")

test("opens the most recent folded block, and each press goes one block further back", () => {
  const view = createSessionViewState()
  const foldOf = folds({ reasoning: "expanded", bash: "expanded" })
  const rows = [row("reasoning", "reasoning"), row("bash"), row("read"), row(undefined, "notice")]

  expect(toggleExpand(rows, foldOf, view)).toBe("opened")
  expect([open(view, "bash"), open(view, "reasoning"), open(view, "read")]).toEqual([true, false, false])

  expect(toggleExpand(rows, foldOf, view)).toBe("opened")
  expect([open(view, "bash"), open(view, "reasoning"), open(view, "read")]).toEqual([true, true, false])
})

test("with every block open it closes the most recent one", () => {
  const view = createSessionViewState()
  const foldOf = folds({ earlier: "expanded", later: "expanded" })
  const rows = [row("earlier"), row("later")]

  toggleExpand(rows, foldOf, view)
  toggleExpand(rows, foldOf, view)
  expect([open(view, "earlier"), open(view, "later")]).toEqual([true, true])

  expect(toggleExpand(rows, foldOf, view)).toBe("closed")
  expect([open(view, "earlier"), open(view, "later")]).toEqual([true, false])

  // The closed block is the most recent folded one again.
  expect(toggleExpand(rows, foldOf, view)).toBe("opened")
  expect(open(view, "later")).toBe(true)
})

test("a single block opens and closes with the same key", () => {
  const view = createSessionViewState()
  const foldOf = folds({ bash: "expanded" })
  const rows = [row("bash")]

  expect(toggleExpand(rows, foldOf, view)).toBe("opened")
  expect(open(view, "bash")).toBe(true)
  expect(toggleExpand(rows, foldOf, view)).toBe("closed")
  expect(open(view, "bash")).toBe(false)
})

test("a click and the key share the flag: a block opened by one is open for the other", () => {
  const view = createSessionViewState()
  const foldOf = folds({ bash: "expanded" })
  const rows = [row("bash")]

  // What the click handler does: flip the flag from its current value.
  view.set("bash", "expanded", !view.get("bash", "expanded"))
  expect(open(view, "bash")).toBe(true)

  // Open by click, so the key finds nothing folded and closes it.
  expect(toggleExpand(rows, foldOf, view)).toBe("closed")
  expect(open(view, "bash")).toBe(false)

  // Open by key, so a click closes it.
  toggleExpand(rows, foldOf, view)
  view.set("bash", "expanded", !view.get("bash", "expanded"))
  expect(open(view, "bash")).toBe(false)
})

test("follows the order of the transcript", () => {
  const view = createSessionViewState()
  // The table lists the later block first: its order is no part of the answer.
  const foldOf = folds({ later: "expanded", earlier: "expanded" })

  toggleExpand([row("earlier"), row("later")], foldOf, view)
  expect(open(view, "later")).toBe(true)
  expect(open(view, "earlier")).toBe(false)
})

test("does nothing when no block has anything to fold", () => {
  const view = createSessionViewState()
  const foldOf = folds({})
  const rows = [row("read"), row(undefined, "notice"), row("unregistered", "text")]

  expect(toggleExpand(rows, foldOf, view)).toBeUndefined()
  expect(toggleExpand([], foldOf, view)).toBeUndefined()
  expect(view.state().size).toBe(0)
})

test("flips the flag the part folds under", () => {
  const view = createSessionViewState()

  toggleExpand([row("failed")], folds({ failed: "errorExpanded" }), view)
  expect(view.get("failed", "errorExpanded")).toBe(true)
  expect(view.get("failed", "expanded")).toBe(false)
})

test("reads what folds when the key is pressed, so a block that gains output becomes a target", () => {
  const view = createSessionViewState()
  const table: Record<string, ViewFlag | undefined> = {}
  const foldOf = folds(table)
  const rows = [row("bash")]

  expect(toggleExpand(rows, foldOf, view)).toBeUndefined()
  table.bash = "expanded"
  expect(toggleExpand(rows, foldOf, view)).toBe("opened")
  expect(open(view, "bash")).toBe(true)
})

test("stops at the first folded block, so a press reads a few parts and not the whole transcript", () => {
  const view = createSessionViewState()
  const rows = Array.from({ length: 5000 }, (_, index) => row(`part-${index}`))
  const read: string[] = []
  const foldOf = (item: Row) => {
    read.push(item.partID!)
    return "expanded" as const
  }

  toggleExpand(rows, foldOf, view)
  expect(read).toEqual(["part-4999"])

  // The next press passes the open one and stops at the one before it.
  read.length = 0
  toggleExpand(rows, foldOf, view)
  expect(read).toEqual(["part-4999", "part-4998"])
})

test("with every block open the press reads every row once and closes the latest", () => {
  const view = createSessionViewState()
  const rows = Array.from({ length: 50 }, (_, index) => row(`part-${index}`))
  const foldOf = () => "expanded" as const
  for (let press = 0; press < rows.length; press++) toggleExpand(rows, foldOf, view)
  expect(rows.every((item) => open(view, item.partID!))).toBe(true)

  let reads = 0
  const counted = () => {
    reads++
    return foldOf()
  }
  expect(toggleExpand(rows, counted, view)).toBe("closed")
  expect(reads).toBe(rows.length)
  expect(open(view, "part-49")).toBe(false)
  expect(open(view, "part-48")).toBe(true)
})
