// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest } from "@graphagent/sdk"
import {
  askRequestID,
  askSourceLabel,
  askSessionID,
  collectAskQueue,
  resolveRootSessionID,
  sessionTree,
  type AskQueueData,
} from "../../src/ask/ask-queue"

function permission(id: string, sessionID: string): PermissionRequest {
  return {
    id,
    sessionID,
    permission: "bash",
    patterns: ["*"],
    metadata: {},
    always: [],
  }
}

function question(id: string, sessionID: string): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [{ question: "Pick one", header: "Pick", options: [{ label: "A", description: "" }] }],
  }
}

const sessions = [
  { id: "root", title: "Root" },
  { id: "child", parentID: "root", title: "Child" },
  { id: "grandchild", parentID: "child", title: "Grandchild" },
  { id: "sibling", parentID: "root", title: "Sibling" },
  { id: "other-root", title: "Other" },
]

function data(): AskQueueData {
  return {
    session: sessions,
    permission: {
      root: [permission("per_000000000030", "root")],
      child: [permission("per_000000000010", "child")],
      grandchild: [permission("per_000000000040", "grandchild")],
      "other-root": [permission("per_000000000001", "other-root")],
    },
    question: {
      child: [question("que_000000000020", "child")],
      grandchild: [question("que_000000000050", "grandchild")],
    },
  }
}

describe("session tree resolution", () => {
  test("walks the parent chain from a grandchild to the root", () => {
    expect(resolveRootSessionID(sessions, "grandchild")).toBe("root")
    expect(resolveRootSessionID(sessions, "child")).toBe("root")
    expect(resolveRootSessionID(sessions, "root")).toBe("root")
  })

  test("collects root, children and grandchildren but no other tree", () => {
    expect(sessionTree(sessions, "root")).toEqual(["root", "child", "sibling", "grandchild"])
    expect(sessionTree(sessions, "other-root")).toEqual(["other-root"])
  })

  test("unknown sessions resolve to themselves", () => {
    expect(resolveRootSessionID(sessions, "missing")).toBe("missing")
    expect(sessionTree(sessions, "missing")).toEqual(["missing"])
  })
})

describe("ask queue aggregation", () => {
  test("aggregates the root, child and grandchild in creation order", () => {
    const queue = collectAskQueue(data(), "root")
    expect(queue.map(askRequestID)).toEqual([
      "per_000000000010",
      "que_000000000020",
      "per_000000000030",
      "per_000000000040",
      "que_000000000050",
    ])
    expect(queue.map(askSessionID)).toEqual(["child", "child", "root", "grandchild", "grandchild"])
    expect(queue.map((ask) => ask.kind)).toEqual(["permission", "question", "permission", "permission", "question"])
  })

  test("shows the same queue from the main session and every descendant view", () => {
    const fromRoot = collectAskQueue(data(), "root").map(askRequestID)
    expect(collectAskQueue(data(), "child").map(askRequestID)).toEqual(fromRoot)
    expect(collectAskQueue(data(), "grandchild").map(askRequestID)).toEqual(fromRoot)
    expect(collectAskQueue(data(), "sibling").map(askRequestID)).toEqual(fromRoot)
  })

  test("excludes other session trees and an empty session id", () => {
    expect(collectAskQueue(data(), "other-root").map(askRequestID)).toEqual(["per_000000000001"])
    expect(collectAskQueue(data(), "")).toEqual([])
  })

  test("answers with the request's own session id, not the viewed one", () => {
    for (const ask of collectAskQueue(data(), "grandchild")) {
      if (ask.kind === "permission") expect(ask.request.sessionID).toBe(ask.sessionID)
      if (ask.kind === "question") expect(ask.request.sessionID).toBe(ask.sessionID)
    }
  })

  test("sorts synthetic ids deterministically", () => {
    const synthetic: AskQueueData = {
      session: [{ id: "root" }],
      permission: { root: [permission("b", "root"), permission("per_000000000001", "root"), permission("a", "root")] },
      question: {},
    }
    expect(collectAskQueue(synthetic, "root").map(askRequestID)).toEqual(["a", "b", "per_000000000001"])
  })
})

describe("source labels", () => {
  test("uses the task index kind and description for subagent requests", () => {
    const label = askSourceLabel(
      {
        session: sessions,
        taskIndex: { grandchild: { kind: "explore", description: "scan destructive changes" } },
      },
      "grandchild",
      "root",
    )
    expect(label).toBe("explore · scan destructive changes")
  })

  test("falls back to the session title and hides the label for the viewed session", () => {
    expect(askSourceLabel({ session: sessions, taskIndex: {} }, "child", "root")).toBe("Child")
    expect(askSourceLabel({ session: sessions, taskIndex: {} }, "root", "root")).toBeUndefined()
  })
})
