// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { createSummary, type SessionSummary } from "../../src/context/session-summary"
import { setLanguage } from "../../src/i18n"
import { childSessions } from "../../src/session/siblings"
import {
  SUBAGENT_MARKER_GLYPH,
  delegatedPrompt,
  subagentDescription,
  subagentElapsed,
  subagentKind,
  subagentMarker,
  subagentMarkerToken,
  subagentRelayText,
  subagentRows,
  subagentTitle,
  subagentTrail,
  type SubagentRowSource,
  type SubagentSessionInfo,
} from "../../src/session/subagents"

afterEach(() => {
  setLanguage("zh-CN")
})

function session(id: string, extra: Partial<SubagentSessionInfo> & { time?: SubagentSessionInfo["time"] } = {}) {
  return { id, title: id, time: { created: 1, updated: 2 }, ...extra } satisfies SubagentSessionInfo
}

function lookup(
  tasks: Record<string, { kind?: string; description?: string }> = {},
  summaries: Record<string, SessionSummary> = {},
): SubagentRowSource {
  return { task: (id) => tasks[id], summary: (id) => summaries[id] }
}

describe("kind and description", () => {
  // The top bar and the list read both from here, so these are the rules of both.
  test("kind comes from the session, then the parent's Task input, then the title, then plain agent", () => {
    const titled = { title: "scan (@general subagent)" }
    expect(subagentKind({ ...titled, agent: "explore" }, { kind: "plan" })).toBe("explore")
    expect(subagentKind(titled, { kind: "plan" })).toBe("plan")
    expect(subagentKind(titled)).toBe("general")
    expect(subagentKind({ title: "scan (@code-explorer subagent)" })).toBe("code-explorer")
    expect(subagentKind({ title: "scan (DAG node)" })).toBe("agent")
    expect(subagentKind({ title: "" })).toBe("agent")
    // Blank values do not count as an answer.
    expect(subagentKind({ ...titled, agent: "  " }, { kind: "" })).toBe("general")
    // A remote string cannot restyle the terminal.
    expect(subagentKind({ title: "scan", agent: "ex\u001b[31mplore\u0007" })).toBe("explore")
  })

  test("description comes from the Task input, else from the title without its subagent tail", () => {
    expect(subagentDescription({ title: "title text (@explore subagent)" }, { description: "from the task" })).toBe(
      "from the task",
    )
    expect(subagentDescription({ title: "scan the repo (@explore subagent)" })).toBe("scan the repo")
    expect(subagentDescription({ title: "scan the repo (@code-explorer subagent)" }, { description: " " })).toBe(
      "scan the repo",
    )
    expect(subagentDescription({ title: "build step (DAG node)" })).toBe("build step (DAG node)")
    expect(subagentDescription({ title: "(@explore subagent)" })).toBe("")
    expect(subagentDescription({ title: "x" }, { description: "two\nlines" })).toBe("two lines")
    expect(subagentDescription({ title: "x" }, { description: "scan\nall\u0007 files" })).toBe("scan all files")
  })
})

describe("the marker", () => {
  test("follows the summary: running while busy or retrying, failed with an error, done when idle", () => {
    expect(subagentMarker({ status: "busy" })).toBe("running")
    expect(subagentMarker({ status: "retry" })).toBe("running")
    // An error left from an earlier turn does not hide that the session runs again.
    expect(subagentMarker({ status: "busy", error: "boom" })).toBe("running")
    expect(subagentMarker({ status: "retry", error: "boom" })).toBe("running")
    expect(subagentMarker({ status: "idle", error: "boom" })).toBe("failed")
    expect(subagentMarker({ status: "idle" })).toBe("done")
  })

  test("is none while no status was ever reported, which is every session after a restart", () => {
    expect(subagentMarker({ status: "unknown" })).toBeUndefined()
    expect(subagentMarker(undefined)).toBeUndefined()
    // A failure that is known is not hidden by the status being unknown.
    expect(subagentMarker({ status: "unknown", error: "boom" })).toBe("failed")
  })

  test("is one glyph and one theme token each; a finished one is the grey success token, not a brand color", () => {
    expect(SUBAGENT_MARKER_GLYPH).toEqual({ running: "●", failed: "✗", done: "✓" })
    expect(subagentMarkerToken("running")).toBe("primary")
    expect(subagentMarkerToken("failed")).toBe("error")
    expect(subagentMarkerToken("done")).toBe("success")
  })
})

describe("rows", () => {
  const root = session("root")
  const sessions = [
    root,
    session("c", { parentID: "root", time: { created: 30, updated: 31 } }),
    session("a", { parentID: "root", time: { created: 10, updated: 12 } }),
    session("b", { parentID: "root", time: { created: 10, updated: 40 } }),
    session("grand", { parentID: "a", time: { created: 5, updated: 6 } }),
    session("other", { time: { created: 1, updated: 2 } }),
    session("stranger", { parentID: "other", time: { created: 1, updated: 2 } }),
  ]

  test("are the direct children of the root in the order the sibling keys walk", () => {
    const rows = subagentRows(sessions, "root", lookup())
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"])
    expect(rows.map((row) => row.id)).toEqual(childSessions(sessions, "root").map((each) => each.id))
  })

  test("a cold start has no tool count and takes the time from the session", () => {
    const cold = Object.fromEntries(sessions.map((each) => [each.id, createSummary(each)]))
    const [row] = subagentRows(sessions, "root", lookup({}, cold))
    expect(row).toMatchObject({ id: "a", retrying: false, startedAt: 10, endedAt: 12 })
    expect(row.marker).toBeUndefined()
    expect(row.toolCalls).toBeUndefined()
  })

  test("without any summary the session's own created and updated times stand in", () => {
    const [row] = subagentRows(sessions, "root", lookup())
    expect(row).toMatchObject({ startedAt: 10, endedAt: 12 })
    expect(row.marker).toBeUndefined()
    expect(row.toolCalls).toBeUndefined()
  })

  test("a bare summary of an event (no times) does not send the end before the start", () => {
    const bare: SessionSummary = { id: "a", status: "idle", lastActivityAt: 0 }
    const [row] = subagentRows(sessions, "root", lookup({}, { a: bare }))
    expect(row).toMatchObject({ startedAt: 10, endedAt: 12 })
  })

  test("a running one has no end: the clock ends it", () => {
    const busy: SessionSummary = { ...createSummary(sessions[2], { type: "busy" }), toolCalls: 4 }
    const [row] = subagentRows(sessions, "root", lookup({}, { a: busy }))
    expect(row).toMatchObject({ marker: "running", toolCalls: 4, startedAt: 10 })
    expect(row.endedAt).toBeUndefined()
  })

  test("retrying shows as running, with the flag the text reads", () => {
    const retry: SessionSummary = createSummary(sessions[2], { type: "retry", attempt: 2, message: "slow", next: 0 })
    const [row] = subagentRows(sessions, "root", lookup({}, { a: retry }))
    expect(row).toMatchObject({ marker: "running", retrying: true })
  })

  test("a failed one keeps its last activity as the end", () => {
    const failed: SessionSummary = {
      ...createSummary(sessions[3], { type: "idle" }),
      error: "boom",
      lastActivityAt: 90,
    }
    const row = subagentRows(sessions, "root", lookup({}, { b: failed })).find((each) => each.id === "b")
    expect(row).toMatchObject({ marker: "failed", endedAt: 90 })
  })

  test("take kind and description from the Task link, the agent, then the title", () => {
    const named = [
      root,
      session("x", { parentID: "root", title: "plain title (@review subagent)", time: { created: 1, updated: 2 } }),
      session("y", { parentID: "root", agent: "explore", title: "t", time: { created: 2, updated: 3 } }),
    ]
    const rows = subagentRows(named, "root", lookup({ y: { description: "scan the tree" } }))
    expect(rows.map(subagentTitle)).toEqual(["review · plain title", "explore · scan the tree"])
  })

  test("a root without sub-agents has no rows", () => {
    expect(subagentRows(sessions, "other-root", lookup())).toEqual([])
    expect(subagentRows(sessions, "stranger", lookup())).toEqual([])
  })
})

describe("the trail of a row", () => {
  const done = { startedAt: 1_000, endedAt: 15_000 }
  const row = (extra: Partial<Parameters<typeof subagentTrail>[0]> = {}) =>
    ({
      id: "a",
      kind: "explore",
      description: "scan",
      marker: "done",
      retrying: false,
      toolCalls: 12,
      ...done,
      ...extra,
    }) satisfies Parameters<typeof subagentTrail>[0]

  test("says the state, the tool count and the time", () => {
    expect(subagentTrail(row(), 0)).toBe("已完成 · 工具 12 · 14s")
    setLanguage("en")
    expect(subagentTrail(row(), 0)).toBe("done · tools 12 · 14s")
  })

  test("writes a dash for a state that is not known, as for a count", () => {
    expect(subagentTrail(row({ marker: undefined, toolCalls: undefined }), 0)).toBe("— · 工具 — · 14s")
    setLanguage("en")
    expect(subagentTrail(row({ marker: undefined }), 0)).toBe("— · tools 12 · 14s")
  })

  test("writes a dash, never a zero, where the count is not known", () => {
    expect(subagentTrail(row({ toolCalls: undefined }), 0)).toBe("已完成 · 工具 — · 14s")
    expect(subagentTrail(row({ toolCalls: undefined }), 0)).not.toContain("0 ·")
    // A real zero is a count like any other.
    expect(subagentTrail(row({ toolCalls: 0 }), 0)).toContain("工具 0")
  })

  test("counts a running one to now and ends a finished one at its last activity", () => {
    const running = row({ marker: "running", endedAt: undefined, startedAt: 1_000 })
    expect(subagentElapsed(running, 66_000)).toBe("1m 5s")
    expect(subagentTrail(running, 66_000)).toBe("运行中 · 工具 12 · 1m 5s")
    expect(subagentElapsed(row(), 999_999)).toBe("14s")
    expect(subagentTrail(row({ marker: "running", retrying: true, endedAt: undefined }), 6_000)).toBe(
      "重试中 · 工具 12 · 5s",
    )
    expect(subagentTrail(row({ marker: "failed" }), 0)).toBe("失败 · 工具 12 · 14s")
  })
})

type PromptPart = { type: string; text?: string; synthetic?: boolean; ignored?: boolean }

describe("the delegated prompt", () => {
  const user = { id: "m1", role: "user" }
  const assistant = { id: "m2", role: "assistant" }

  test("is the text of the first user message, on one line", () => {
    const parts: Record<string, PromptPart[]> = {
      m1: [{ type: "text", text: "Scan\n  all   the files\u001b[0m" }],
      m2: [{ type: "text", text: "no" }],
    }
    expect(delegatedPrompt([assistant, user], (id) => parts[id])).toBe("Scan all the files")
  })

  test("skips synthetic and ignored text and parts that are not text", () => {
    const parts: Record<string, PromptPart[]> = {
      m1: [
        { type: "text", text: "injected", synthetic: true },
        { type: "text", text: "hidden", ignored: true },
        { type: "file" },
        { type: "text", text: "the task" },
      ],
    }
    expect(delegatedPrompt([user], (id) => parts[id])).toBe("the task")
  })

  test("is nothing while the session is not loaded or says nothing", () => {
    expect(delegatedPrompt(undefined, () => undefined)).toBeUndefined()
    expect(delegatedPrompt([assistant], () => undefined)).toBeUndefined()
    expect(delegatedPrompt([user], () => undefined)).toBeUndefined()
    expect(delegatedPrompt([user], () => [{ type: "text", text: "  \n " }])).toBeUndefined()
  })
})

describe("the request to the main agent", () => {
  test("names the sub-agent and stops at a colon, in the interface language", () => {
    const row = { kind: "explore", description: "扫描破坏性变更" }
    expect(subagentRelayText(row)).toBe("请处理子 agent explore · 扫描破坏性变更：")
    setLanguage("en")
    expect(subagentRelayText({ kind: "explore", description: "scan" })).toBe(
      "Please handle the subagent explore · scan:",
    )
  })
})
