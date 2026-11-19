import path from "path"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Cause, Effect, Option } from "effect"
import { Agent } from "@/agent/agent"
import { DagMode } from "@/dag/mode"
import { FSUtil } from "@graphagent/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageV2 } from "./message-v2"
import { ReminderState } from "./reminder-state"
import { PartID } from "./schema"
import { Session } from "./session"
import { Todo } from "./todo"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import { GraphAgentPrompt } from "@graphagent/core/system-context/graphagent"
import { Injection } from "@graphagent/core/system-context/injection"

// A state reminder is an engine note of source "reminder": the block says who wrote it and what it is worth.
const stateBlock = (kind: ReminderState.Kind, text: string) => Injection.wrap("reminder", text, { kind })
const planBlock = (text: string) => stateBlock("plan", text.trim())
const BUILD_SWITCH_TEXT = BUILD_SWITCH.trim()

/** The plan agent's prompt, as the user message that opens a turn of the plan agent carries it. */
export const PLAN_REMINDER = planBlock(PROMPT_PLAN)
/** The note on the turn that leaves plan mode. */
export const BUILD_SWITCH_REMINDER = planBlock(BUILD_SWITCH_TEXT)

export function planModePrompt(input: { plan: string; exists: boolean; tools: readonly string[] }) {
  return planBlock(
    PLAN_MODE.replace(
      "${planInfo}",
      () =>
        `${input.exists ? "A plan file already exists" : "No plan file exists yet"} at ${input.plan}. ${GraphAgentPrompt.editingInstruction(input.tools)}`,
    ).replace("${planExit}", () =>
      input.tools.includes("plan_exit")
        ? "Call plan_exit when the plan is ready for user approval."
        : "When the plan is ready, present it to the user and wait for them to switch modes before implementation.",
    ),
  )
}

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
 * Builds the request copy of the history with the experimental plan mode's
 * reminders (`GRAPHAGENT_PLAN_MODE`); the default plan reminder is a state
 * reminder, written by `settle`. The input is read-only: reminders are appended
 * to (or refreshed in) returned copies, so a frozen history view stays frozen.
 * Persisted reminders are still written through `Session.updatePart`, matching
 * the stored transcript.
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
  if (!flags.experimentalPlanMode) return messages
  const userMessage = messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return messages

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
        ? planBlock(
            `${BUILD_SWITCH_TEXT}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`,
          )
        : BUILD_SWITCH_REMINDER,
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
        Injection.has(part.text) &&
        part.text.includes("\n# Plan mode\n") &&
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

export function renderReminder(uncompleted: readonly Todo.Info[]): string {
  const lines = uncompleted.map((todo) => `- ${todo.status}: ${todo.content}`)
  return [
    `[todo reminder] ${uncompleted.length} uncompleted todo item${uncompleted.length === 1 ? "" : "s"}:`,
    ...lines,
    "Keep the list current: mark items completed when done, adjust stale entries, and set in_progress only for the item you are actively working on. Update via todowrite.",
  ].join("\n")
}

/** What each state reminder says when its state is gone; the earlier note stays in the history. */
const CLEARED: Readonly<Record<ReminderState.Kind, string>> = {
  plan: BUILD_SWITCH_REMINDER,
  todo: stateBlock("todo", "[todo reminder] No uncompleted todo items remain."),
  dag: stateBlock("dag", DagMode.REMINDER_CLEARED),
}

// The plan note: the plan agent's prompt. The experimental plan mode keeps its own persisted reminders (`derive`).
const planState = (flags: RuntimeFlags.Info, agent: Agent.Info): ReminderState.Desired =>
  flags.experimentalPlanMode ? ReminderState.SKIP : agent.name === "plan" ? PLAN_REMINDER : undefined

// The message an automatic compaction appends to continue the turn: its text is marked by `SessionCompaction`.
const isCompactionContinue = (message: SessionV1.WithParts) =>
  message.parts.some(
    (part) => part.type === "text" && part.synthetic === true && part.metadata?.compaction_continue === true,
  )

// The todo note: the uncompleted items. A session that cannot call todowrite, a missing Todo service and a todo list
// that cannot be read leave the note as it is: it is decoration and never fails a turn. A turn that opens with the
// continuation text of an automatic compaction leaves it too: that text lists the same open items, and the compaction
// took the earlier note away, so the note would say them twice in one message. The next user message writes it.
const todoState = Effect.fnUntraced(function* (tail: SessionV1.WithParts, tools: readonly string[]) {
  if (!tools.includes("todowrite")) return ReminderState.SKIP
  const todo = yield* Effect.serviceOption(Todo.Service)
  if (Option.isNone(todo)) return ReminderState.SKIP
  const items = yield* todo.value
    .get(tail.info.sessionID)
    .pipe(
      Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(undefined))),
    )
  if (items === undefined) return ReminderState.SKIP
  const open = items.filter((item) => item.status !== "completed" && item.status !== "cancelled")
  if (open.length === 0) return undefined
  return isCompactionContinue(tail) ? ReminderState.SKIP : stateBlock("todo", renderReminder(open))
})

// The DAG note: on while the mode is on, published and available. A turn an automation opened is not the user's.
const dagState = (tail: SessionV1.WithParts, eligible: boolean): ReminderState.Desired =>
  MessageV2.isAutomationMessage(tail) ? ReminderState.SKIP : eligible ? stateBlock("dag", DagMode.REMINDER) : undefined

/**
 * Writes the state reminders a turn owes into the user message that opens it (Issue #1456, PR3): a note per state that
 * differs from what the history already says (`ReminderState.pending`). It works on the first request of a turn only:
 * the request whose last message is the latest user message, not a local command. Later steps of the turn find the
 * notes in the history; a state that changes mid-turn waits for the next turn. Each note is persisted as a synthetic
 * text part marked with `ReminderState.KEY`, and the returned copy of the history carries it; the input stays as it is.
 */
export const settle = Effect.fn("SessionReminders.settle")(function* (input: {
  messages: SessionV1.WithParts[]
  lastUser: SessionV1.User
  agent: Agent.Info
  tools: readonly string[]
  /** The DAG mode is on, its workflow tool is published and the model can call tools. */
  dagEligible: boolean
}) {
  const tail = input.messages.at(-1)
  if (tail?.info.role !== "user" || tail.info.id !== input.lastUser.id || MessageV2.isLocalCommand(tail))
    return input.messages
  const flags = yield* RuntimeFlags.Service
  const sessions = yield* Session.Service
  const entries = ReminderState.pending({
    messages: input.messages,
    desired: {
      plan: planState(flags, input.agent),
      todo: yield* todoState(tail, input.tools),
      dag: dagState(tail, input.dagEligible),
    },
    cleared: CLEARED,
  })
  let next = input.messages
  for (const entry of entries) {
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: tail.info.id,
      sessionID: tail.info.sessionID,
      type: "text",
      text: entry.text,
      synthetic: true,
      metadata: { [ReminderState.KEY]: { kind: entry.kind, digest: entry.digest } },
    })
    next = appendPart(next, tail, part)
  }
  return next
})

export * as SessionReminders from "./reminders"
