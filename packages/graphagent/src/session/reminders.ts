import path from "path"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@graphagent/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import { GraphAgentPrompt } from "@graphagent/core/system-context/graphagent"

export function planModePrompt(input: { plan: string; exists: boolean; tools: readonly string[] }) {
  return PLAN_MODE.replace(
    "${planInfo}",
    () =>
      `${input.exists ? "A plan file already exists" : "No plan file exists yet"} at ${input.plan}. ${GraphAgentPrompt.editingInstruction(input.tools)}`,
  ).replace("${planExit}", () =>
    input.tools.includes("plan_exit")
      ? "Call plan_exit when the plan is ready for user approval."
      : "When the plan is ready, present it to the user and wait for them to switch modes before implementation.",
  )
}

const textReminder = (message: SessionV1.WithParts, text: string): SessionV1.TextPart => ({
  id: PartID.ascending(),
  messageID: message.info.id,
  sessionID: message.info.sessionID,
  type: "text",
  text,
  synthetic: true,
})

const appendPart = (
  messages: SessionV1.WithParts[],
  target: SessionV1.WithParts,
  part: SessionV1.Part,
): SessionV1.WithParts[] =>
  messages.map((message) =>
    message.info.id === target.info.id ? { ...message, parts: [...message.parts, part] } : message,
  )

const retarget = (
  messages: SessionV1.WithParts[],
  parts: readonly SessionV1.TextPart[],
  text: string,
): SessionV1.WithParts[] => {
  const ids = new Set(parts.map((part) => part.id))
  return messages.map((message) => {
    if (!message.parts.some((part) => ids.has(part.id))) return message
    return {
      ...message,
      parts: message.parts.map((part) => (ids.has(part.id) ? { ...part, text } : part)),
    }
  })
}

/**
 * Builds the request copy of the history with plan-mode reminders. The input is
 * read-only: reminders are appended to (or refreshed in) returned copies, so a
 * frozen history view stays frozen. Persisted reminders are still written
 * through `Session.updatePart`, matching the stored transcript.
 */
export const derive = Effect.fn("SessionReminders.derive")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
  tools: readonly string[]
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const messages = input.messages
  const userMessage = messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return messages

  if (!flags.experimentalPlanMode) {
    let next = messages
    if (input.agent.name === "plan") next = appendPart(next, userMessage, textReminder(userMessage, PROMPT_PLAN))
    // Only the turn that leaves plan mode needs the switch. An older plan turn
    // left in history must not re-inject it on every later build step.
    const lastAssistant = messages.findLast((msg) => msg.info.role === "assistant")
    if (lastAssistant?.info.agent === "plan" && input.agent.name === "build") {
      const already = userMessage.parts.some(
        (part) => part.type === "text" && part.synthetic === true && part.text === BUILD_SWITCH,
      )
      if (!already) next = appendPart(next, userMessage, textReminder(userMessage, BUILD_SWITCH))
    }
    return next
  }

  const assistantMessage = messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    return appendPart(messages, userMessage, part)
  }

  if (input.agent.name !== "plan") return messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  const text = planModePrompt({ plan, exists, tools: input.tools })
  const reminders = messages.flatMap((message) =>
    message.parts.filter(
      (part): part is SessionV1.TextPart =>
        part.type === "text" &&
        part.synthetic === true &&
        part.text.startsWith("<system-reminder>\n# Plan mode") &&
        part.text.includes("\n# Plan file\n"),
    ),
  )
  if (reminders.length) {
    // Persisted reminders belong to earlier tool sets. Refresh the request copy
    // after permissions and step limits, without adding another history part.
    return retarget(messages, reminders, text)
  }
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text,
    synthetic: true,
  })
  return appendPart(messages, userMessage, part)
})

export * as SessionReminders from "./reminders"
