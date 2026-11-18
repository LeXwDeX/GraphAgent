// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { createSummary, type BackgroundResult, type SessionSummary } from "../../src/context/session-summary"
import { setLanguage } from "../../src/i18n"
import type { BackgroundJob } from "../../src/session/background"
import { childSessions } from "../../src/session/siblings"
import {
  SUBAGENT_MARKER_GLYPH,
  backgroundResultLine,
  delegatedPrompt,
  subagentChildren,
  subagentCountText,
  subagentDescription,
  subagentDetail,
  subagentElapsed,
  subagentGroupTitle,
  subagentInitiatorText,
  subagentKind,
  subagentMarker,
  subagentMarkerToken,
  subagentRelayText,
  subagentRows,
  subagentSiblings,
  subagentTitle,
  subagentTrail,
  type SubagentGroup,
  type SubagentRow,
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
  tasks: Record<string, ReturnType<SubagentRowSource["task"]>> = {},
  summaries: Record<string, SessionSummary> = {},
  jobs: Record<string, BackgroundJob> = {},
): SubagentRowSource {
  return { task: (id) => tasks[id], summary: (id) => summaries[id], job: (id) => jobs[id] }
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
    expect(SUBAGENT_MARKER_GLYPH).toEqual({ running: "●", queued: "○", failed: "✗", done: "✓" })
    expect(subagentMarkerToken("running")).toBe("primary")
    expect(subagentMarkerToken("queued")).toBe("statusQueued")
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

  const rowOf = (rows: readonly SubagentRow[], id: string) => rows.find((row) => row.id === id)!

  test("are the direct children of the root, and no others", () => {
    const rows = subagentRows(sessions, "root", lookup())
    expect(rows.map((row) => row.id).toSorted()).toEqual(["a", "b", "c"])
    expect(rows.map((row) => row.id).toSorted()).toEqual(
      childSessions(sessions, "root")
        .map((each) => each.id)
        .toSorted(),
    )
  })

  test("those whose state is not known are listed newest first, and a tie is settled by the id", () => {
    // A cold start: no state anywhere, so the sessions are not claimed to run, and the list is by start alone.
    expect(subagentRows(sessions, "root", lookup()).map((row) => row.id)).toEqual(["c", "a", "b"])
    expect(subagentChildren(sessions, "root", lookup()).map((each) => each.id)).toEqual(["c", "a", "b"])
  })

  test("a cold start has no tool count and takes the time from the session", () => {
    const cold = Object.fromEntries(sessions.map((each) => [each.id, createSummary(each)]))
    const row = rowOf(subagentRows(sessions, "root", lookup({}, cold)), "a")
    expect(row).toMatchObject({ id: "a", retrying: false, startedAt: 10, endedAt: 12, group: "finished" })
    expect(row.marker).toBeUndefined()
    expect(row.toolCalls).toBeUndefined()
  })

  test("without any summary the session's own created and updated times stand in", () => {
    const row = rowOf(subagentRows(sessions, "root", lookup()), "a")
    expect(row).toMatchObject({ startedAt: 10, endedAt: 12 })
    expect(row.marker).toBeUndefined()
    expect(row.toolCalls).toBeUndefined()
  })

  test("a bare summary of an event (no times) does not send the end before the start", () => {
    const bare: SessionSummary = { id: "a", status: "idle", lastActivityAt: 0 }
    const row = rowOf(subagentRows(sessions, "root", lookup({}, { a: bare })), "a")
    expect(row).toMatchObject({ startedAt: 10, endedAt: 12 })
  })

  test("a running one has no end: the clock ends it", () => {
    const busy: SessionSummary = { ...createSummary(sessions[2], { type: "busy" }), toolCalls: 4 }
    const row = rowOf(subagentRows(sessions, "root", lookup({}, { a: busy })), "a")
    expect(row).toMatchObject({ marker: "running", toolCalls: 4, startedAt: 10, group: "foreground" })
    expect(row.endedAt).toBeUndefined()
  })

  test("retrying shows as running, with the flag the text reads", () => {
    const retry: SessionSummary = createSummary(sessions[2], { type: "retry", attempt: 2, message: "slow", next: 0 })
    const row = rowOf(subagentRows(sessions, "root", lookup({}, { a: retry })), "a")
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
    // Neither is known to run, so the newer one is first.
    expect(rows.map(subagentTitle)).toEqual(["explore · scan the tree", "review · plain title"])
  })

  test("a root without sub-agents has no rows", () => {
    expect(subagentRows(sessions, "other-root", lookup())).toEqual([])
    expect(subagentRows(sessions, "stranger", lookup())).toEqual([])
  })
})

describe("the trail of a row", () => {
  const done = { startedAt: 1_000, endedAt: 15_000 }
  const row = (extra: Partial<SubagentRow> = {}): SubagentRow => ({
    id: "a",
    kind: "explore",
    description: "scan",
    marker: "done",
    retrying: false,
    toolCalls: 12,
    background: false,
    status: undefined,
    initiator: "agent",
    group: "finished",
    result: undefined,
    error: undefined,
    ...done,
    ...extra,
  })

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

  test("a background run says its status in words: the ones that match a foreground state use its word", () => {
    const background = (status: NonNullable<SubagentRow["status"]>, marker: SubagentRow["marker"]) =>
      row({ background: true, status, marker })
    expect(subagentTrail(background("running", "running"), 0)).toBe("运行中 · 工具 12 · 14s")
    expect(subagentTrail(background("completed", "done"), 0)).toBe("已完成 · 工具 12 · 14s")
    expect(subagentTrail(background("error", "failed"), 0)).toBe("失败 · 工具 12 · 14s")
    expect(subagentTrail(background("interrupted", "failed"), 0)).toBe("已中断 · 工具 12 · 14s")
    expect(subagentTrail(background("cancelled", "failed"), 0)).toBe("已取消 · 工具 12 · 14s")
    setLanguage("en")
    expect(subagentTrail(background("completed", "done"), 0)).toBe("done · tools 12 · 14s")
    expect(subagentTrail(background("interrupted", "failed"), 0)).toBe("interrupted · tools 12 · 14s")
    expect(subagentTrail(background("cancelled", "failed"), 0)).toBe("cancelled · tools 12 · 14s")
  })

  test("a run that began is timed from then, not from the Task call that queued it (#1407)", () => {
    // Started at 1 s, waited for its slot until 5 s, now 11 s: it has run for 6 s, and a finished one ran 10 s.
    const running = row({ marker: "running", endedAt: undefined, startedAt: 1_000, runningAt: 5_000 })
    expect(subagentElapsed(running, 11_000)).toBe("6s")
    expect(subagentTrail(running, 11_000)).toBe("运行中 · 工具 12 · 6s")
    expect(subagentElapsed(row({ startedAt: 1_000, runningAt: 5_000, endedAt: 15_000 }), 0)).toBe("10s")
    // Without the server's word the wait is part of the time, as it always was.
    expect(subagentElapsed(row({ marker: "running", endedAt: undefined, startedAt: 1_000 }), 11_000)).toBe("10s")
  })

  test("a run that waits for its slot has not started: a dash for the count and for the time, and no clock", () => {
    const queued = row({
      background: true,
      status: "queued",
      marker: "queued",
      toolCalls: undefined,
      endedAt: undefined,
    })
    expect(subagentTrail(queued, 0)).toBe("排队中 · 工具 — · —")
    // Whatever the clock says, a queued run has no elapsed time to show.
    expect(subagentTrail(queued, 9_999_999)).toBe("排队中 · 工具 — · —")
    setLanguage("en")
    expect(subagentTrail(queued, 0)).toBe("queued · tools — · —")
  })

  test("a background run whose status is not known keeps the look of a cold start", () => {
    const unknown = row({ background: true, status: "unknown", marker: undefined, toolCalls: undefined })
    expect(subagentTrail(unknown, 0)).toBe("— · 工具 — · 14s")
  })

  test("a background run that is retrying says so, as a foreground one does", () => {
    const retrying = row({ background: true, status: "running", marker: "running", retrying: true, endedAt: undefined })
    expect(subagentTrail(retrying, 6_000)).toBe("重试中 · 工具 12 · 5s")
  })
})

describe("the initiator of a row", () => {
  test("says who asked for the run, in the interface language, and a dash when no Task call started it", () => {
    expect(subagentInitiatorText({ initiator: "user" })).toBe("你发起")
    expect(subagentInitiatorText({ initiator: "agent" })).toBe("主 agent")
    expect(subagentInitiatorText({ initiator: undefined })).toBe("—")
    setLanguage("en")
    expect(subagentInitiatorText({ initiator: "user" })).toBe("you")
    expect(subagentInitiatorText({ initiator: "agent" })).toBe("main agent")
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
  const relay = (extra: Partial<Parameters<typeof subagentRelayText>[0]> = {}) => ({
    id: "ses_child",
    kind: "explore",
    description: "扫描破坏性变更",
    background: false,
    status: undefined,
    error: undefined,
    ...extra,
  })

  test("names the sub-agent and stops at a colon, in the interface language", () => {
    expect(subagentRelayText(relay())).toBe("请处理子 agent explore · 扫描破坏性变更：")
    setLanguage("en")
    expect(subagentRelayText(relay({ description: "scan" }))).toBe("Please handle the subagent explore · scan:")
  })

  test("a background run that goes on is asked to be cancelled, with its task id", () => {
    for (const status of ["running", "queued"] as const) {
      const row = relay({ background: true, status })
      setLanguage("zh-CN")
      expect(subagentRelayText(row)).toBe(
        "请取消后台任务「扫描破坏性变更」（task_id=ses_child），用 task 工具的 cancel。",
      )
      setLanguage("en")
      expect(subagentRelayText({ ...row, description: "scan" })).toBe(
        "Please cancel the background task “scan” (task_id=ses_child) with the task tool's cancel action.",
      )
    }
  })

  test("a background run that finished is asked to be continued from, and the text stops where the user goes on", () => {
    const row = relay({ background: true, status: "completed" })
    expect(subagentRelayText(row)).toBe("请根据后台任务「扫描破坏性变更」的结果继续：")
    setLanguage("en")
    expect(subagentRelayText({ ...row, description: "scan" })).toBe(
      "Please continue from the result of the background task “scan”: ",
    )
  })

  test("a background run that did not finish is asked to be judged: its error's first line, else the status word", () => {
    const failed = relay({ background: true, status: "error", error: "provider timed out" })
    expect(subagentRelayText(failed)).toBe(
      "后台任务「扫描破坏性变更」没有完成（provider timed out），请判断是否需要重新运行。",
    )
    // Without an error of its own, the word for how it ended stands in.
    expect(subagentRelayText({ ...failed, error: undefined })).toBe(
      "后台任务「扫描破坏性变更」没有完成（失败），请判断是否需要重新运行。",
    )
    expect(subagentRelayText(relay({ background: true, status: "interrupted" }))).toContain("（已中断）")
    expect(subagentRelayText(relay({ background: true, status: "cancelled" }))).toContain("（已取消）")
    setLanguage("en")
    expect(subagentRelayText(relay({ background: true, status: "interrupted", description: "scan" }))).toBe(
      "The background task “scan” did not finish (interrupted); decide whether it needs to run again.",
    )
    expect(subagentRelayText(relay({ background: true, status: "error", description: "scan", error: "boom" }))).toBe(
      "The background task “scan” did not finish (boom); decide whether it needs to run again.",
    )
  })

  test("a background run whose status is not known gets the plain request, as a foreground one does", () => {
    expect(subagentRelayText(relay({ background: true, status: "unknown" }))).toBe(
      "请处理子 agent explore · 扫描破坏性变更：",
    )
    expect(subagentRelayText(relay({ background: false, status: undefined }))).toBe(
      "请处理子 agent explore · 扫描破坏性变更：",
    )
  })
})

// ── groups, order and what a background run adds (#1058 6) ────────────────────────────────────────────────────

/** The sessions of a root, one in every state a row can be in; the ids say what each is. */
function mixed() {
  const root = session("root")
  const child = (id: string, created: number, updated = created + 1) =>
    session(id, { parentID: "root", time: { created, updated } })
  const sessions = [
    root,
    child("bg_run_old", 10),
    child("bg_run_new", 20),
    child("bg_queued", 30),
    child("bg_unknown", 35),
    child("fg_run", 40),
    child("fg_done", 50),
    child("fg_unknown", 60),
    child("bg_done", 70, 170),
    child("bg_error", 80),
    child("bg_interrupted", 90),
    child("bg_cancelled", 95),
  ]
  const byID = (id: string) => sessions.find((each) => each.id === id)!
  const result = (status: BackgroundResult["status"], startedAt: number, endedAt: number): BackgroundResult => ({
    status,
    title: "t",
    startedAt,
    endedAt,
    messageID: "msg_result",
    partID: "prt_result",
  })
  const link = (startedAt: number, extra: Partial<NonNullable<ReturnType<SubagentRowSource["task"]>>> = {}) => ({
    background: true,
    startedAt,
    ...extra,
  })
  const tasks = {
    bg_run_old: link(100),
    bg_run_new: link(200),
    bg_queued: link(300),
    bg_unknown: link(150),
    fg_run: { kind: "explore" },
    bg_done: link(120, { result: result("completed", 110, 160) }),
    bg_error: link(400),
    bg_interrupted: link(250),
    bg_cancelled: link(350),
  }
  const summaries = {
    bg_run_old: { ...createSummary(byID("bg_run_old"), { type: "busy" }), toolCalls: 3 },
    bg_run_new: { ...createSummary(byID("bg_run_new"), { type: "busy" }), toolCalls: 1 },
    bg_queued: createSummary(byID("bg_queued"), { type: "idle" }),
    bg_unknown: createSummary(byID("bg_unknown")),
    fg_run: { ...createSummary(byID("fg_run"), { type: "busy" }), toolCalls: 5 },
    fg_done: { ...createSummary(byID("fg_done"), { type: "idle" }), toolCalls: 2 },
    fg_unknown: createSummary(byID("fg_unknown")),
    bg_done: { ...createSummary(byID("bg_done"), { type: "idle" }), toolCalls: 9 },
    bg_error: { ...createSummary(byID("bg_error"), { type: "idle" }), error: "boom" },
    bg_interrupted: createSummary(byID("bg_interrupted"), { type: "idle" }),
    bg_cancelled: createSummary(byID("bg_cancelled"), { type: "idle" }),
  }
  const jobs = {
    bg_run_old: { value: "running" },
    bg_run_new: { value: "running" },
    bg_queued: { value: "running" },
    bg_done: { value: "completed" },
    bg_error: { value: "error", reason: "boom" },
    bg_interrupted: { value: "error", reason: "process_restart" },
    bg_cancelled: { value: "cancelled" },
  }
  return { sessions, tasks, summaries, jobs, source: lookup(tasks, summaries, jobs) }
}

describe("the groups of the list", () => {
  test("background runs come first, then foreground runs that still run, then everything else", () => {
    const { sessions, source } = mixed()
    const rows = subagentRows(sessions, "root", source)
    const order = (group: SubagentGroup) => rows.filter((row) => row.group === group).map((row) => row.id)
    expect(order("background")).toEqual(["bg_run_new", "bg_run_old", "bg_queued", "bg_unknown"])
    expect(order("foreground")).toEqual(["fg_run"])
    expect(order("finished")).toEqual([
      "bg_error",
      "bg_cancelled",
      "bg_interrupted",
      "bg_done",
      "fg_unknown",
      "fg_done",
    ])
    // The groups are one after the other, in that order.
    expect(rows.map((row) => row.group)).toEqual([
      ...Array<SubagentGroup>(4).fill("background"),
      "foreground",
      ...Array<SubagentGroup>(6).fill("finished"),
    ])
  })

  test("inside the background group a running run comes before a queued one, however new the queued one is", () => {
    const { sessions, source } = mixed()
    const rows = subagentRows(sessions, "root", source)
    expect(rows[0]).toMatchObject({ id: "bg_run_new", status: "running" })
    expect(rows.find((row) => row.id === "bg_queued")?.startedAt).toBeGreaterThan(rows[0].startedAt)
  })

  test("each row knows how it stands: the marker, the status and the end of a run", () => {
    const { sessions, source } = mixed()
    const rows = subagentRows(sessions, "root", source)
    const of = (id: string) => rows.find((row) => row.id === id)!
    expect(of("bg_run_old")).toMatchObject({
      marker: "running",
      status: "running",
      background: true,
      endedAt: undefined,
    })
    expect(of("bg_queued")).toMatchObject({ marker: "queued", status: "queued", endedAt: undefined })
    expect(of("bg_unknown")).toMatchObject({ marker: undefined, status: "unknown", group: "background" })
    expect(of("bg_done")).toMatchObject({ marker: "done", status: "completed" })
    expect(of("bg_error")).toMatchObject({ marker: "failed", status: "error", error: "boom" })
    expect(of("bg_interrupted")).toMatchObject({ marker: "failed", status: "interrupted" })
    expect(of("bg_cancelled")).toMatchObject({ marker: "failed", status: "cancelled" })
    expect(of("fg_run")).toMatchObject({ marker: "running", status: undefined, background: false, group: "foreground" })
    expect(of("fg_done")).toMatchObject({ marker: "done", status: undefined, group: "finished" })
    // Not claimed to run, and not claimed to be over either.
    expect(of("fg_unknown")).toMatchObject({ marker: undefined, status: undefined, group: "finished" })
  })

  test("a background run is timed by its Task call, and by the server's span once it reported one", () => {
    const { sessions, source } = mixed()
    const rows = subagentRows(sessions, "root", source)
    const of = (id: string) => rows.find((row) => row.id === id)!
    // The session was made at 10, the Task call that started this run at 100: a resumed task has an old session.
    expect(of("bg_run_old").startedAt).toBe(100)
    // Reported: the span of the result, not the summary's activity.
    expect(of("bg_done")).toMatchObject({ startedAt: 110, endedAt: 160 })
    // Ended without a report: the last activity of its session is the end.
    expect(of("bg_error")).toMatchObject({ startedAt: 400, endedAt: 81 })
    // A foreground run keeps what it always had: the summary's start.
    expect(of("fg_done").startedAt).toBe(50)
  })

  test("a run the server says began running is timed from then; the order of the list stays the Task call's (#1407)", () => {
    const { sessions, tasks, summaries, jobs } = mixed()
    // bg_run_old (Task call at 100) waited and began at 180; bg_run_new began at 205, five after its call.
    const reported = lookup(tasks, summaries, {
      ...jobs,
      bg_run_old: { value: "running", since: 180 },
      bg_run_new: { value: "running", since: 205 },
    })
    const rows = subagentRows(sessions, "root", reported)
    const of = (id: string) => rows.find((row) => row.id === id)!
    expect(of("bg_run_old")).toMatchObject({ startedAt: 100, runningAt: 180 })
    expect(of("bg_run_new")).toMatchObject({ startedAt: 200, runningAt: 205 })
    expect(rows.filter((row) => row.group === "background").map((row) => row.id)).toEqual([
      "bg_run_new",
      "bg_run_old",
      "bg_queued",
      "bg_unknown",
    ])
    expect(subagentElapsed(of("bg_run_old"), 5_180)).toBe("5s")
    // A queued run has not begun; neither a run that only the summary says runs.
    expect(of("bg_queued")).not.toHaveProperty("runningAt")
    // The result of a run that ended says it too, and wins over what the job said.
    const ended = lookup(
      { ...tasks, bg_done: { ...tasks.bg_done, result: { ...tasks.bg_done.result!, runningAt: 140 } } },
      summaries,
      jobs,
    )
    const done = subagentRows(sessions, "root", ended).find((row) => row.id === "bg_done")!
    expect(done).toMatchObject({ startedAt: 110, runningAt: 140, endedAt: 160 })
    expect(subagentElapsed(done, 0)).toBe("0s")
  })

  test("a server that reports the queue marks a run waiting for its slot queued; the child's summary does not", () => {
    const { sessions, tasks, summaries, jobs } = mixed()
    // bg_run_new has a busy child with a tool called, and the server says its job still waits.
    const queued = lookup(tasks, summaries, { ...jobs, bg_run_new: { value: "queued", since: 200 } })
    const rows = subagentRows(sessions, "root", queued)
    expect(rows.find((row) => row.id === "bg_run_new")).toMatchObject({ marker: "queued", status: "queued" })
    expect(rows.find((row) => row.id === "bg_run_new")).not.toHaveProperty("runningAt")
    // bg_queued runs: the job says so with its mark, though its child has shown nothing yet.
    const began = lookup(tasks, summaries, { ...jobs, bg_queued: { value: "running", since: 310 } })
    expect(subagentRows(sessions, "root", began).find((row) => row.id === "bg_queued")).toMatchObject({
      marker: "running",
      status: "running",
      runningAt: 310,
    })
  })

  test("the initiator is the Task link's, an agent by default, and nothing without a link", () => {
    const sessions = [session("root"), ...["a", "b", "c"].map((id) => session(id, { parentID: "root" }))]
    const rows = subagentRows(
      sessions,
      "root",
      lookup({ a: { initiator: "user", background: true }, b: { description: "x" } }),
    )
    const of = (id: string) => rows.find((row) => row.id === id)!
    expect(of("a").initiator).toBe("user")
    expect(of("b").initiator).toBe("agent")
    expect(of("c").initiator).toBeUndefined()
  })

  test("the error of a sub-agent is its first line, on one line and of a length a sentence can carry", () => {
    const sessions = [session("root"), session("a", { parentID: "root" }), session("b", { parentID: "root" })]
    const rows = subagentRows(
      sessions,
      "root",
      lookup(
        {},
        {
          a: {
            ...createSummary(sessions[1], { type: "idle" }),
            error: "\n\n  first   line \u001b[31mred\u001b[0m\nsecond line",
          },
          b: { ...createSummary(sessions[2], { type: "idle" }), error: "x".repeat(400) },
        },
      ),
    )
    expect(rows.find((row) => row.id === "a")?.error).toBe("first line red")
    const long = rows.find((row) => row.id === "b")?.error
    expect(long?.length).toBe(160)
    expect(long?.endsWith("…")).toBe(true)
    expect(rows.find((row) => row.id === "b")).toBeDefined()
  })

  test("the headings of the groups are in the interface language", () => {
    expect((["background", "foreground", "finished"] as const).map(subagentGroupTitle)).toEqual([
      "后台",
      "前台",
      "已结束",
    ])
    setLanguage("en")
    expect((["background", "foreground", "finished"] as const).map(subagentGroupTitle)).toEqual([
      "Background",
      "Foreground",
      "Finished",
    ])
  })
})

describe("the order the sibling keys walk is the order of the list", () => {
  test("the children and the siblings are the rows' sessions, in the rows' order", () => {
    const { sessions, source } = mixed()
    const rows = subagentRows(sessions, "root", source).map((row) => row.id)
    expect(subagentChildren(sessions, "root", source).map((each) => each.id)).toEqual(rows)
    for (const id of rows) expect(subagentSiblings(sessions, id, source).map((each) => each.id)).toEqual(rows)
  })

  test("follows the state: a run that ends moves to the finished group, and so does its place among its siblings", () => {
    const { sessions, tasks, summaries, jobs, source } = mixed()
    const before = subagentSiblings(sessions, "fg_run", source).map((each) => each.id)
    expect(before.indexOf("fg_run")).toBe(4)
    const fg = sessions.find((each) => each.id === "fg_run")!
    const ended = lookup(tasks, { ...summaries, fg_run: createSummary(fg, { type: "idle" }) }, jobs)
    const after = subagentSiblings(sessions, "fg_run", ended).map((each) => each.id)
    // Nothing waits for it any more: it is among those that are over, after the ones that started later.
    expect(after.at(-1)).toBe("fg_run")
    expect(after.slice(0, 4)).toEqual(["bg_run_new", "bg_run_old", "bg_queued", "bg_unknown"])
  })

  test("is the whole walk even when nothing is known: newest first, so not the order of creation", () => {
    const { sessions } = mixed()
    const siblings = subagentSiblings(sessions, "bg_done", lookup()).map((each) => each.id)
    expect(siblings.slice(0, 3)).toEqual(["bg_cancelled", "bg_interrupted", "bg_error"])
  })

  test("a root, an unknown session and a session without siblings have none", () => {
    const { sessions, source } = mixed()
    expect(subagentSiblings(sessions, "root", source)).toEqual([])
    expect(subagentSiblings(sessions, "missing", source)).toEqual([])
    expect(subagentChildren(sessions, "missing", source)).toEqual([])
  })

  test("does not change its input", () => {
    const { sessions, source } = mixed()
    const copy = [...sessions]
    subagentSiblings(sessions, "bg_done", source)
    subagentChildren(sessions, "root", source)
    expect(sessions).toEqual(copy)
  })
})

describe("the heading counts", () => {
  const rows = (...status: (NonNullable<SubagentRow["status"]> | "foreground")[]) =>
    status.map((each) => ({ background: each !== "foreground", status: each === "foreground" ? undefined : each }))

  test("count what is listed, the background runs that run and the ones that wait; a zero is left out", () => {
    expect(subagentCountText(rows("running", "running", "queued", "foreground", "completed"))).toBe(
      "5 个 · 2 个后台运行 · 1 个排队",
    )
    expect(subagentCountText(rows("running", "foreground"))).toBe("2 个 · 1 个后台运行")
    expect(subagentCountText(rows("queued"))).toBe("1 个 · 1 个排队")
    expect(subagentCountText(rows("foreground", "completed", "unknown"))).toBe("3 个")
    setLanguage("en")
    expect(subagentCountText(rows("running", "running", "queued", "foreground", "completed"))).toBe(
      "5 · 2 background running · 1 queued",
    )
    expect(subagentCountText(rows("foreground"))).toBe("1")
  })

  test("a foreground run that runs is not a background one, whatever its status says", () => {
    expect(subagentCountText([{ background: false, status: "running" }])).toBe("1 个")
  })

  test("nothing listed has no counts", () => {
    expect(subagentCountText([])).toBe("")
  })
})

describe("the first line of a report", () => {
  const notice = (body: string, tag = "task_result") =>
    [
      "The user ran /review in the background and it has finished. Present its findings faithfully.",
      "",
      `<task id="ses_child" state="completed">`,
      "<summary>Background task completed: review</summary>",
      `<${tag}>`,
      body,
      `</${tag}>`,
      "</task>",
    ].join("\n")

  test("is the first line of what is between the result tags, not of the notice around it", () => {
    expect(backgroundResultLine(notice("Found 3 breaking changes.\nSee the list below."))).toBe(
      "Found 3 breaking changes.",
    )
    expect(backgroundResultLine(notice("\n\n   Indented   report  \nsecond"))).toBe("Indented report")
  })

  test("reads the body of a failure the same way", () => {
    expect(backgroundResultLine(notice("The provider timed out.\nTry again.", "task_error"))).toBe(
      "The provider timed out.",
    )
  })

  test("is one displayable line: escapes are gone", () => {
    expect(backgroundResultLine(notice("\u001b[31mred\u001b[0m\u0007 text"))).toBe("red text")
  })

  test("is nothing without the text, without the tags or with an empty body", () => {
    expect(backgroundResultLine(undefined)).toBeUndefined()
    expect(backgroundResultLine("just a sentence, no tags")).toBeUndefined()
    expect(backgroundResultLine(notice("  \n \n"))).toBeUndefined()
  })
})

describe("the lines under the selected row", () => {
  const detail = (extra: Partial<Parameters<typeof subagentDetail>[0]> = {}) => ({
    description: "扫描破坏性变更",
    background: false,
    status: undefined,
    result: undefined,
    ...extra,
  })
  const reported: BackgroundResult = {
    status: "completed",
    title: "扫描破坏性变更",
    startedAt: 1,
    endedAt: 2,
    messageID: "msg_result",
    partID: "prt_result",
  }
  const text = "<task_result>\n发现 3 处破坏性变更。\n详见下方。\n</task_result>"

  test("is what the sub-agent was asked: its prompt once loaded, else the Task description", () => {
    expect(subagentDetail(detail(), { prompt: "逐个检查补丁", resultText: undefined })).toEqual(["任务：逐个检查补丁"])
    expect(subagentDetail(detail(), { prompt: undefined, resultText: undefined })).toEqual(["任务：扫描破坏性变更"])
    setLanguage("en")
    expect(subagentDetail(detail({ description: "scan" }), { prompt: undefined, resultText: undefined })).toEqual([
      "Task: scan",
    ])
  })

  test("a background run that is over adds the first line of its report and says it came back", () => {
    const row = detail({ background: true, status: "completed", result: reported })
    expect(subagentDetail(row, { prompt: "p", resultText: text })).toEqual([
      "任务：p",
      "结果：发现 3 处破坏性变更。 · 结果已回注",
    ])
    setLanguage("en")
    expect(subagentDetail(row, { prompt: "p", resultText: "<task_result>\nFound 3.\n</task_result>" })).toEqual([
      "Task: p",
      "Result: Found 3. · result delivered",
    ])
  })

  test("without the message loaded, the report is not guessed at: only that it came back", () => {
    const row = detail({ background: true, status: "completed", result: reported })
    expect(subagentDetail(row, { prompt: "p", resultText: undefined })).toEqual(["任务：p", "结果已回注"])
    // A failure the server reported came back too.
    const failed = detail({ background: true, status: "error", result: { ...reported, status: "error" } })
    expect(subagentDetail(failed, { prompt: "p", resultText: "<task_error>\nboom\n</task_error>" })).toEqual([
      "任务：p",
      "结果：boom · 结果已回注",
    ])
  })

  test("a run that was interrupted and left no report says it did not come back", () => {
    const row = detail({ background: true, status: "interrupted" })
    expect(subagentDetail(row, { prompt: "p", resultText: undefined })).toEqual(["任务：p", "未回注（已中断）"])
    setLanguage("en")
    expect(subagentDetail(row, { prompt: "p", resultText: undefined })).toEqual([
      "Task: p",
      "not delivered (interrupted)",
    ])
  })

  test("says nothing of a report for a run that goes on, one that is waited for, or one the server has not reported on", () => {
    for (const status of ["running", "queued", "unknown", "completed", "error", "cancelled"] as const) {
      expect(subagentDetail(detail({ background: true, status }), { prompt: "p", resultText: undefined })).toEqual([
        "任务：p",
      ])
    }
    expect(subagentDetail(detail(), { prompt: "p", resultText: text })).toEqual(["任务：p"])
  })
})
