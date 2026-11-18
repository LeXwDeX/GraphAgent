// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Clock, Effect, Option } from "effect"
import { SessionRole } from "@/session/role"
import { ReminderClock } from "./clock"
import { ReminderSchedule } from "./schedule"

/**
 * What `/remind` does and says (#1072). The session's command dispatch
 * (`session/command.ts`) records the exchange as ignored command parts, like
 * `/memory` and `/dag-mode`; this module is the part that creates, lists and
 * cancels reminders and writes the receipt text. Reminders are only ever
 * created here, from the user's own command: the model has no tool for it.
 */

export interface Input {
  readonly sessionID: string
  /** Set for a child session; reminders belong to top-level sessions only. */
  readonly parentID?: string | undefined
  readonly arguments: string
}

const USAGE = [
  "用法：",
  "/remind <30m|2h|09:00|明天 09:00|every 1h> <文本>：创建提醒（every 的间隔最短 5 分钟）",
  "/remind list：列出本会话待触发的提醒",
  "/remind cancel <id>：取消提醒",
].join("\n")

const ERRORS: Record<ReminderSchedule.ParseError, string> = {
  usage: USAGE,
  time: `无法识别时间。\n${USAGE}`,
  interval: "重复间隔最短 5 分钟。",
  text: `缺少提醒文本。\n${USAGE}`,
  id: "缺少提醒 id，用 /remind list 查看。",
  extra: `多余的参数。\n${USAGE}`,
}

/** One line of the list: the text collapsed to a single line and cut at 60 characters. */
const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  const chars = Array.from(flat)
  return chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : flat
}

const when = (info: ReminderClock.Info, now: number): string => {
  const at = ReminderSchedule.formatLocal(info.fireAt)
  const repeat = info.everyMs === null ? "" : `，${ReminderSchedule.formatEvery(info.everyMs)}重复`
  // `due` is owed to the session and goes out at the next turn boundary.
  if (info.status === "due") return `${at}（已到期，当前回合结束后送达）${repeat}`
  return `${at}（${ReminderSchedule.formatSpan(info.fireAt - now)}后）${repeat}`
}

/** Runs one `/remind` line for a session and returns the receipt text. */
export const run = Effect.fn("ReminderCommand.run")(function* (input: Input) {
  if (SessionRole.isChild(input)) return "提醒只适用于主会话。"
  const clock = Option.getOrUndefined(yield* Effect.serviceOption(ReminderClock.Service))
  if (!clock) return "提醒服务当前不可用。"
  const now = yield* Clock.currentTimeMillis
  const parsed = ReminderSchedule.parse(input.arguments, now)
  if (!parsed.ok) return ERRORS[parsed.error]
  const request = parsed.request
  if (request.kind === "create") {
    const created = yield* clock.create({
      sessionID: input.sessionID,
      text: request.text,
      fireAt: request.fireAt,
      ...(request.everyMs === undefined ? {} : { everyMs: request.everyMs }),
    })
    return `已设置提醒 ${created.id}：${when(created, now)}\n${created.text}`
  }
  if (request.kind === "list") {
    const live = yield* clock.list(input.sessionID)
    if (live.length === 0) return "本会话没有待触发的提醒。"
    return [
      `本会话的提醒（${live.length}）：`,
      ...live.map((info) => `${info.id}  ${when(info, now)}  ${oneLine(info.text)}`),
    ].join("\n")
  }
  const cancelled = yield* clock.cancel({ sessionID: input.sessionID, id: request.id })
  return cancelled
    ? `已取消提醒 ${cancelled.id}。`
    : `没有找到可取消的提醒 ${request.id}（可能已触发、已取消，或不属于本会话）。`
})

export * as ReminderCommand from "./command"
