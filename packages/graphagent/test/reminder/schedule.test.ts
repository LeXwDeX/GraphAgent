// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ReminderSchedule } from "@/reminder/schedule"

/**
 * #1072: the time language of `/remind`. The wall clock is a fixed UTC+8 zone so
 * "09:00" and "明天 09:00" mean the same instant on every machine.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const OFFSET = 8 * 60

/** A fixed-offset zone, minutes east of UTC. */
const zoneFor = (offset: number): ReminderSchedule.LocalTime => ({
  fields: (ms) => {
    const date = new Date(ms + offset * MINUTE)
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    }
  },
  instant: (year, month, day, hour, minute) => Date.UTC(year, month - 1, day, hour, minute) - offset * MINUTE,
  offsetMinutes: () => offset,
})

const zone = zoneFor(OFFSET)

/** A local wall-clock time in the test zone, as an epoch instant. */
const at = (year: number, month: number, day: number, hour: number, minute = 0) =>
  zone.instant(year, month, day, hour, minute)

const NOW = at(2026, 11, 16, 8, 30)

const parse = (raw: string, now = NOW) => ReminderSchedule.parse(raw, now, zone)

const create = (raw: string, now = NOW) => {
  const parsed = parse(raw, now)
  if (!parsed.ok || parsed.request.kind !== "create") throw new Error(`expected a create request for ${raw}`)
  return parsed.request
}

describe("ReminderSchedule.parse", () => {
  test("a duration counts from now: 30m and 2h", () => {
    expect(create("30m check the logs")).toEqual({ kind: "create", fireAt: NOW + 30 * MINUTE, text: "check the logs" })
    expect(create("2h check the logs")).toEqual({ kind: "create", fireAt: NOW + 2 * HOUR, text: "check the logs" })
    // The unit is case-insensitive; the count is a positive integer.
    expect(create("1H x").fireAt).toBe(NOW + HOUR)
  })

  test("a clock time is the next time the wall clock shows it", () => {
    expect(create("09:00 standup").fireAt).toBe(at(2026, 11, 16, 9))
    expect(create("9:05 standup").fireAt).toBe(at(2026, 11, 16, 9, 5))
    // Already past today: tomorrow.
    expect(create("08:00 standup").fireAt).toBe(at(2026, 11, 17, 8))
    // The same minute is not in the future either.
    expect(create("08:30 standup").fireAt).toBe(at(2026, 11, 17, 8, 30))
  })

  test("明天 and tomorrow mean the next local day, whatever the time of day", () => {
    expect(create("明天 09:00 继续 Issue 1072")).toEqual({
      kind: "create",
      fireAt: at(2026, 11, 17, 9),
      text: "继续 Issue 1072",
    })
    expect(create("tomorrow 23:30 x").fireAt).toBe(at(2026, 11, 17, 23, 30))
    // Even a clock time later today lands tomorrow.
    expect(create("明天 12:00 x").fireAt).toBe(at(2026, 11, 17, 12))
  })

  test("tomorrow rolls over the end of the month and year", () => {
    expect(create("明天 09:00 x", at(2026, 11, 30, 20)).fireAt).toBe(at(2026, 12, 1, 9))
    expect(create("明天 09:00 x", at(2026, 12, 31, 20)).fireAt).toBe(at(2027, 1, 1, 9))
  })

  test("every starts one interval from now and carries the interval", () => {
    expect(create("every 1h check the logs")).toEqual({
      kind: "create",
      fireAt: NOW + HOUR,
      everyMs: HOUR,
      text: "check the logs",
    })
    expect(create("EVERY 90m x")).toMatchObject({ fireAt: NOW + 90 * MINUTE, everyMs: 90 * MINUTE })
  })

  test("the shortest repeat interval is five minutes", () => {
    expect(ReminderSchedule.MIN_EVERY_MS).toBe(5 * MINUTE)
    expect(create("every 5m x").everyMs).toBe(5 * MINUTE)
    expect(parse("every 4m x")).toEqual({ ok: false, error: "interval" })
    // A one-shot reminder has no minimum.
    expect(create("1m x").fireAt).toBe(NOW + MINUTE)
  })

  test("the user's text is relayed verbatim, inner whitespace and lines included", () => {
    expect(create("30m  first line\n  second   line  ").text).toBe("first line\n  second   line")
    expect(create("30m 提醒：检查 `bun test` 的输出").text).toBe("提醒：检查 `bun test` 的输出")
  })

  test("list and cancel take their own shapes", () => {
    expect(parse("list")).toEqual({ ok: true, request: { kind: "list" } })
    expect(parse("  LIST  ")).toEqual({ ok: true, request: { kind: "list" } })
    expect(parse("cancel rmd_ab12cd34")).toEqual({ ok: true, request: { kind: "cancel", id: "rmd_ab12cd34" } })
  })

  test("everything else is a typed parse error, never a guess", () => {
    expect(parse("")).toEqual({ ok: false, error: "usage" })
    expect(parse("   ")).toEqual({ ok: false, error: "usage" })
    expect(parse("30m")).toEqual({ ok: false, error: "text" })
    expect(parse("every 1h")).toEqual({ ok: false, error: "text" })
    expect(parse("明天 09:00")).toEqual({ ok: false, error: "text" })
    expect(parse("09:00")).toEqual({ ok: false, error: "text" })
    for (const raw of [
      "soon x",
      "30 x",
      "0m x",
      "100000h x",
      "30s x",
      "1h30m x",
      "25:00 x",
      "09:60 x",
      "every x",
      "every",
      "every 1d x",
      "明天 x",
      "明天",
    ])
      expect(parse(raw), raw).toEqual({ ok: false, error: "time" })
    expect(parse("list now")).toEqual({ ok: false, error: "extra" })
    expect(parse("cancel")).toEqual({ ok: false, error: "id" })
    expect(parse("cancel a b")).toEqual({ ok: false, error: "extra" })
  })
})

describe("ReminderSchedule occurrences", () => {
  const every = HOUR
  const first = at(2026, 11, 16, 10)

  test("the latest occurrence folds every missed one into the most recent", () => {
    expect(ReminderSchedule.latestOccurrence(first, every, first)).toBe(first)
    expect(ReminderSchedule.latestOccurrence(first, every, first + 30 * MINUTE)).toBe(first)
    // Down from 10:00 until 12:30: occurrences 10:00, 11:00, 12:00 were missed, 12:00 is the one delivered.
    expect(ReminderSchedule.latestOccurrence(first, every, at(2026, 11, 16, 12, 30))).toBe(at(2026, 11, 16, 12))
    expect(ReminderSchedule.latestOccurrence(first, every, at(2026, 11, 16, 12))).toBe(at(2026, 11, 16, 12))
    // A clock that reads earlier than the occurrence keeps it.
    expect(ReminderSchedule.latestOccurrence(first, every, first - MINUTE)).toBe(first)
  })

  test("the next occurrence is strictly after now and keeps the schedule's phase", () => {
    expect(ReminderSchedule.nextOccurrence(first, every, first)).toBe(at(2026, 11, 16, 11))
    expect(ReminderSchedule.nextOccurrence(first, every, at(2026, 11, 16, 12, 30))).toBe(at(2026, 11, 16, 13))
    expect(ReminderSchedule.nextOccurrence(first, every, at(2026, 11, 16, 12))).toBe(at(2026, 11, 16, 13))
    // Never earlier than one interval after the delivered occurrence.
    expect(ReminderSchedule.nextOccurrence(first, every, first - MINUTE)).toBe(at(2026, 11, 16, 11))
  })
})

describe("ReminderSchedule formatting", () => {
  test("times are written on the user's wall clock", () => {
    expect(ReminderSchedule.formatLocal(at(2026, 11, 16, 9, 5), zone)).toBe("2026-11-16 09:05")
    expect(ReminderSchedule.formatOffset(at(2026, 11, 16, 9, 5), zone)).toBe("2026-11-16T09:05:00+08:00")
    expect(ReminderSchedule.formatOffset(0, zoneFor(-(5 * 60 + 30)))).toBe("1969-12-31T18:30:00-05:30")
  })

  test("a span is read the way people say it", () => {
    expect(ReminderSchedule.formatSpan(0)).toBe("不到 1 分钟")
    expect(ReminderSchedule.formatSpan(59_999)).toBe("不到 1 分钟")
    expect(ReminderSchedule.formatSpan(29 * MINUTE + 59_000)).toBe("29 分钟")
    expect(ReminderSchedule.formatSpan(HOUR)).toBe("1 小时")
    expect(ReminderSchedule.formatSpan(105 * MINUTE)).toBe("1 小时 45 分钟")
    expect(ReminderSchedule.formatSpan(26 * HOUR + 10 * MINUTE)).toBe("1 天 2 小时")
    expect(ReminderSchedule.formatSpan(48 * HOUR)).toBe("2 天")
    expect(ReminderSchedule.formatSpan(-5)).toBe("不到 1 分钟")
  })

  test("a repeat interval is written in hours when it is whole hours", () => {
    expect(ReminderSchedule.formatEvery(HOUR)).toBe("每 1 小时")
    expect(ReminderSchedule.formatEvery(2 * HOUR)).toBe("每 2 小时")
    expect(ReminderSchedule.formatEvery(90 * MINUTE)).toBe("每 90 分钟")
    expect(ReminderSchedule.formatEvery(5 * MINUTE)).toBe("每 5 分钟")
  })
})

describe("ReminderSchedule.renderNotice", () => {
  const base = { id: "rmd_ab12cd34", text: "check the L5 smoke test", fireAt: at(2026, 11, 16, 9), everyMs: null }

  test("relays the user's text unchanged as the last block", () => {
    const text = ReminderSchedule.renderNotice({ ...base, lateMs: 0 }, zone)
    expect(text.endsWith("\n\ncheck the L5 smoke test")).toBe(true)
    expect(text).toContain("[Reminder rmd_ab12cd34]")
    expect(text).toContain("2026-11-16T09:00:00+08:00")
    const multiline = ReminderSchedule.renderNotice({ ...base, text: "line one\n\n  line two", lateMs: 0 }, zone)
    expect(multiline.endsWith("\n\nline one\n\n  line two")).toBe(true)
  })

  test("marks the delay only when the notice is at least a minute late", () => {
    expect(ReminderSchedule.renderNotice({ ...base, lateMs: 0 }, zone)).not.toContain("delayed")
    expect(ReminderSchedule.renderNotice({ ...base, lateMs: 59_999 }, zone)).not.toContain("delayed")
    expect(ReminderSchedule.renderNotice({ ...base, lateMs: MINUTE }, zone)).toContain("(delayed 1 minute)")
    expect(ReminderSchedule.renderNotice({ ...base, lateMs: 12 * MINUTE + 30_000 }, zone)).toContain(
      "(delayed 12 minutes)",
    )
    expect(ReminderSchedule.renderNotice({ ...base, lateMs: -5 * MINUTE }, zone)).not.toContain("delayed")
    expect(ReminderSchedule.lateMinutes(12 * MINUTE + 30_000)).toBe(12)
  })

  test("says when a reminder repeats", () => {
    expect(ReminderSchedule.renderNotice({ ...base, everyMs: HOUR, lateMs: 0 }, zone)).toContain("repeats every 1h")
    expect(ReminderSchedule.renderNotice({ ...base, everyMs: 90 * MINUTE, lateMs: 0 }, zone)).toContain(
      "repeats every 90m",
    )
    expect(ReminderSchedule.renderNotice({ ...base, lateMs: 0 }, zone)).not.toContain("repeats")
  })
})
