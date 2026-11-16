// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { sessionTree } from "../../../src/cli/cmd/run/permission-tree"

/**
 * #1324: a non-interactive `run` answers permission requests for its whole
 * session tree. A DAG node or a task child asks as its own session, so the
 * run has to tell which sessions descend from the one it drives.
 */

/** A parent table stands in for `session.get(...).parentID`; every lookup is recorded. */
function lookups(parents: Record<string, string | undefined>) {
  const asked: string[] = []
  const parentOf = async (sessionID: string) => {
    asked.push(sessionID)
    if (!(sessionID in parents)) throw new Error(`session ${sessionID} not found`)
    return parents[sessionID]
  }
  return { asked, parentOf }
}

describe("run permission tree", () => {
  test("the session the run drives is in its tree without a lookup", async () => {
    const { asked, parentOf } = lookups({})
    const tree = sessionTree("ses_main", parentOf)
    expect(await tree.has("ses_main")).toBe(true)
    expect(asked).toEqual([])
  })

  test("a child and a grandchild belong to the tree", async () => {
    const { asked, parentOf } = lookups({ ses_node: "ses_main", ses_task: "ses_node" })
    const tree = sessionTree("ses_main", parentOf)
    expect(await tree.has("ses_node")).toBe(true)
    expect(await tree.has("ses_task")).toBe(true)
    // The grandchild reused what the child already settled.
    expect(asked).toEqual(["ses_node", "ses_task"])
  })

  test("an unrelated top-level session, or a branch that never reaches the root, does not", async () => {
    const { parentOf } = lookups({ ses_other: undefined, ses_other_child: "ses_other" })
    const tree = sessionTree("ses_main", parentOf)
    expect(await tree.has("ses_other")).toBe(false)
    expect(await tree.has("ses_other_child")).toBe(false)
  })

  test("a settled answer is remembered, so each session is looked up once", async () => {
    const { asked, parentOf } = lookups({ ses_node: "ses_main", ses_other: undefined })
    const tree = sessionTree("ses_main", parentOf)
    for (let i = 0; i < 3; i++) {
      expect(await tree.has("ses_node")).toBe(true)
      expect(await tree.has("ses_other")).toBe(false)
    }
    expect(asked).toEqual(["ses_node", "ses_other"])
  })

  test("a failed lookup is not an answer: the session is asked about again", async () => {
    const parents: Record<string, string | undefined> = {}
    const { asked, parentOf } = lookups(parents)
    const tree = sessionTree("ses_main", parentOf)

    // The row is not there yet: nothing is remembered, whatever the outcome.
    expect(await tree.has("ses_node")).toBe(false)
    expect(await tree.has("ses_deep")).toBe(false)

    parents.ses_node = "ses_main"
    parents.ses_deep = "ses_node"
    expect(await tree.has("ses_deep")).toBe(true)
    expect(await tree.has("ses_node")).toBe(true)
    expect(asked).toEqual(["ses_node", "ses_deep", "ses_deep", "ses_node"])
  })

  test("a failure in the middle of a chain leaves the whole chain unanswered", async () => {
    const parents: Record<string, string | undefined> = { ses_leaf: "ses_middle" }
    const { parentOf } = lookups(parents)
    const tree = sessionTree("ses_main", parentOf)
    expect(await tree.has("ses_leaf")).toBe(false)

    parents.ses_middle = "ses_main"
    expect(await tree.has("ses_leaf")).toBe(true)
  })

  test("a cycle of parents ends instead of looping", async () => {
    const { parentOf } = lookups({ ses_a: "ses_b", ses_b: "ses_a" })
    const tree = sessionTree("ses_main", parentOf)
    expect(await tree.has("ses_a")).toBe(false)
  })
})
