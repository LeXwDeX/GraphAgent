// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The countdown the reminder band shows (#1036), pure like the rest of `pr/`: the time left as a short string
 * at minute granularity, and the one moment at which that string changes next. The band re-renders there with
 * a single `ticker.at` per step, a minute apart (an hour apart from a day out), never every second.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * Time left until a reminder fires, rounded down: `<1m`, `5m`, `1h 5m`, `2d 3h`. A zero minor part is left out
 * (`1h`, `2d`), and from a day out the minutes are not shown. A time that is not positive or not finite is `<1m`;
 * the band shows its "due" line from the moment the reminder fires, so that text is never read for it.
 */
export function formatReminderIn(ms: number): string {
  const left = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (left < MINUTE_MS) return "<1m"
  if (left < HOUR_MS) return `${Math.floor(left / MINUTE_MS)}m`
  if (left < DAY_MS) {
    const hours = Math.floor(left / HOUR_MS)
    const minutes = Math.floor((left % HOUR_MS) / MINUTE_MS)
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
  }
  const days = Math.floor(left / DAY_MS)
  const hours = Math.floor((left % DAY_MS) / HOUR_MS)
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`
}

/**
 * The first millisecond at which `formatReminderIn(fireAt - t)` differs from its value at `now`: one past the
 * moment the time left drops under a whole number of minutes (of hours, from a day out). In the last minute the
 * string stays `<1m`, so the next change is `fireAt` itself, when the band turns to its "due" line. `undefined`
 * once the reminder is due: nothing changes by the clock after that.
 */
export function reminderNextAt(fireAt: number, now: number): number | undefined {
  const left = fireAt - now
  if (!Number.isFinite(left) || left <= 0) return undefined
  if (left < MINUTE_MS) return fireAt
  const step = left >= DAY_MS ? HOUR_MS : MINUTE_MS
  return fireAt - Math.floor(left / step) * step + 1
}
