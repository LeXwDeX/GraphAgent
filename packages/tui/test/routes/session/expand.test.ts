// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createExpandables, toggleExpand, type ExpandTarget } from "../../../src/routes/session/expand"
import { createSessionViewState, type Row } from "../../../src/routes/session/rows"

function row(partID: string | undefined, kind: Row["kind"] = "tool"): Row {
  return { key: partID ? `part:${partID}` : "notice:msg", messageID: "msg", partID, kind, revision: 0 }
}

const foldable = (flag: ExpandTarget["flag"] = "expanded"): ExpandTarget => ({ flag, available: () => true })
const plain: ExpandTarget = { flag: "expanded", available: () => false }

/** Runs `body` inside a reactive root, the way a mounted block registers, and disposes the root afterwards. */
function inRoot<T>(body: () => T): T {
  return createRoot((dispose) => {
    try {
      return body()
    } finally {
      dispose()
    }
  })
}

test("opens the most recent folded block, and each press goes one block further back", () => {
  inRoot(() => {
    const expandables = createExpandables()
    const view = createSessionViewState()
    expandables.register("reasoning", foldable())
    expandables.register("bash", foldable())
    expandables.register("read", plain)
    const rows = [row("reasoning", "reasoning"), row("bash"), row("read"), row(undefined, "notice")]
    const open = (partID: string) => view.get(partID, "expanded")

    expect(toggleExpand(rows, expandables, view)).toBe("opened")
    expect([open("bash"), open("reasoning"), open("read")]).toEqual([true, false, false])

    expect(toggleExpand(rows, expandables, view)).toBe("opened")
    expect([open("bash"), open("reasoning"), open("read")]).toEqual([true, true, false])
  })
})

test("with every block open it closes the most recent one", () => {
  inRoot(() => {
    const expandables = createExpandables()
    const view = createSessionViewState()
    expandables.register("earlier", foldable())
    expandables.register("later", foldable())
    const rows = [row("earlier"), row("later")]

    toggleExpand(rows, expandables, view)
    toggleExpand(rows, expandables, view)
    expect([view.get("earlier", "expanded"), view.get("later", "expanded")]).toEqual([true, true])

    expect(toggleExpand(rows, expandables, view)).toBe("closed")
    expect([view.get("earlier", "expanded"), view.get("later", "expanded")]).toEqual([true, false])

    // The closed block is the most recent folded one again.
    expect(toggleExpand(rows, expandables, view)).toBe("opened")
    expect(view.get("later", "expanded")).toBe(true)
  })
})

test("a single block opens and closes with the same key", () => {
  inRoot(() => {
    const expandables = createExpandables()
    const view = createSessionViewState()
    expandables.register("bash", foldable())
    const rows = [row("bash")]

    expect(toggleExpand(rows, expandables, view)).toBe("opened")
    expect(view.get("bash", "expanded")).toBe(true)
    expect(toggleExpand(rows, expandables, view)).toBe("closed")
    expect(view.get("bash", "expanded")).toBe(false)
  })
})

test("a click and the key share the flag: a block opened by one is open for the other", () => {
  inRoot(() => {
    const expandables = createExpandables()
    const view = createSessionViewState()
    expandables.register("bash", foldable())
    const rows = [row("bash")]

    // What the click handler does: flip the flag from its current value.
    view.set("bash", "expanded", !view.get("bash", "expanded"))
    expect(view.get("bash", "expanded")).toBe(true)

    // Open by click, so the key finds nothing folded and closes it.
    expect(toggleExpand(rows, expandables, view)).toBe("closed")
    expect(view.get("bash", "expanded")).toBe(false)

    // Open by key, so a click closes it.
    toggleExpand(rows, expandables, view)
    view.set("bash", "expanded", !view.get("bash", "expanded"))
    expect(view.get("bash", "expanded")).toBe(false)
  })
})

test("follows the order of the transcript, not the order of registration", () => {
  inRoot(() => {
    const expandables = createExpandables()
    const view = createSessionViewState()
    // The later block registers first, as a windowed row that mounts again does.
    expandables.register("later", foldable())
    expandables.register("earlier", foldable())

    toggleExpand([row("earlier"), row("later")], expandables, view)
    expect(view.get("later", "expanded")).toBe(true)
    expect(view.get("earlier", "expanded")).toBe(false)
  })
})

test("does nothing when no block has anything to fold", () => {
  inRoot(() => {
    const expandables = createExpandables()
    const view = createSessionViewState()
    expandables.register("read", plain)
    const rows = [row("read"), row(undefined, "notice"), row("unregistered", "text")]

    expect(toggleExpand(rows, expandables, view)).toBeUndefined()
    expect(toggleExpand([], expandables, view)).toBeUndefined()
    expect(view.state().size).toBe(0)
  })
})

test("flips the flag the target names", () => {
  inRoot(() => {
    const expandables = createExpandables()
    const view = createSessionViewState()
    expandables.register("failed", foldable("errorExpanded"))

    toggleExpand([row("failed")], expandables, view)
    expect(view.get("failed", "errorExpanded")).toBe(true)
    expect(view.get("failed", "expanded")).toBe(false)
  })
})

test("reads availability when the key is pressed, so a block that gains output becomes a target", () => {
  inRoot(() => {
    const expandables = createExpandables()
    const view = createSessionViewState()
    const [overflow, setOverflow] = createSignal(false)
    expandables.register("bash", { flag: "expanded", available: overflow })
    const rows = [row("bash")]

    expect(toggleExpand(rows, expandables, view)).toBeUndefined()
    setOverflow(true)
    expect(toggleExpand(rows, expandables, view)).toBe("opened")
    expect(view.get("bash", "expanded")).toBe(true)
  })
})

test("a part can hold several targets and the available one is used", () => {
  inRoot(() => {
    const expandables = createExpandables()
    const view = createSessionViewState()
    // A bash call before and after its output arrives: the block (no overflow yet) and the failed one-liner.
    expandables.register("bash", plain)
    expandables.register("bash", foldable("errorExpanded"))

    toggleExpand([row("bash")], expandables, view)
    expect(view.get("bash", "errorExpanded")).toBe(true)
    expect(view.get("bash", "expanded")).toBe(false)
  })
})

test("a target leaves with the component that registered it", () => {
  const expandables = createExpandables()
  const view = createSessionViewState()
  const rows = [row("bash")]

  const disposeOuter = createRoot((dispose) => {
    expandables.register("bash", foldable())
    return dispose
  })
  const disposeInner = createRoot((dispose) => {
    expandables.register("bash", foldable("errorExpanded"))
    return dispose
  })

  // Both are available and the first registered wins.
  expect(expandables.availableFor("bash")?.flag).toBe("expanded")
  disposeOuter()
  expect(expandables.availableFor("bash")?.flag).toBe("errorExpanded")
  disposeInner()
  expect(expandables.availableFor("bash")).toBeUndefined()
  expect(toggleExpand(rows, expandables, view)).toBeUndefined()
})
