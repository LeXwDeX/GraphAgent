// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The time language of user reminders (#1072): what `/remind` accepts, how a
 * repeating reminder advances, and how times and notices are written. Pure: no
 * Effect, no database, no ambient clock. The caller passes `now`, and the zone
 * rules come from a `LocalTime` the tests can replace.
 *
 * Grammar of `/remind <when> <text>`:
 *
 * - `30m`, `2h`: that long from now.
 * - `09:00`: the next time the local wall clock shows it.
 * - `明天 09:00` / `tomorrow 09:00`: the next local day at that time.
 * - `every 1h`: first fire one interval from now, then every interval.
 *
 * plus `list` and `cancel <id>`. Anything else is a parse error, never a guess.
 */

/** The shortest repeat interval a user may ask for: five minutes. */
export const MIN_EVERY_MS = 5 * 60 * 1000

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The user's wall clock. The system implementation reads the process time zone. */
export interface LocalTime {
  /** Wall-clock fields of an instant. */
  readonly fields: (ms: number) => {
    readonly year: number
    readonly month: number
    readonly day: number
    readonly hour: number
    readonly minute: number
  }
  /** The instant at which the wall clock shows these fields; an overflowing field rolls over. */
  readonly instant: (year: number, month: number, day: number, hour: number, minute: number) => number
  /** Minutes east of UTC at an instant. */
  readonly offsetMinutes: (ms: number) => number
}

export const systemTime: LocalTime = {
  fields: (ms) => {
    const date = new Date(ms)
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    }
  },
  instant: (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute, 0, 0).getTime(),
  offsetMinutes: (ms) => -new Date(ms).getTimezoneOffset(),
}

export type Request =
  | { readonly kind: "create"; readonly fireAt: number; readonly everyMs?: number; readonly text: string }
  | { readonly kind: "list" }
  | { readonly kind: "cancel"; readonly id: string }

/**
 * Why a `/remind` line was refused: no arguments, an unreadable time, a repeat
 * interval under the minimum, a missing text, a missing id, or arguments the
 * verb does not take.
 */
export type ParseError = "usage" | "time" | "interval" | "text" | "id" | "extra"

export type Parse =
  { readonly ok: true; readonly request: Request } | { readonly ok: false; readonly error: ParseError }

const ok = (request: Request): Parse => ({ ok: true, request })
const fail = (error: ParseError): Parse => ({ ok: false, error })

/** Splits off the first whitespace-delimited token; the rest keeps its inner whitespace. */
const peel = (input: string): readonly [string, string] => {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(input)
  return match ? [match[1], match[2]] : ["", ""]
}

const duration = (token: string): number | undefined => {
  const match = /^(\d{1,5})([mh])$/i.exec(token)
  if (!match) return undefined
  const count = Number(match[1])
  if (count < 1) return undefined
  return count * (match[2].toLowerCase() === "h" ? HOUR : MINUTE)
}

const wallClock = (token: string): { readonly hour: number; readonly minute: number } | undefined => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(token)
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined
}

const withText = (fireAt: number, text: string, everyMs?: number): Parse =>
  text === "" ? fail("text") : ok({ kind: "create", fireAt, text, ...(everyMs === undefined ? {} : { everyMs }) })

export function parse(raw: string, now: number, local: LocalTime = systemTime): Parse {
  const input = raw.trim()
  if (input === "") return fail("usage")
  const [head, rest] = peel(input)
  switch (head.toLowerCase()) {
    case "list":
      return rest === "" ? ok({ kind: "list" }) : fail("extra")
    case "cancel": {
      if (rest === "") return fail("id")
      const [id, tail] = peel(rest)
      return tail === "" ? ok({ kind: "cancel", id }) : fail("extra")
    }
    case "every": {
      const [spec, text] = peel(rest)
      const everyMs = duration(spec)
      if (everyMs === undefined) return fail("time")
      if (everyMs < MIN_EVERY_MS) return fail("interval")
      return withText(now + everyMs, text, everyMs)
    }
    case "明天":
    case "tomorrow": {
      const [spec, text] = peel(rest)
      const clock = wallClock(spec)
      if (!clock) return fail("time")
      const today = local.fields(now)
      return withText(local.instant(today.year, today.month, today.day + 1, clock.hour, clock.minute), text)
    }
  }
  const after = duration(head)
  if (after !== undefined) return withText(now + after, rest)
  const clock = wallClock(head)
  if (!clock) return fail("time")
  const today = local.fields(now)
  const first = local.instant(today.year, today.month, today.day, clock.hour, clock.minute)
  return withText(
    first > now ? first : local.instant(today.year, today.month, today.day + 1, clock.hour, clock.minute),
    rest,
  )
}

/**
 * The occurrence a repeating reminder last missed: the latest `fireAt + k *
 * everyMs` at or before `now`. Several missed occurrences fold into this one.
 */
export const latestOccurrence = (fireAt: number, everyMs: number, now: number): number =>
  now <= fireAt ? fireAt : fireAt + Math.floor((now - fireAt) / everyMs) * everyMs

/** The first occurrence strictly after `now`; never earlier than one interval after `fireAt`. */
export const nextOccurrence = (fireAt: number, everyMs: number, now: number): number =>
  fireAt + everyMs * Math.max(1, Math.floor((now - fireAt) / everyMs) + 1)

const pad = (value: number) => String(value).padStart(2, "0")

/** `2026-11-16 09:00` on the user's wall clock. */
export function formatLocal(ms: number, local: LocalTime = systemTime): string {
  const f = local.fields(ms)
  return `${f.year}-${pad(f.month)}-${pad(f.day)} ${pad(f.hour)}:${pad(f.minute)}`
}

/** `2026-11-16T09:00:00+08:00`: the instant with its offset, for text a model reads. */
export function formatOffset(ms: number, local: LocalTime = systemTime): string {
  const f = local.fields(ms)
  const offset = local.offsetMinutes(ms)
  const sign = offset < 0 ? "-" : "+"
  const abs = Math.abs(offset)
  return `${f.year}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** A span the way the user reads it: `不到 1 分钟`, `29 分钟`, `1 小时 45 分钟`, `2 天 3 小时`. */
export function formatSpan(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE)
  if (minutes < 1) return "不到 1 分钟"
  const days = Math.floor(minutes / (DAY / MINUTE))
  const hours = Math.floor((minutes % (DAY / MINUTE)) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
  return `${rest} 分钟`
}

/** `每 1 小时` / `每 90 分钟`: a repeat interval the way the user wrote it. */
export function formatEvery(everyMs: number): string {
  return everyMs % HOUR === 0 ? `每 ${everyMs / HOUR} 小时` : `每 ${Math.round(everyMs / MINUTE)} 分钟`
}

export interface NoticeInput {
  readonly id: string
  readonly text: string
  /** The occurrence the notice delivers. */
  readonly fireAt: number
  readonly everyMs: number | null
  /** How long after `fireAt` the notice reaches the session. */
  readonly lateMs: number
}

/** Whole minutes a delivery is late, or 0 when it is on time (under a minute). */
export const lateMinutes = (lateMs: number): number => Math.floor(Math.max(0, lateMs) / MINUTE)

/**
 * The input the session receives when a reminder is delivered. The user's text
 * is the last block, unchanged; the header carries the schedule and, when the
 * notice arrives at least a minute after its time, how late it is.
 */
export function renderNotice(input: NoticeInput, local: LocalTime = systemTime): string {
  const late = lateMinutes(input.lateMs)
  const delay = late >= 1 ? ` (delayed ${late} minute${late === 1 ? "" : "s"})` : ""
  const every =
    input.everyMs === null
      ? ""
      : input.everyMs % HOUR === 0
        ? `; repeats every ${input.everyMs / HOUR}h`
        : `; repeats every ${Math.round(input.everyMs / MINUTE)}m`
  return [
    `[Reminder ${input.id}] The user scheduled this for ${formatOffset(input.fireAt, local)}${delay}${every}.`,
    "Tell the user about it now, and act on it if it asks for work. The user's text, unchanged:",
    "",
    input.text,
  ].join("\n")
}

export * as ReminderSchedule from "./schedule"
