// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { childSessions, nextSibling, siblingPosition, siblingSessions } from "../../src/session/siblings"

function session(id: string, created: number, parentID?: string) {
  return { id, parentID, time: { created } }
}

const root = session("ses_root", 1)
// `ses_a` and `ses_b` were created at the same instant: only their ids can tell them apart.
const a = session("ses_a", 30, "ses_root")
const b = session("ses_b", 30, "ses_root")
const c = session("ses_c", 40, "ses_root")
const early = session("ses_z_early", 20, "ses_root")
// A second tree: its sub-agent must never show up among the siblings of the first.
const otherRoot = session("ses_other", 2)
const stranger = session("ses_stranger", 10, "ses_other")

// Stored out of order on purpose: `b` before `a`, the newest before the oldest, the strangers in between.
const everything = [root, c, b, otherRoot, stranger, early, a]

function ids(list: readonly { id: string }[]) {
  return list.map((item) => item.id)
}

test("siblings come oldest first, and by id when two were created at the same instant", () => {
  expect(ids(siblingSessions(everything, "ses_c"))).toEqual(["ses_z_early", "ses_a", "ses_b", "ses_c"])
})

test("the order does not depend on how the list is stored", () => {
  const expected = ids(siblingSessions(everything, "ses_a"))
  expect(ids(siblingSessions([...everything].reverse(), "ses_a"))).toEqual(expected)
  expect(ids(siblingSessions([...everything.slice(3), ...everything.slice(0, 3)], "ses_a"))).toEqual(expected)
  // Whichever sibling the question starts from, the sequence is the same one.
  for (const member of expected) expect(ids(siblingSessions(everything, member))).toEqual(expected)
})

test("sessions of another parent, and roots, are not siblings", () => {
  expect(ids(siblingSessions(everything, "ses_a"))).not.toContain("ses_stranger")
  expect(ids(siblingSessions(everything, "ses_a"))).not.toContain("ses_root")
  expect(ids(siblingSessions(everything, "ses_stranger"))).toEqual(["ses_stranger"])
})

test("a root session and an unknown session have no siblings", () => {
  expect(siblingSessions(everything, "ses_root")).toEqual([])
  expect(siblingSessions(everything, "ses_missing")).toEqual([])
  expect(siblingSessions([], "ses_a")).toEqual([])
})

test("the list handed in is left as it was", () => {
  const input = [...everything]
  siblingSessions(input, "ses_a")
  childSessions(input, "ses_root")
  expect(input).toEqual(everything)
})

test("the children of a parent are the oldest-first siblings of any of them", () => {
  expect(ids(childSessions(everything, "ses_root"))).toEqual(ids(siblingSessions(everything, "ses_b")))
  expect(childSessions(everything, "ses_a")).toEqual([])
  expect(childSessions(everything, "ses_missing")).toEqual([])
})

test("the next sibling wraps from the last to the first and the previous from the first to the last", () => {
  const siblings = siblingSessions(everything, "ses_a")
  expect(nextSibling(siblings, "ses_z_early", 1)?.id).toBe("ses_a")
  expect(nextSibling(siblings, "ses_a", 1)?.id).toBe("ses_b")
  expect(nextSibling(siblings, "ses_c", 1)?.id).toBe("ses_z_early")
  expect(nextSibling(siblings, "ses_z_early", -1)?.id).toBe("ses_c")
  expect(nextSibling(siblings, "ses_b", -1)?.id).toBe("ses_a")
  expect(nextSibling(siblings, "ses_c", -1)?.id).toBe("ses_b")
})

test("there is no next sibling for a lone session, an unknown id or an empty list", () => {
  expect(nextSibling([stranger], "ses_stranger", 1)).toBeUndefined()
  expect(nextSibling([stranger], "ses_stranger", -1)).toBeUndefined()
  expect(nextSibling([a, b], "ses_missing", 1)).toBeUndefined()
  expect(nextSibling([], "ses_a", 1)).toBeUndefined()
})

test("two siblings step to each other in both directions", () => {
  expect(nextSibling([a, b], "ses_a", 1)?.id).toBe("ses_b")
  expect(nextSibling([a, b], "ses_a", -1)?.id).toBe("ses_b")
  expect(nextSibling([a, b], "ses_b", 1)?.id).toBe("ses_a")
})

test("the position counts from one and agrees with the order walked", () => {
  const siblings = siblingSessions(everything, "ses_b")
  expect(siblingPosition(siblings, "ses_z_early")).toEqual({ index: 1, total: 4 })
  expect(siblingPosition(siblings, "ses_a")).toEqual({ index: 2, total: 4 })
  expect(siblingPosition(siblings, "ses_b")).toEqual({ index: 3, total: 4 })
  expect(siblingPosition(siblings, "ses_c")).toEqual({ index: 4, total: 4 })
  expect(siblingPosition(siblings, "ses_missing")).toBeUndefined()
  expect(siblingPosition([], "ses_a")).toBeUndefined()
  // Stepping forward lands on the next position, wrapping to 1 after the last.
  const walked = [siblings[0]]
  for (let step = 0; step < siblings.length; step++) walked.push(nextSibling(siblings, walked.at(-1)!.id, 1)!)
  expect(walked.map((item) => siblingPosition(siblings, item.id)!.index)).toEqual([1, 2, 3, 4, 1])
})
