// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { setLanguage, t } from "../../src/i18n"
import { formatReminderIn, reminderNextAt } from "../../src/pr/reminder"

// No clocks and no sleeps: every time is an argument.
const T0 = 1_700_000_000_000
const SECOND = 1_000
const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

afterEach(() => {
  setLanguage("zh-CN")
})

describe("formatReminderIn", () => {
  test("under a minute is <1m, rounding down", () => {
    for (const ms of [1, SECOND, 59_999]) expect(formatReminderIn(ms)).toBe("<1m")
  })

  test("a time that is not positive or not finite is <1m", () => {
    for (const ms of [0, -1, -5 * MINUTE, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatReminderIn(ms)).toBe("<1m")
    }
  })

  test("minutes below an hour", () => {
    expect(formatReminderIn(MINUTE)).toBe("1m")
    expect(formatReminderIn(2 * MINUTE - 1)).toBe("1m")
    expect(formatReminderIn(5 * MINUTE)).toBe("5m")
    expect(formatReminderIn(5 * MINUTE + 59_999)).toBe("5m")
    expect(formatReminderIn(HOUR - 1)).toBe("59m")
  })

  test("hours and minutes below a day, leaving out zero minutes", () => {
    expect(formatReminderIn(HOUR)).toBe("1h")
    expect(formatReminderIn(HOUR + 59_999)).toBe("1h")
    expect(formatReminderIn(HOUR + 5 * MINUTE)).toBe("1h 5m")
    expect(formatReminderIn(23 * HOUR + 59 * MINUTE + 59_999)).toBe("23h 59m")
  })

  test("days and hours from a day out, leaving out zero hours and never showing minutes", () => {
    expect(formatReminderIn(DAY)).toBe("1d")
    expect(formatReminderIn(DAY + HOUR - 1)).toBe("1d")
    expect(formatReminderIn(DAY + 3 * HOUR)).toBe("1d 3h")
    expect(formatReminderIn(2 * DAY + 3 * HOUR + 59 * MINUTE)).toBe("2d 3h")
    expect(formatReminderIn(30 * DAY + 23 * HOUR)).toBe("30d 23h")
  })
})

describe("reminderNextAt", () => {
  const fireAt = T0 + 2 * DAY + 3 * HOUR + 10 * MINUTE

  const at = (now: number, target = fireAt) => formatReminderIn(target - now)

  test("is undefined once the reminder is due", () => {
    expect(reminderNextAt(T0, T0)).toBeUndefined()
    expect(reminderNextAt(T0, T0 + 1)).toBeUndefined()
    expect(reminderNextAt(T0, T0 + DAY)).toBeUndefined()
    expect(reminderNextAt(Number.NaN, T0)).toBeUndefined()
  })

  test("in the last minute the next change is the due time itself", () => {
    expect(reminderNextAt(T0 + 59_999, T0)).toBe(T0 + 59_999)
    expect(reminderNextAt(T0 + 1, T0)).toBe(T0 + 1)
    expect(reminderNextAt(T0 + 30 * SECOND, T0)).toBe(T0 + 30 * SECOND)
  })

  test("minute boundaries: one millisecond after the time left drops under a whole minute", () => {
    const target = T0 + 5 * MINUTE + 30 * SECOND
    expect(at(T0, target)).toBe("5m")
    const next = reminderNextAt(target, T0)
    expect(next).toBe(T0 + 30 * SECOND + 1)
    expect(formatReminderIn(target - (next! - 1))).toBe("5m")
    expect(formatReminderIn(target - next!)).toBe("4m")
  })

  test("exactly on a boundary the string is still the old one, and changes a millisecond later", () => {
    const target = T0 + 5 * MINUTE
    expect(formatReminderIn(target - T0)).toBe("5m")
    expect(reminderNextAt(target, T0)).toBe(T0 + 1)
  })

  test("below a day it changes every minute, from a day out every hour", () => {
    // 1h 5m 20s left: "1h 5m" until 1h 5m 0.001s are gone.
    const target = T0 + HOUR + 5 * MINUTE + 20 * SECOND
    expect(reminderNextAt(target, T0)).toBe(T0 + 20 * SECOND + 1)
    expect(formatReminderIn(target - (T0 + 20 * SECOND + 1))).toBe("1h 4m")
    // 2d 3h 10m left: "2d 3h" until the hour is used up.
    expect(at(T0)).toBe("2d 3h")
    const next = reminderNextAt(fireAt, T0)
    expect(next).toBe(T0 + 10 * MINUTE + 1)
    expect(formatReminderIn(fireAt - (next! - 1))).toBe("2d 3h")
    expect(formatReminderIn(fireAt - next!)).toBe("2d 2h")
  })

  test("the day boundary is crossed on the right string", () => {
    // Exactly a day left: "1d", and a millisecond later "23h 59m".
    const target = T0 + DAY
    expect(reminderNextAt(target, T0)).toBe(T0 + 1)
    expect(formatReminderIn(target - (T0 + 1))).toBe("23h 59m")
    // 23h 59m 30s left: the minute regime, next change when 23h 59m is used up.
    const near = T0 + 30 * SECOND
    expect(formatReminderIn(target - near)).toBe("23h 59m")
    expect(reminderNextAt(target, near)).toBe(near + 30 * SECOND + 1)
    expect(formatReminderIn(target - (near + 30 * SECOND + 1))).toBe("23h 58m")
  })

  test("the first change after now is exactly where the string changes", () => {
    // Deterministic spread over seconds to months, with and without whole-minute alignment.
    let seed = 11
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % limit
    }
    for (let round = 0; round < 500; round++) {
      const left = round % 5 === 0 ? (1 + next(2000)) * MINUTE : 1 + next(90 * DAY)
      const target = T0 + left
      const when = reminderNextAt(target, T0)!
      expect(when).toBeGreaterThan(T0)
      if (left < MINUTE) {
        expect(when).toBe(target)
        continue
      }
      expect(formatReminderIn(target - when)).not.toBe(formatReminderIn(left))
      // Nothing changed in between: it is the first change.
      expect(formatReminderIn(target - (when - 1))).toBe(formatReminderIn(left))
    }
  })

  test("following nextAt re-renders once per minute, not once per second", () => {
    const target = T0 + 5 * MINUTE + 30 * SECOND
    const strings: string[] = []
    const times: number[] = []
    let now: number | undefined = T0
    while (now !== undefined) {
      // At the due time the band switches to its "due" line, so no countdown is read there.
      if (now < target) strings.push(formatReminderIn(target - now))
      times.push(now)
      now = reminderNextAt(target, now)
    }
    expect(strings).toEqual(["5m", "4m", "3m", "2m", "1m", "<1m"])
    // Six renders of the countdown and one wake-up at the due time; then the walk ends.
    expect(times).toHaveLength(7)
    expect(times[5]).toBe(target - 59_999)
    expect(times[6]).toBe(target)
    expect(reminderNextAt(target, target)).toBeUndefined()
  })

  test("from a day out the steps are an hour apart", () => {
    const target = T0 + 3 * DAY + 5 * MINUTE
    const steps: number[] = []
    let now: number | undefined = T0
    while (now !== undefined && target - now >= DAY) {
      steps.push(now)
      now = reminderNextAt(target, now)
    }
    // After the first step each one is exactly an hour after the one before.
    for (let index = 2; index < steps.length; index++) expect(steps[index] - steps[index - 1]).toBe(HOUR)
    expect(steps.length).toBeLessThanOrEqual(3 * 24 + 2)
  })
})

describe("the reminder band text", () => {
  test("uses the countdown in both languages", () => {
    const time = formatReminderIn(5 * MINUTE)
    setLanguage("zh-CN")
    expect(t("reminder.band.in", { time, text: "check the deploy" })).toBe("提醒 · 5m后 · check the deploy")
    expect(t("reminder.band.due", { text: "check the deploy" })).toBe("提醒 · 已到期 · check the deploy")
    setLanguage("en")
    expect(t("reminder.band.in", { time, text: "check the deploy" })).toBe("reminder · in 5m · check the deploy")
    expect(t("reminder.band.due", { text: "check the deploy" })).toBe("reminder · due · check the deploy")
  })
})
