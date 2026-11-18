// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PrWatchEntry } from "@graphagent/sdk"
import { createMemo, createRoot } from "solid-js"
import { setLanguage } from "../../src/i18n"
import {
  PR_HANDLED_VISIBLE_MS,
  PR_MARK_CHARS,
  PR_TAIL_BUDGET,
  PR_UNRESPONSIVE_MS,
  prAlertDismissed,
  prClockMoved,
  prCompact,
  prLineFacts,
  prLineState,
  prLineWords,
  prMark,
  prNoticeAt,
  prTailMark,
  prToastFor,
  type PrAssistant,
  type PrCompactItem,
  type PrLineKind,
  type PrLineState,
  type PrMark,
  type PrOutcome,
  type PrPrefixToken,
  type PrSession,
  type PrTailRow,
} from "../../src/pr/state"
import type { ToastLevel } from "../../src/ui/toast"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"

// No clocks and no sleeps: every time is an argument.
const T0 = 1_700_000_000_000
const SECOND = 1_000
const MINUTE = 60_000
const AMBIGUOUS_WIDTHS: readonly AmbiguousWidth[] = [1, 2]
const OUTCOMES: readonly PrOutcome[] = ["success", "failure", "merged", "closed", "review", "deadline"]

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

function entry(over: Partial<PrWatchEntry> = {}): PrWatchEntry {
  return {
    sessionID: "ses_test",
    watchID: "watch_1",
    url: "https://example.test/acme/repo/pull/1036",
    provider: "github",
    number: 1036,
    phase: "succeeded",
    outcome: "success",
    startedAt: T0 - 10 * MINUTE,
    updatedAt: T0,
    deadlineAt: T0 + 60 * MINUTE,
    ...over,
  }
}

/** A watch whose notice was delivered at `at`; `updatedAt` is the delivery's write time. */
function delivered(over: Partial<PrWatchEntry> = {}, at = T0, extra: { noReply?: true } = {}): PrWatchEntry {
  return entry({ delivery: { state: "delivered", deliveredAt: at, ...extra }, updatedAt: at, ...over })
}

/** A watch that entered `delivering` at `T0`: the outcome is known and the notice is owed. */
function owed(over: Partial<PrWatchEntry> = {}): PrWatchEntry {
  return entry({ phase: "delivering", delivery: { state: "pending" }, updatedAt: T0, ...over })
}

function watching(over: Partial<PrWatchEntry> = {}): PrWatchEntry {
  return entry({ phase: "watching", outcome: undefined, ...over })
}

const idle = (assistants: readonly PrAssistant[] = []): PrSession => ({ status: "idle", assistants })
const busy = (assistants: readonly PrAssistant[] = []): PrSession => ({ status: "busy", assistants })
const retrying = (assistants: readonly PrAssistant[] = []): PrSession => ({ status: "retry", assistants })
const unknown = (assistants: readonly PrAssistant[] = []): PrSession => ({ status: undefined, assistants })

const answer = (created: number, completed: number | undefined = created + SECOND): PrAssistant => ({
  created,
  completed,
  error: false,
})
const failed = (created: number, completed: number | undefined = created + SECOND): PrAssistant => ({
  created,
  completed,
  error: true,
})

const meta = { watchID: "watch_1", number: 1036 }

describe("watching", () => {
  test("shows the passed and total check counts", () => {
    const checks = { total: 6, pending: 2, failed: 1, passed: 3 }
    expect(prLineState(watching({ checks }), idle(), T0)).toEqual({
      kind: "watching",
      text: "CI 3/6",
      status: { text: "CI 3/6", token: "textMuted" },
      tone: "default",
      sticky: false,
      hidden: false,
    })
  })

  test("waits for CI while the counts are missing or there are no checks", () => {
    for (const checks of [undefined, { total: 0, pending: 0, failed: 0, passed: 0 }]) {
      const state = prLineState(watching({ checks }), idle(), T0)
      expect(state.kind).toBe("watching")
      expect(state.text).toBe("等待 CI")
      expect(state.status?.token).toBe("textMuted")
      expect(state.nextAt).toBeUndefined()
    }
  })

  test("is not driven by the clock or the session", () => {
    const state = prLineState(
      watching({ checks: { total: 2, pending: 1, failed: 0, passed: 1 } }),
      busy(),
      T0 + 99 * MINUTE,
    )
    expect(state).toMatchObject({ kind: "watching", text: "CI 1/2", sticky: false, hidden: false })
    expect(state.nextAt).toBeUndefined()
  })
})

describe("cancelled", () => {
  test("is removed: no text, hidden, nothing to toast", () => {
    for (const over of [{}, { outcome: undefined }, { delivery: { state: "pending" as const } }]) {
      expect(prLineState(entry({ phase: "cancelled", ...over }), busy([answer(T0)]), T0)).toEqual({
        kind: "removed",
        text: "",
        tone: "default",
        sticky: false,
        hidden: true,
      })
    }
  })
})

describe("owed notice (delivering)", () => {
  test("awaits the agent for under three minutes, then calls it unresponsive", () => {
    const sticky = prLineState(owed(), idle(), T0 + PR_UNRESPONSIVE_MS)
    expect(prLineState(owed(), idle(), T0)).toEqual({
      kind: "awaiting",
      text: "✓ 通过 · 等待 agent 接收",
      prefix: { text: "✓ 通过", token: "success" },
      status: { text: "等待 agent 接收", token: "textMuted" },
      outcome: "success",
      tone: "default",
      sticky: false,
      hidden: false,
      nextAt: T0 + 3 * MINUTE,
    })
    // 2:59.999 is still waiting, 3:00 is unresponsive (the boundary is >=).
    expect(prLineState(owed(), idle(), T0 + 3 * MINUTE - 1).kind).toBe("awaiting")
    expect(prLineState(owed(), idle(), T0 + 3 * MINUTE - 1).nextAt).toBe(T0 + 3 * MINUTE)
    expect(sticky).toEqual({
      kind: "unresponsive",
      text: "✓ 通过 · agent 未响应",
      prefix: { text: "✓ 通过", token: "success" },
      status: { text: "agent 未响应", token: "warning" },
      outcome: "success",
      tone: "warning",
      sticky: true,
      hidden: false,
    })
    expect(prLineState(owed(), idle(), T0 + 3 * MINUTE + 1).kind).toBe("unresponsive")
    expect(prLineState(owed(), idle(), T0 + 60 * MINUTE).nextAt).toBeUndefined()
  })

  test("the clock starts at the entry's last write, not at the outcome", () => {
    const late = owed({ startedAt: T0 - 60 * MINUTE, updatedAt: T0 + 10 * MINUTE })
    expect(prLineState(late, idle(), T0 + 12 * MINUTE).kind).toBe("awaiting")
    expect(prLineState(late, idle(), T0 + 13 * MINUTE - 1).kind).toBe("awaiting")
    expect(prLineState(late, idle(), T0 + 13 * MINUTE).kind).toBe("unresponsive")
  })

  test("an entry without a delivery object is owed while its phase is delivering", () => {
    expect(prLineState(owed({ delivery: undefined }), idle(), T0).kind).toBe("awaiting")
    expect(prLineState(owed({ delivery: undefined }), idle(), T0 + 3 * MINUTE).kind).toBe("unresponsive")
  })

  test("a pending delivery is owed whatever the session is doing", () => {
    // Busy with something else and replies from earlier turns do not make the notice "worked on".
    const state = prLineState(owed(), busy([answer(T0 + SECOND)]), T0 + SECOND)
    expect(state.kind).toBe("awaiting")
  })

  test("a deadline outcome is owed like any other and keeps its warning prefix", () => {
    const state = prLineState(owed({ outcome: "deadline" }), idle(), T0)
    expect(state.text).toBe("超时 · 等待 agent 接收")
    expect(state.prefix).toEqual({ text: "超时", token: "warning" })
    expect(state.tone).toBe("default")
  })
})

describe("delivered notice", () => {
  test("noReply is a sticky warning at any time, whatever the session does", () => {
    const stopped = delivered({}, T0, { noReply: true })
    const expected: PrLineState = {
      kind: "noReply",
      text: "✓ 通过 · 已通知 · 会话已中止，未自动继续",
      prefix: { text: "✓ 通过", token: "success" },
      status: { text: "已通知 · 会话已中止，未自动继续", token: "warning" },
      outcome: "success",
      tone: "warning",
      sticky: true,
      hidden: false,
    }
    expect(prLineState(stopped, idle(), T0)).toEqual(expected)
    // Never unresponsive: hours later it is still the same line.
    expect(prLineState(stopped, idle(), T0 + 5 * 60 * MINUTE)).toEqual(expected)
    expect(prLineState(stopped, busy(), T0 + MINUTE)).toEqual(expected)
    expect(prLineState(stopped, idle([answer(T0 + SECOND)]), T0 + MINUTE)).toEqual(expected)
  })

  test("working while the session is busy or retrying", () => {
    for (const session of [busy(), retrying()]) {
      expect(prLineState(delivered(), session, T0 + SECOND)).toEqual({
        kind: "working",
        text: "✓ 通过 · agent 处理中",
        prefix: { text: "✓ 通过", token: "success" },
        status: { text: "agent 处理中", token: "textMuted" },
        outcome: "success",
        tone: "default",
        sticky: false,
        hidden: false,
      })
    }
  })

  test("a busy session is working even after a long wait and after errors or answers", () => {
    const later = T0 + 30 * MINUTE
    for (const session of [
      busy(),
      busy([answer(T0 + SECOND)]),
      busy([failed(T0 + SECOND)]),
      retrying([failed(T0 + SECOND)]),
    ]) {
      const state = prLineState(delivered(), session, later)
      expect(state.kind).toBe("working")
      expect(state.nextAt).toBeUndefined()
    }
  })

  test("notified until an assistant message after the notice appears", () => {
    expect(prLineState(delivered(), idle(), T0 + SECOND)).toEqual({
      kind: "notified",
      text: "✓ 通过 · 已通知 agent",
      prefix: { text: "✓ 通过", token: "success" },
      status: { text: "已通知 agent", token: "textMuted" },
      outcome: "success",
      tone: "default",
      sticky: false,
      hidden: false,
      nextAt: T0 + 3 * MINUTE,
    })
  })

  test("notified turns unresponsive at exactly three minutes", () => {
    expect(prLineState(delivered(), idle(), T0 + 3 * MINUTE - 1).kind).toBe("notified")
    expect(prLineState(delivered(), idle(), T0 + 3 * MINUTE - 1).nextAt).toBe(T0 + 3 * MINUTE)
    expect(prLineState(delivered(), idle(), T0 + 3 * MINUTE)).toEqual({
      kind: "unresponsive",
      text: "✓ 通过 · agent 未响应",
      prefix: { text: "✓ 通过", token: "success" },
      status: { text: "agent 未响应", token: "warning" },
      outcome: "success",
      tone: "warning",
      sticky: true,
      hidden: false,
    })
    expect(prLineState(delivered(), idle(), T0 + 3 * MINUTE + 1).kind).toBe("unresponsive")
    expect(prLineState(delivered(), idle(), T0 + 24 * 60 * MINUTE).nextAt).toBeUndefined()
  })

  test("a status that is not known counts as idle", () => {
    expect(prLineState(delivered(), unknown(), T0 + SECOND).kind).toBe("notified")
    expect(prLineState(delivered(), unknown(), T0 + 3 * MINUTE).kind).toBe("unresponsive")
    expect(prLineState(delivered(), unknown([answer(T0 + SECOND)]), T0 + 3 * MINUTE).kind).toBe("handled")
  })

  test("only assistant messages created after deliveredAt count", () => {
    const before = [answer(T0 - MINUTE), failed(T0 - SECOND), answer(T0)]
    // created === deliveredAt is not after it.
    expect(prLineState(delivered(), idle(before), T0 + SECOND).kind).toBe("notified")
    expect(prLineState(delivered(), idle(before), T0 + 3 * MINUTE).kind).toBe("unresponsive")
    expect(prLineState(delivered(), idle([...before, answer(T0 + 1)]), T0 + 3 * MINUTE).kind).toBe("handled")
    expect(prLineState(delivered(), idle([...before, failed(T0 + 1)]), T0 + 3 * MINUTE).kind).toBe("turnError")
  })

  test("a missing or unusable deliveredAt falls back to the entry's updatedAt", () => {
    for (const deliveredAt of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const missing = entry({ delivery: { state: "delivered", deliveredAt }, updatedAt: T0 + 7 * MINUTE })
      expect(prLineState(missing, idle(), T0 + 10 * MINUTE - 1).kind).toBe("notified")
      expect(prLineState(missing, idle(), T0 + 10 * MINUTE - 1).nextAt).toBe(T0 + 10 * MINUTE)
      expect(prLineState(missing, idle(), T0 + 10 * MINUTE).kind).toBe("unresponsive")
      // An answer between updatedAt and now counts, one before it does not.
      expect(prLineState(missing, idle([answer(T0 + 8 * MINUTE)]), T0 + 8 * MINUTE).kind).toBe("handled")
      expect(prLineState(missing, idle([answer(T0 + 6 * MINUTE)]), T0 + 8 * MINUTE).kind).toBe("notified")
    }
  })

  test("a settled watch with no delivery shows its outcome alone", () => {
    const state = prLineState(entry({ delivery: undefined }), idle(), T0 + 99 * MINUTE)
    expect(state).toEqual({
      kind: "settled",
      text: "✓ 通过",
      prefix: { text: "✓ 通过", token: "success" },
      outcome: "success",
      tone: "default",
      sticky: false,
      hidden: false,
    })
    // Nothing known and nothing to say: not drawn.
    const empty = prLineState(entry({ delivery: undefined, outcome: undefined }), idle(), T0)
    expect(empty).toMatchObject({ kind: "settled", text: "", hidden: true })
  })

  test("a missing outcome leaves the status alone", () => {
    const state = prLineState(delivered({ outcome: undefined }), busy(), T0)
    expect(state.text).toBe("agent 处理中")
    expect(state.prefix).toBeUndefined()
    expect(state.outcome).toBeUndefined()
    expect(prLineState(owed({ outcome: undefined }), idle(), T0).text).toBe("等待 agent 接收")
  })

  test("failed and expired entries go through the same rules as succeeded ones", () => {
    const failure = delivered({ phase: "failed", outcome: "failure" })
    expect(prLineState(failure, busy(), T0).text).toBe("✗ 失败 · agent 处理中")
    const expired = delivered({ phase: "expired", outcome: "deadline" })
    expect(prLineState(expired, idle(), T0 + 3 * MINUTE).text).toBe("超时 · agent 未响应")
    expect(prLineState(expired, idle([answer(T0 + SECOND)]), T0 + SECOND).text).toBe("超时 · agent 已处理")
  })
})

describe("handled", () => {
  const completedAt = T0 + 20 * SECOND

  test("an answer after the notice is handled, and the line hides a minute after that turn ended", () => {
    const session = idle([answer(T0 + 5 * SECOND, completedAt)])
    const visible = prLineState(delivered(), session, T0 + 30 * SECOND)
    expect(visible).toEqual({
      kind: "handled",
      text: "✓ 通过 · agent 已处理",
      prefix: { text: "✓ 通过", token: "success" },
      status: { text: "agent 已处理", token: "textMuted" },
      outcome: "success",
      tone: "default",
      sticky: false,
      hidden: false,
      nextAt: completedAt + PR_HANDLED_VISIBLE_MS,
    })
    expect(prLineState(delivered(), session, completedAt + PR_HANDLED_VISIBLE_MS - 1).hidden).toBe(false)
    const hidden = prLineState(delivered(), session, completedAt + PR_HANDLED_VISIBLE_MS)
    expect(hidden).toMatchObject({ kind: "handled", hidden: true })
    expect(hidden.nextAt).toBeUndefined()
    expect(prLineState(delivered(), session, completedAt + 10 * MINUTE).hidden).toBe(true)
  })

  test("an assistant message that only called tools is an answer", () => {
    // The line is given no message content: an error-free assistant message is all it asks for.
    const toolsOnly: PrAssistant = { created: T0 + SECOND, completed: T0 + 2 * SECOND, error: false }
    expect(prLineState(delivered(), idle([toolsOnly]), T0 + 3 * SECOND).kind).toBe("handled")
  })

  test("the hide time follows the latest error-free assistant after the notice, by creation", () => {
    const first = answer(T0 + 10 * SECOND, T0 + 200 * SECOND) // created first, finished last
    const second = answer(T0 + 20 * SECOND, T0 + 40 * SECOND)
    const erroring = failed(T0 + 50 * SECOND, T0 + 90 * SECOND) // newest, but an error
    const session = idle([first, second, erroring])
    const state = prLineState(delivered(), session, T0 + 60 * SECOND)
    expect(state.kind).toBe("handled")
    expect(state.nextAt).toBe(T0 + 40 * SECOND + PR_HANDLED_VISIBLE_MS)
    expect(prLineState(delivered(), session, T0 + 100 * SECOND - 1).hidden).toBe(false)
    expect(prLineState(delivered(), session, T0 + 100 * SECOND).hidden).toBe(true)
  })

  test("an answer that has not completed counts from its creation", () => {
    // (An explicit object: the `answer` helper fills `completed` in when it is left out.)
    const session = idle([{ created: T0 + 10 * SECOND, error: false }])
    expect(prLineState(delivered(), session, T0 + 20 * SECOND).nextAt).toBe(T0 + 10 * SECOND + PR_HANDLED_VISIBLE_MS)
    expect(prLineState(delivered(), session, T0 + 70 * SECOND).hidden).toBe(true)
    expect(prLineState(delivered(), session, T0 + 70 * SECOND - 1).hidden).toBe(false)
  })

  test("a new turn brings the line back while it works", () => {
    const session = [answer(T0 + 5 * SECOND, completedAt)]
    expect(prLineState(delivered(), idle(session), T0 + 10 * MINUTE).hidden).toBe(true)
    expect(prLineState(delivered(), busy(session), T0 + 10 * MINUTE)).toMatchObject({ kind: "working", hidden: false })
  })

  test("one answer among errors is enough", () => {
    const session = idle([failed(T0 + SECOND), answer(T0 + 2 * SECOND), failed(T0 + 3 * SECOND)])
    expect(prLineState(delivered(), session, T0 + 4 * SECOND).kind).toBe("handled")
  })
})

describe("turn errors", () => {
  test("every assistant message after the notice ending in an error is a sticky warning", () => {
    const session = idle([failed(T0 + SECOND), failed(T0 + 2 * SECOND)])
    const expected: PrLineState = {
      kind: "turnError",
      text: "✓ 通过 · agent 回合出错",
      prefix: { text: "✓ 通过", token: "success" },
      status: { text: "agent 回合出错", token: "warning" },
      outcome: "success",
      tone: "warning",
      sticky: true,
      hidden: false,
    }
    expect(prLineState(delivered(), session, T0 + 3 * SECOND)).toEqual(expected)
    // Sticky: no clock turns it into anything else.
    expect(prLineState(delivered(), session, T0 + 99 * MINUTE)).toEqual(expected)
  })
})

describe("a root whose history is not loaded (partial)", () => {
  const partial = (assistants: readonly PrAssistant[] = []): PrSession => ({
    status: "idle",
    assistants,
    partial: true,
  })

  test("no answer seen: notified, with no three-minute clock, however old the notice", () => {
    for (const now of [T0 + SECOND, T0 + 3 * MINUTE, T0 + 60 * MINUTE]) {
      const state = prLineState(delivered(), partial(), now)
      expect(state).toMatchObject({ kind: "notified", sticky: false })
      expect(state.nextAt).toBeUndefined()
    }
  })

  test("an error seen is not a failed turn: a later answer may be missing", () => {
    expect(prLineState(delivered(), partial([failed(T0 + SECOND)]), T0 + 5 * MINUTE).kind).toBe("notified")
  })

  test("an answer seen still counts", () => {
    expect(prLineState(delivered(), partial([answer(T0 + SECOND)]), T0 + 10 * SECOND).kind).toBe("handled")
    expect(prLineState(delivered(), partial([answer(T0 + SECOND)]), T0 + 5 * MINUTE).hidden).toBe(true)
  })

  test("busy, no reply and an owed notice do not depend on the history", () => {
    expect(prLineState(delivered(), { status: "busy", assistants: [], partial: true }, T0 + 5 * MINUTE).kind).toBe(
      "working",
    )
    expect(prLineState(delivered({}, T0, { noReply: true }), partial(), T0 + SECOND).kind).toBe("noReply")
    expect(prLineState(owed(), partial(), T0 + 5 * MINUTE).kind).toBe("unresponsive")
  })
})

describe("precedence", () => {
  test("the first matching row wins", () => {
    const plain = delivered()
    const stopped = delivered({}, T0, { noReply: true })
    const later = T0 + 10 * MINUTE
    const answers = [answer(T0 + SECOND)]
    const errors = [failed(T0 + SECOND)]
    const kind = (e: PrWatchEntry, s: PrSession, now: number): PrLineKind => prLineState(e, s, now).kind

    // noReply over busy, an answer and the clock
    expect(kind(stopped, busy(answers), later)).toBe("noReply")
    expect(kind(stopped, idle(errors), later)).toBe("noReply")
    // working over an answer, an error and the clock
    expect(kind(plain, busy(answers), later)).toBe("working")
    expect(kind(plain, busy(errors), later)).toBe("working")
    expect(kind(plain, busy(), later)).toBe("working")
    // handled over an error and the clock
    expect(kind(plain, idle([...errors, ...answers]), later)).toBe("handled")
    expect(kind(plain, idle([...answers, ...errors]), T0 + 2 * SECOND)).toBe("handled")
    // turnError over the clock
    expect(kind(plain, idle(errors), later)).toBe("turnError")
    // unresponsive, then notified: only the clock decides
    expect(kind(plain, idle(), later)).toBe("unresponsive")
    expect(kind(plain, idle(), T0 + SECOND)).toBe("notified")
    // the owed notice
    expect(kind(owed(), busy(answers), T0)).toBe("awaiting")
    expect(kind(owed(), idle(), later)).toBe("unresponsive")
  })
})

describe("the outcome prefix", () => {
  const prefixes: Array<[PrOutcome, string, string, PrPrefixToken]> = [
    ["success", "✓ 通过", "✓ passed", "success"],
    ["failure", "✗ 失败", "✗ failed", "error"],
    ["merged", "已合并", "merged", "textMuted"],
    ["closed", "已关闭", "closed", "textMuted"],
    ["review", "review 有变化", "review changed", "textMuted"],
    ["deadline", "超时", "timed out", "warning"],
  ]

  test("each outcome has its text and color token, in both languages", () => {
    for (const [outcome, zh, en, token] of prefixes) {
      setLanguage("zh-CN")
      const zhState = prLineState(delivered({ outcome, delivery: undefined }), idle(), T0)
      expect(zhState.prefix).toEqual({ text: zh, token })
      expect(zhState.text).toBe(zh)
      setLanguage("en")
      const enState = prLineState(delivered({ outcome, delivery: undefined }), idle(), T0)
      expect(enState.prefix).toEqual({ text: en, token })
      expect(enState.text).toBe(en)
    }
  })

  test("the prefix never uses the brand color", () => {
    for (const [outcome] of prefixes) {
      const token = prLineState(delivered({ outcome }), busy(), T0).prefix?.token
      expect(["success", "error", "warning", "textMuted"]).toContain(token ?? "missing")
    }
  })

  test("prefix and status are joined with a middle dot", () => {
    for (const [outcome, zh] of prefixes) {
      expect(prLineState(delivered({ outcome }), busy(), T0).text).toBe(`${zh} · agent 处理中`)
    }
  })

  test("an outcome the table does not know shows no prefix instead of failing", () => {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic: an outcome the wire type does not allow (a newer server).
    const odd = delivered({ outcome: "somethingNew" as unknown as PrOutcome })
    const state = prLineState(odd, busy(), T0)
    expect(state.prefix).toBeUndefined()
    expect(state.text).toBe("agent 处理中")
  })
})

describe("English", () => {
  beforeEach(() => {
    setLanguage("en")
  })

  test("every sentence of the line", () => {
    const text = (e: PrWatchEntry, s: PrSession, now: number) => prLineState(e, s, now).text
    expect(text(watching({ checks: { total: 6, pending: 2, failed: 0, passed: 3 } }), idle(), T0)).toBe("CI 3/6")
    expect(text(watching(), idle(), T0)).toBe("waiting for CI")
    expect(text(owed(), idle(), T0)).toBe("✓ passed · waiting for the agent")
    expect(text(owed(), idle(), T0 + 3 * MINUTE)).toBe("✓ passed · agent not responding")
    expect(text(delivered({}, T0, { noReply: true }), idle(), T0)).toBe(
      "✓ passed · notified · session stopped, not resumed",
    )
    expect(text(delivered(), busy(), T0)).toBe("✓ passed · agent working")
    expect(text(delivered(), idle([answer(T0 + SECOND)]), T0 + 2 * SECOND)).toBe("✓ passed · agent handled it")
    expect(text(delivered(), idle([failed(T0 + SECOND)]), T0 + 2 * SECOND)).toBe("✓ passed · agent turn failed")
    expect(text(delivered(), idle(), T0)).toBe("✓ passed · agent notified")
    expect(text(delivered({ outcome: "deadline" }), idle(), T0)).toBe("timed out · agent notified")
  })
})

// The line is decided once and worded when it is shown (#1409): what a caller keeps is the facts, and a kept line
// follows a language switch because its words are made again, never because they were kept.
describe("facts and words", () => {
  interface Shape {
    readonly kind: PrLineKind
    readonly entry: PrWatchEntry
    readonly session: PrSession
    readonly now: number
    readonly zh: string
    readonly en: string
  }

  /** One line of every kind, how it is judged and what it says in each language. */
  const SHAPES: readonly Shape[] = [
    {
      kind: "watching",
      entry: watching({ checks: { total: 6, pending: 2, failed: 1, passed: 3 } }),
      session: idle(),
      now: T0,
      zh: "CI 3/6",
      en: "CI 3/6",
    },
    {
      kind: "awaiting",
      entry: owed(),
      session: idle(),
      now: T0,
      zh: "✓ 通过 · 等待 agent 接收",
      en: "✓ passed · waiting for the agent",
    },
    {
      kind: "notified",
      entry: delivered(),
      session: idle(),
      now: T0 + SECOND,
      zh: "✓ 通过 · 已通知 agent",
      en: "✓ passed · agent notified",
    },
    {
      kind: "working",
      entry: delivered(),
      session: busy(),
      now: T0 + SECOND,
      zh: "✓ 通过 · agent 处理中",
      en: "✓ passed · agent working",
    },
    {
      kind: "handled",
      entry: delivered(),
      session: idle([answer(T0 + SECOND)]),
      now: T0 + 2 * SECOND,
      zh: "✓ 通过 · agent 已处理",
      en: "✓ passed · agent handled it",
    },
    {
      kind: "noReply",
      entry: delivered({}, T0, { noReply: true }),
      session: idle(),
      now: T0,
      zh: "✓ 通过 · 已通知 · 会话已中止，未自动继续",
      en: "✓ passed · notified · session stopped, not resumed",
    },
    {
      kind: "turnError",
      entry: delivered(),
      session: idle([failed(T0 + SECOND)]),
      now: T0 + 2 * SECOND,
      zh: "✓ 通过 · agent 回合出错",
      en: "✓ passed · agent turn failed",
    },
    {
      kind: "unresponsive",
      entry: delivered(),
      session: idle(),
      now: T0 + 3 * MINUTE,
      zh: "✓ 通过 · agent 未响应",
      en: "✓ passed · agent not responding",
    },
    {
      kind: "settled",
      entry: delivered({ delivery: undefined }),
      session: idle(),
      now: T0,
      zh: "✓ 通过",
      en: "✓ passed",
    },
    { kind: "removed", entry: entry({ phase: "cancelled" }), session: idle(), now: T0, zh: "", en: "" },
  ]

  const LANGUAGES = ["zh-CN", "en"] as const

  test("the facts say no word, and are the same in every language", () => {
    for (const shape of SHAPES) {
      const made = LANGUAGES.map((language) => {
        setLanguage(language)
        return prLineFacts(shape.entry, shape.session, shape.now)
      })
      expect(made[0].kind, shape.kind).toBe(shape.kind)
      expect(made[0], shape.kind).toEqual(made[1])
      for (const word of ["text", "prefix", "status"]) expect(Object.keys(made[0]), shape.kind).not.toContain(word)
    }
  })

  test("judging a line reads no language: a computation over the facts does not re-run on a switch, one over the words does", () => {
    let judged = 0
    let worded = 0
    const dispose = createRoot((off) => {
      createMemo(() => {
        judged++
        return SHAPES.map((shape) => prLineFacts(shape.entry, shape.session, shape.now))
      })
      createMemo(() => {
        worded++
        return SHAPES.map((shape) =>
          prLineWords(prLineFacts(shape.entry, shape.session, shape.now), shape.entry.checks),
        )
      })
      return off
    })
    try {
      expect([judged, worded]).toEqual([1, 1])
      setLanguage("en")
      expect([judged, worded]).toEqual([1, 2])
    } finally {
      dispose()
    }
  })

  test("a line is its facts and their words", () => {
    for (const language of LANGUAGES) {
      setLanguage(language)
      for (const shape of SHAPES) {
        const facts = prLineFacts(shape.entry, shape.session, shape.now)
        expect(prLineState(shape.entry, shape.session, shape.now), `${shape.kind} in ${language}`).toEqual({
          ...facts,
          ...prLineWords(facts, shape.entry.checks),
        })
      }
    }
  })

  test("the words follow the language of the call, not the one the facts were made in", () => {
    for (const [made, drawn] of [
      ["zh-CN", "en"],
      ["en", "zh-CN"],
    ] as const) {
      for (const shape of SHAPES) {
        setLanguage(made)
        const facts = prLineFacts(shape.entry, shape.session, shape.now)
        setLanguage(drawn)
        expect(prLineWords(facts, shape.entry.checks).text, `${shape.kind}: made in ${made}`).toBe(
          shape[drawn === "en" ? "en" : "zh"],
        )
      }
    }
  })

  test("the words and tokens of a line only depend on its kind, its outcome and the CI counts", () => {
    for (const shape of SHAPES) {
      const facts = prLineFacts(shape.entry, shape.session, shape.now)
      // Whatever else the facts carry (the clock boundary, the flags), the words are the same without it.
      const bare = { kind: facts.kind, ...(facts.outcome !== undefined ? { outcome: facts.outcome } : {}) }
      expect(prLineWords(bare, shape.entry.checks), shape.kind).toEqual(prLineWords(facts, shape.entry.checks))
    }
  })

  test("a watching line counts the checks it is given and waits for CI otherwise", () => {
    expect(prLineWords({ kind: "watching" }, { passed: 3, total: 6 })).toEqual({
      text: "CI 3/6",
      status: { text: "CI 3/6", token: "textMuted" },
    })
    for (const checks of [undefined, { passed: 0, total: 0 }]) {
      expect(prLineWords({ kind: "watching" }, checks).text).toBe("等待 CI")
    }
    setLanguage("en")
    expect(prLineWords({ kind: "watching" }).text).toBe("waiting for CI")
  })

  test("a sticky kind is all the words a held warning needs: its kind and its outcome", () => {
    expect(prLineWords({ kind: "unresponsive", outcome: "failure" })).toEqual({
      text: "✗ 失败 · agent 未响应",
      prefix: { text: "✗ 失败", token: "error" },
      status: { text: "agent 未响应", token: "warning" },
    })
    setLanguage("en")
    expect(prLineWords({ kind: "turnError", outcome: "merged" })).toEqual({
      text: "merged · agent turn failed",
      prefix: { text: "merged", token: "textMuted" },
      status: { text: "agent turn failed", token: "warning" },
    })
    expect(prLineWords({ kind: "noReply" }).text).toBe("notified · session stopped, not resumed")
  })

  test("a toast is worded when it is made, whatever language the facts were made in", () => {
    setLanguage("zh-CN")
    const before = prLineFacts(delivered(), idle(), T0 + SECOND)
    const next = prLineFacts(delivered(), idle(), T0 + 3 * MINUTE)
    setLanguage("en")
    expect(prToastFor(before, next, { watchID: "w", number: 7 })).toEqual({
      key: "pr:w:unresponsive",
      text: "PR #7 agent not responding",
      level: "warning",
    })
  })
})

describe("prClockMoved", () => {
  const BOUNDARY = T0 + PR_UNRESPONSIVE_MS
  const facts = (e: PrWatchEntry, s: PrSession, now: number) => prLineFacts(e, s, now)

  test("is the notice that waited for its three minutes, once they have passed: owed or delivered", () => {
    for (const [make, before] of [
      [owed, facts(owed(), idle(), T0 + SECOND)],
      [delivered, facts(delivered(), idle(), T0 + SECOND)],
    ] as const) {
      expect(before.nextAt, make.name).toBe(BOUNDARY)
      const after = facts(make(), idle(), BOUNDARY)
      expect(after.kind).toBe("unresponsive")
      expect(prClockMoved(before, after, BOUNDARY), make.name).toBe(true)
      expect(prClockMoved(before, after, BOUNDARY + MINUTE), make.name).toBe(true)
      // Before the boundary it has not happened yet, whatever the states say.
      expect(prClockMoved(before, after, BOUNDARY - 1), make.name).toBe(false)
    }
  })

  test("is not anything else a read can bring in the same gap", () => {
    const before = facts(delivered(), idle(), T0 + SECOND)
    const clock = facts(delivered(), idle(), BOUNDARY)
    expect(prClockMoved(before, clock, BOUNDARY)).toBe(true)

    for (const [what, after] of [
      ["a stopped delivery", facts(delivered({}, T0, { noReply: true }), idle(), BOUNDARY)],
      ["a failed turn", facts(delivered(), idle([failed(T0 + SECOND)]), BOUNDARY)],
      ["an answer", facts(delivered(), idle([answer(T0 + SECOND)]), BOUNDARY)],
      ["a busy session", facts(delivered(), busy(), BOUNDARY)],
      ["another outcome", facts(delivered({ outcome: "failure" }), idle(), BOUNDARY)],
      ["a watch that is being watched again", facts(watching(), idle(), BOUNDARY)],
    ] as const) {
      expect(prClockMoved(before, after, BOUNDARY), what).toBe(false)
    }
  })

  test("only a notice waiting for its three minutes can be moved by them", () => {
    const after = facts(delivered(), idle(), BOUNDARY)
    const handled = facts(delivered(), idle([answer(T0 + SECOND)]), T0 + 10 * SECOND)
    expect(handled.nextAt).toBeDefined()
    for (const [what, before] of [
      ["a handled line", handled],
      ["a working line", facts(delivered(), busy(), T0 + SECOND)],
      ["a line that is not drawn", facts(entry({ phase: "cancelled" }), idle(), T0)],
      ["a line waiting for CI", facts(watching(), idle(), T0)],
      ["an unresponsive line", facts(delivered(), idle(), BOUNDARY)],
    ] as const) {
      expect(prClockMoved(before, after, BOUNDARY + MINUTE), what).toBe(false)
    }
  })

  test("has nothing to move without a state before it", () => {
    expect(prClockMoved(undefined, facts(delivered(), idle(), BOUNDARY), BOUNDARY)).toBe(false)
  })
})

describe("prNoticeAt", () => {
  test("is where the three minutes of an owed or delivered notice started, the boundary the line itself uses", () => {
    const owedAt = owed({ updatedAt: T0 + 5 * SECOND })
    expect(prNoticeAt(owedAt)).toBe(T0 + 5 * SECOND)
    expect(prLineState(owedAt, idle(), T0 + 6 * SECOND).nextAt).toBe(prNoticeAt(owedAt) + PR_UNRESPONSIVE_MS)

    const at = delivered({}, T0 + 7 * SECOND)
    expect(prNoticeAt(at)).toBe(T0 + 7 * SECOND)
    expect(prLineState(at, idle(), T0 + 8 * SECOND).nextAt).toBe(prNoticeAt(at) + PR_UNRESPONSIVE_MS)
  })

  test("falls back to the entry's last write when the delivery has no usable time, as the line does", () => {
    for (const deliveredAt of [undefined, Number.NaN]) {
      const odd = entry({ delivery: { state: "delivered", deliveredAt }, updatedAt: T0 + 9 * SECOND })
      expect(prNoticeAt(odd)).toBe(T0 + 9 * SECOND)
      expect(prLineState(odd, idle(), T0 + 10 * SECOND).nextAt).toBe(T0 + 9 * SECOND + PR_UNRESPONSIVE_MS)
    }
  })
})

describe("nothing remote is displayed", () => {
  test("the review text, head and URL never reach the line", () => {
    const hostile = {
      review: "\u001b[31mFAIL\u001b[0m\nleaked review",
      head: "abc\u0007def",
      url: "https://example.test/\u001b]0;title\u0007pull/1",
    }
    const entries = [
      watching({ checks: { total: 2, pending: 1, failed: 0, passed: 1 }, ...hostile }),
      owed(hostile),
      delivered(hostile),
      delivered({ outcome: "review", ...hostile }),
      delivered({ ...hostile }, T0, { noReply: true }),
    ]
    for (const language of ["zh-CN", "en"] as const) {
      setLanguage(language)
      for (const e of entries) {
        for (const session of [idle(), busy(), idle([failed(T0 + SECOND)])]) {
          const state = prLineState(e, session, T0 + 4 * MINUTE)
          const shown = [state.text, state.prefix?.text, state.status?.text].join("\n")
          expect(shown).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
          for (const secret of ["leaked", "FAIL", "abc", "def", "title", "pull/1"]) expect(shown).not.toContain(secret)
        }
      }
    }
  })
})

describe("prMark", () => {
  const at = (e: PrWatchEntry, s: PrSession, now: number) => prMark(prLineState(e, s, now))

  test("watching is ~ with or without counts", () => {
    expect(at(watching(), idle(), T0)).toBe("~")
    expect(at(watching({ checks: { total: 4, pending: 1, failed: 0, passed: 3 } }), idle(), T0)).toBe("~")
  })

  test("a sticky warning is ! and beats every other mark", () => {
    expect(at(delivered({}, T0, { noReply: true }), idle(), T0)).toBe("!")
    expect(at(delivered({ outcome: "failure" }), idle([failed(T0 + SECOND)]), T0 + 2 * SECOND)).toBe("!")
    expect(at(delivered({ outcome: "merged" }), idle(), T0 + 3 * MINUTE)).toBe("!")
    expect(at(owed({ outcome: "deadline" }), idle(), T0 + 3 * MINUTE)).toBe("!")
  })

  test("working is >, waiting for the agent is ?", () => {
    expect(at(delivered(), busy(), T0)).toBe(">")
    expect(at(delivered(), retrying(), T0)).toBe(">")
    expect(at(owed(), idle(), T0)).toBe("?")
    expect(at(delivered(), idle(), T0 + SECOND)).toBe("?")
    // working outranks the outcome, ? outranks it too
    expect(at(delivered({ outcome: "failure" }), busy(), T0)).toBe(">")
    expect(at(owed({ outcome: "failure" }), idle(), T0)).toBe("?")
  })

  test("handled and settled rows carry their outcome's mark", () => {
    const marks: Record<PrOutcome, PrMark> = {
      success: "✓",
      failure: "✗",
      merged: "M",
      closed: "C",
      review: "R",
      deadline: "T",
    }
    for (const outcome of OUTCOMES) {
      expect(at(delivered({ outcome }), idle([answer(T0 + SECOND)]), T0 + 2 * SECOND)).toBe(marks[outcome])
      expect(at(delivered({ outcome, delivery: undefined }), idle(), T0)).toBe(marks[outcome])
    }
  })

  test("a row that is not drawn has no mark", () => {
    expect(at(entry({ phase: "cancelled" }), idle(), T0)).toBeUndefined()
    expect(at(delivered(), idle([answer(T0 + SECOND)]), T0 + 5 * MINUTE)).toBeUndefined()
    expect(at(entry({ delivery: undefined, outcome: undefined }), idle(), T0)).toBeUndefined()
  })

  test("the marks are ASCII or the Neutral check marks, one cell at both ambiguous widths", () => {
    expect([...PR_MARK_CHARS].sort()).toEqual(["!", "?", "C", "M", "R", "T", ">", "~", "✓", "✗"].sort())
    for (const mark of PR_MARK_CHARS) {
      for (const aw of AMBIGUOUS_WIDTHS)
        expect({ mark, aw, cells: cellWidth(mark, aw) }).toEqual({ mark, aw, cells: 1 })
      expect(mark.length).toBe(1)
    }
  })

  test("over every reachable state prMark only returns members of PR_MARK_CHARS, and all of them occur", () => {
    const seen = new Set<string>()
    for (const e of everyEntry()) {
      for (const session of everySession()) {
        for (const now of [T0, T0 + 59 * SECOND, T0 + 3 * MINUTE - 1, T0 + 3 * MINUTE, T0 + 90 * MINUTE]) {
          const mark = prMark(prLineState(e, session, now))
          if (mark === undefined) continue
          expect(PR_MARK_CHARS.has(mark)).toBe(true)
          seen.add(mark)
        }
      }
    }
    expect([...seen].sort()).toEqual([...PR_MARK_CHARS].sort())
  })
})

/** Entries over every phase, outcome and delivery combination. */
function everyEntry(): PrWatchEntry[] {
  const phases = ["watching", "delivering", "succeeded", "failed", "expired", "cancelled"] as const
  const deliveries: PrWatchEntry["delivery"][] = [
    undefined,
    { state: "pending" },
    { state: "delivered", deliveredAt: T0 },
    { state: "delivered", deliveredAt: T0, noReply: true },
  ]
  const entries: PrWatchEntry[] = []
  for (const phase of phases) {
    for (const outcome of [undefined, ...OUTCOMES]) {
      for (const delivery of deliveries) {
        entries.push(entry({ phase, outcome, delivery, checks: { total: 3, pending: 1, failed: 0, passed: 2 } }))
      }
    }
  }
  return entries
}

function everySession(): PrSession[] {
  const assistants = [[], [answer(T0 + SECOND)], [failed(T0 + SECOND)], [failed(T0 + SECOND), answer(T0 + 2 * SECOND)]]
  return [idle, busy, retrying, unknown].flatMap((make) => assistants.map((list) => make(list)))
}

describe("prCompact", () => {
  const running: PrCompactItem = { mark: "~", number: 1036, sticky: false }
  const passed: PrCompactItem = { mark: "✓", number: 1035, sticky: false }
  const alert: PrCompactItem = { mark: "!", number: 1040, sticky: true }

  test("sticky first, then the rest in input order", () => {
    expect(prCompact([running, passed, alert], 40)).toEqual({ text: "PR !#1040 ~#1036 ✓#1035", shown: 3, hidden: 0 })
    expect(prCompact([running, passed], 40)).toEqual({ text: "PR ~#1036 ✓#1035", shown: 2, hidden: 0 })
    const items: PrCompactItem[] = [
      { mark: "~", number: 1, sticky: false },
      { mark: "!", number: 2, sticky: true },
      { mark: "✓", number: 3, sticky: false },
      { mark: "!", number: 4, sticky: true },
    ]
    expect(prCompact(items, 40).text).toBe("PR !#2 !#4 ~#1 ✓#3")
  })

  test("drops from the end and counts the rest in +k, fitting the budget exactly", () => {
    const items = [running, passed, alert]
    // "PR !#1040 ~#1036 ✓#1035" is 23 cells.
    expect(prCompact(items, 23)).toEqual({ text: "PR !#1040 ~#1036 ✓#1035", shown: 3, hidden: 0 })
    expect(prCompact(items, 22)).toEqual({ text: "PR !#1040 ~#1036 +1", shown: 2, hidden: 1 })
    expect(prCompact(items, 19)).toEqual({ text: "PR !#1040 ~#1036 +1", shown: 2, hidden: 1 })
    expect(prCompact(items, 18)).toEqual({ text: "PR !#1040 +2", shown: 1, hidden: 2 })
    expect(prCompact(items, 12)).toEqual({ text: "PR !#1040 +2", shown: 1, hidden: 2 })
    expect(prCompact(items, 11)).toEqual({ text: "PR +3", shown: 0, hidden: 3 })
    expect(prCompact(items, 5)).toEqual({ text: "PR +3", shown: 0, hidden: 3 })
  })

  test("says nothing when not even the label and the count fit, or there is nothing to say", () => {
    expect(prCompact([running, passed, alert], 4)).toEqual({ text: "", shown: 0, hidden: 3 })
    for (const budget of [0, -3, Number.NaN])
      expect(prCompact([running], budget)).toEqual({ text: "", shown: 0, hidden: 1 })
    expect(prCompact([], 40)).toEqual({ text: "", shown: 0, hidden: 0 })
  })

  test("a two-digit count of hidden PRs is paid for", () => {
    const many = Array.from({ length: 12 }, (_, index): PrCompactItem => ({
      mark: "~",
      number: 1 + index,
      sticky: false,
    }))
    // "PR ~#1 +11" is 10 cells; "PR ~#1 ~#2 +10" is 14.
    expect(prCompact(many, 10)).toEqual({ text: "PR ~#1 +11", shown: 1, hidden: 11 })
    expect(prCompact(many, 14)).toEqual({ text: "PR ~#1 ~#2 +10", shown: 2, hidden: 10 })
    expect(prCompact(many, 9)).toEqual({ text: "PR +12", shown: 0, hidden: 12 })
  })

  test("the text always fits the budget under the width model, at both ambiguous widths, and drops nothing it could keep", () => {
    // A small deterministic generator: no clock, no randomness.
    let seed = 7
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % limit
    }
    const marks: readonly PrMark[] = ["!", ">", "?", "~", "✓", "✗", "M", "C", "R", "T"]
    expect([...PR_MARK_CHARS].sort()).toEqual([...marks].sort())
    const digits = [1, 12, 123, 1234, 12345]
    const textFor = (items: readonly PrCompactItem[], shown: number) => {
      const ordered = [...items.filter((item) => item.sticky), ...items.filter((item) => !item.sticky)]
      const parts = ordered.slice(0, shown).map((item) => `${item.mark}#${item.number}`)
      const hidden = ordered.length - shown
      return ["PR", ...parts].join(" ") + (hidden > 0 ? ` +${hidden}` : "")
    }
    for (const language of ["zh-CN", "en"] as const) {
      setLanguage(language)
      for (let round = 0; round < 200; round++) {
        const items = Array.from({ length: next(7) }, (): PrCompactItem => {
          const mark = marks[next(marks.length)]
          return { mark, number: digits[next(digits.length)], sticky: mark === "!" }
        })
        const budget = next(36)
        const result = prCompact(items, budget)
        expect(result.shown + result.hidden).toBe(items.length)
        for (const aw of AMBIGUOUS_WIDTHS) {
          expect(cellWidth(result.text, aw)).toBeLessThanOrEqual(budget)
          // Maximal: one more PR would not have fit (the empty result means not even the label did).
          if (result.text !== "" && result.shown < items.length) {
            expect(cellWidth(textFor(items, result.shown + 1), aw)).toBeGreaterThan(budget)
          }
        }
        if (result.text !== "") expect(result.text).toBe(textFor(items, result.shown))
        expect(result.text).toMatch(/^[PRMCT #+0-9!>?~✓✗]*$/)
      }
    }
  })

  test("the label is ASCII in both languages, so the cell counts hold", () => {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguage(language)
      const text = prCompact([running], 40).text
      expect(text).toBe("PR ~#1036")
      for (const aw of AMBIGUOUS_WIDTHS) expect(cellWidth(text, aw)).toBe(text.length)
    }
  })
})

describe("prTailMark", () => {
  const rowOf = (e: PrWatchEntry, session: PrSession, now: number): PrTailRow => ({
    entry: e,
    state: prLineState(e, session, now),
  })
  const checks = (passed: number, total: number) => ({ total, pending: total - passed, failed: 0, passed })

  test("a single watching PR shows its counts, or ~ while waiting for CI", () => {
    expect(prTailMark([rowOf(watching({ checks: checks(4, 6) }), idle(), T0)])).toBe("PR ~4/6")
    expect(prTailMark([rowOf(watching({ checks: checks(0, 0) }), idle(), T0)])).toBe("PR ~")
    expect(prTailMark([rowOf(watching(), idle(), T0)])).toBe("PR ~")
  })

  test("a single PR otherwise shows its mark", () => {
    expect(prTailMark([rowOf(delivered(), idle([answer(T0 + SECOND)]), T0 + 2 * SECOND)])).toBe("PR ✓")
    expect(prTailMark([rowOf(delivered({ outcome: "failure" }), idle([answer(T0 + SECOND)]), T0 + 2 * SECOND)])).toBe(
      "PR ✗",
    )
    expect(prTailMark([rowOf(delivered(), busy(), T0)])).toBe("PR >")
    expect(prTailMark([rowOf(owed(), idle(), T0)])).toBe("PR ?")
    expect(prTailMark([rowOf(delivered(), idle(), T0 + 3 * MINUTE)])).toBe("PR !")
  })

  test("a count that would not fit 14 cells falls back to ~", () => {
    expect(prTailMark([rowOf(watching({ checks: checks(1234, 1234) }), idle(), T0)])).toBe("PR ~1234/1234")
    expect(prTailMark([rowOf(watching({ checks: checks(12345, 12345) }), idle(), T0)])).toBe("PR ~")
  })

  test("rows that are not drawn are skipped", () => {
    const hidden = rowOf(delivered(), idle([answer(T0 + SECOND)]), T0 + 10 * MINUTE)
    const removed = rowOf(entry({ phase: "cancelled" }), idle(), T0)
    expect(prTailMark([])).toBe("")
    expect(prTailMark([hidden, removed])).toBe("")
    expect(prTailMark([hidden, rowOf(watching({ checks: checks(1, 2) }), idle(), T0), removed])).toBe("PR ~1/2")
  })

  test("several PRs become the compact list within 14 cells", () => {
    const first = rowOf(watching({ number: 1, checks: checks(1, 2) }), idle(), T0)
    const second = rowOf(delivered({ number: 2 }), idle([answer(T0 + SECOND)]), T0 + 2 * SECOND)
    expect(prTailMark([first, second])).toBe("PR ~#1 ✓#2")
    const big = rowOf(watching({ number: 1036 }), idle(), T0)
    const other = rowOf(delivered({ number: 1035 }), idle([answer(T0 + SECOND)]), T0 + 2 * SECOND)
    // "PR ~#1036 ✓#1035" is 16 cells: one PR and the count.
    expect(prTailMark([big, other])).toBe("PR ~#1036 +1")
  })

  test("is never wider than 14 cells at either ambiguous width, in either language", () => {
    const numbers = [1, 99, 12345, 99999]
    for (const language of ["zh-CN", "en"] as const) {
      setLanguage(language)
      for (const number of numbers) {
        const pool: PrTailRow[] = [
          rowOf(watching({ number, checks: checks(99999, 99999) }), idle(), T0),
          rowOf(watching({ number }), idle(), T0),
          rowOf(owed({ number, outcome: "success" }), idle(), T0),
          rowOf(owed({ number, outcome: "failure" }), idle(), T0 + 3 * MINUTE),
          rowOf(delivered({ number, outcome: "merged" }), idle(), T0 + SECOND),
          rowOf(delivered({ number, outcome: "closed" }), busy(), T0),
          rowOf(delivered({ number, outcome: "review" }), idle([answer(T0 + SECOND)]), T0 + 2 * SECOND),
          rowOf(delivered({ number, outcome: "deadline" }), idle([failed(T0 + SECOND)]), T0 + 2 * SECOND),
          rowOf(delivered({ number }, T0, { noReply: true }), idle(), T0),
        ]
        for (let size = 1; size <= pool.length; size++) {
          for (let start = 0; start + size <= pool.length; start++) {
            const text = prTailMark(pool.slice(start, start + size))
            for (const aw of AMBIGUOUS_WIDTHS) {
              expect({ text, cells: cellWidth(text, aw) <= PR_TAIL_BUDGET }).toEqual({ text, cells: true })
            }
          }
        }
        // Nine rows at once, too.
        for (const aw of AMBIGUOUS_WIDTHS) expect(cellWidth(prTailMark(pool), aw)).toBeLessThanOrEqual(PR_TAIL_BUDGET)
      }
    }
  })
})

describe("prToastFor", () => {
  const state = (e: PrWatchEntry, s: PrSession, now: number): PrLineState => prLineState(e, s, now)

  test("the outcome appearing fires one toast per outcome, with its level and dedupe key", () => {
    const expected: Record<PrOutcome, [ToastLevel, string]> = {
      success: ["success", "PR #1036 ✓ 通过"],
      failure: ["error", "PR #1036 ✗ 失败"],
      merged: ["info", "PR #1036 已合并"],
      closed: ["info", "PR #1036 已关闭"],
      review: ["info", "PR #1036 review 有变化"],
      deadline: ["warning", "PR #1036 超时"],
    }
    const before = state(watching(), idle(), T0)
    for (const outcome of OUTCOMES) {
      const next = state(owed({ outcome }), idle(), T0)
      const toast = prToastFor(before, next, meta)
      const [level, text] = expected[outcome]
      expect(toast).toEqual({ key: `pr:watch_1:${outcome}`, text, level })
    }
  })

  test("the levels are the ones the toast accepts", () => {
    const levels: ToastLevel[] = []
    for (const outcome of OUTCOMES) {
      const toast = prToastFor(undefined, state(owed({ outcome }), idle(), T0), meta)
      if (toast) levels.push(toast.level)
    }
    expect(levels).toHaveLength(OUTCOMES.length)
  })

  test("a watch seen for the first time with an outcome fires; one with nothing to say does not", () => {
    expect(prToastFor(undefined, state(owed(), idle(), T0), meta)?.key).toBe("pr:watch_1:success")
    expect(prToastFor(undefined, state(watching(), idle(), T0), meta)).toBeUndefined()
  })

  test("an unchanged state fires nothing", () => {
    for (const next of [
      state(watching(), idle(), T0),
      state(owed(), idle(), T0),
      state(delivered(), busy(), T0),
      state(delivered({}, T0, { noReply: true }), idle(), T0),
      state(delivered(), idle([failed(T0 + SECOND)]), T0 + 2 * SECOND),
      state(delivered(), idle(), T0 + 3 * MINUTE),
    ]) {
      expect(prToastFor(next, next, meta)).toBeUndefined()
      // Recomputed from the same inputs, as a later event does.
      expect(prToastFor(next, { ...next }, meta)).toBeUndefined()
    }
  })

  test("entering a sticky warning kind fires one toast", () => {
    const awaiting = state(owed(), idle(), T0)
    const notified = state(delivered(), idle(), T0 + SECOND)
    const working = state(delivered(), busy(), T0 + SECOND)
    expect(prToastFor(awaiting, state(owed(), idle(), T0 + 3 * MINUTE), meta)).toEqual({
      key: "pr:watch_1:unresponsive",
      text: "PR #1036 agent 未响应",
      level: "warning",
    })
    expect(prToastFor(notified, state(delivered(), idle(), T0 + 3 * MINUTE), meta)?.key).toBe("pr:watch_1:unresponsive")
    expect(prToastFor(working, state(delivered(), idle([failed(T0 + SECOND)]), T0 + 2 * SECOND), meta)).toEqual({
      key: "pr:watch_1:turnError",
      text: "PR #1036 agent 回合出错",
      level: "warning",
    })
    expect(prToastFor(awaiting, state(delivered({}, T0, { noReply: true }), idle(), T0), meta)).toEqual({
      key: "pr:watch_1:noReply",
      text: "PR #1036 已通知 · 会话已中止，未自动继续",
      level: "warning",
    })
  })

  test("staying in a sticky kind fires nothing; moving to another sticky kind fires again", () => {
    const unresponsive = state(delivered(), idle(), T0 + 3 * MINUTE)
    expect(prToastFor(unresponsive, state(delivered(), idle(), T0 + 4 * MINUTE), meta)).toBeUndefined()
    const turnError = state(delivered(), idle([failed(T0 + SECOND)]), T0 + 2 * SECOND)
    expect(prToastFor(unresponsive, turnError, meta)?.key).toBe("pr:watch_1:turnError")
    // working again and failing again is a new failure
    const working = state(delivered(), busy([failed(T0 + SECOND)]), T0 + 3 * SECOND)
    expect(prToastFor(working, turnError, meta)?.key).toBe("pr:watch_1:turnError")
  })

  test("the quiet kinds fire nothing when the outcome is unchanged", () => {
    const flow = [
      state(owed(), idle(), T0),
      state(delivered(), idle(), T0 + SECOND),
      state(delivered(), busy(), T0 + 2 * SECOND),
      state(delivered(), idle([answer(T0 + 2 * SECOND)]), T0 + 4 * SECOND),
      state(delivered(), idle([answer(T0 + 2 * SECOND)]), T0 + 2 * MINUTE),
    ]
    for (let index = 1; index < flow.length; index++) {
      expect(prToastFor(flow[index - 1], flow[index], meta)).toBeUndefined()
    }
  })

  test("a warning wins over the outcome when both appear at once", () => {
    const toast = prToastFor(undefined, state(delivered(), idle(), T0 + 3 * MINUTE), meta)
    expect(toast?.key).toBe("pr:watch_1:unresponsive")
  })

  test("a removed row never toasts", () => {
    const removed = state(entry({ phase: "cancelled" }), idle(), T0)
    expect(prToastFor(undefined, removed, meta)).toBeUndefined()
    expect(prToastFor(state(owed(), idle(), T0), removed, meta)).toBeUndefined()
    expect(prToastFor(state(delivered(), idle(), T0 + 3 * MINUTE), removed, meta)).toBeUndefined()
  })

  test("the toast text follows the language and names the PR by its number", () => {
    setLanguage("en")
    expect(prToastFor(undefined, state(owed(), idle(), T0), { watchID: "w", number: 7 })?.text).toBe("PR #7 ✓ passed")
    expect(prToastFor(undefined, state(owed(), idle(), T0 + 3 * MINUTE), { watchID: "w", number: 7 })).toEqual({
      key: "pr:w:unresponsive",
      text: "PR #7 agent not responding",
      level: "warning",
    })
  })
})

describe("prAlertDismissed", () => {
  const alert = { url: "https://example.test/acme/repo/pull/1036", since: T0, watchID: "watch_1" }
  const none = { userMessages: [], watches: [] }

  test("nothing happened since: still standing", () => {
    expect(prAlertDismissed(alert, none)).toBe(false)
  })

  test("a user message after the alert dismisses it, one at or before does not", () => {
    expect(prAlertDismissed(alert, { ...none, userMessages: [{ created: T0 + 1, synthetic: false }] })).toBe(true)
    expect(prAlertDismissed(alert, { ...none, userMessages: [{ created: T0, synthetic: false }] })).toBe(false)
    expect(prAlertDismissed(alert, { ...none, userMessages: [{ created: T0 - SECOND, synthetic: false }] })).toBe(false)
  })

  test("a synthetic user message does not dismiss", () => {
    expect(prAlertDismissed(alert, { ...none, userMessages: [{ created: T0 + MINUTE, synthetic: true }] })).toBe(false)
    expect(
      prAlertDismissed(alert, {
        ...none,
        userMessages: [
          { created: T0 + MINUTE, synthetic: true },
          { created: T0 + 2 * MINUTE, synthetic: false },
        ],
      }),
    ).toBe(true)
  })

  test("a newer watch on the same URL dismisses it", () => {
    const watch = { watchID: "watch_2", url: alert.url, startedAt: T0 + 1 }
    expect(prAlertDismissed(alert, { ...none, watches: [watch] })).toBe(true)
  })

  test("the same watch, an older watch, another URL or a differently written URL do not", () => {
    const later = T0 + MINUTE
    expect(
      prAlertDismissed(alert, { ...none, watches: [{ watchID: "watch_1", url: alert.url, startedAt: later }] }),
    ).toBe(false)
    expect(prAlertDismissed(alert, { ...none, watches: [{ watchID: "watch_2", url: alert.url, startedAt: T0 }] })).toBe(
      false,
    )
    expect(
      prAlertDismissed(alert, { ...none, watches: [{ watchID: "watch_2", url: alert.url, startedAt: T0 - 1 }] }),
    ).toBe(false)
    const others = [
      "https://example.test/acme/repo/pull/1037",
      `${alert.url}/`,
      alert.url.toUpperCase(),
      `${alert.url}#comment`,
    ]
    for (const url of others) {
      expect(prAlertDismissed(alert, { ...none, watches: [{ watchID: "watch_2", url, startedAt: later }] })).toBe(false)
    }
  })

  test("either condition is enough", () => {
    const ctx = {
      userMessages: [{ created: T0 - SECOND, synthetic: false }],
      watches: [{ watchID: "watch_2", url: alert.url, startedAt: T0 + SECOND }],
    }
    expect(prAlertDismissed(alert, ctx)).toBe(true)
  })
})
