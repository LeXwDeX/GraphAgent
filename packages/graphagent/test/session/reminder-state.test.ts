// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1456, PR3: the todo, plan and DAG reminders are written into the user message that opens a turn, once per
 * change of their state. `ReminderState.pending` decides from the history; `SessionReminders.settle` writes.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { Injection } from "@graphagent/core/system-context/injection"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { DagMode } from "@/dag/mode"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageV2 } from "@/session/message-v2"
import { ReminderState } from "@/session/reminder-state"
import { SessionReminders } from "@/session/reminders"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_reminder_state")

const { PLAN_REMINDER, BUILD_SWITCH_REMINDER } = SessionReminders
const TODO_CLEARED = Injection.wrap("reminder", "[todo reminder] No uncompleted todo items remain.", { kind: "todo" })
const DAG_ON = Injection.wrap("reminder", DagMode.REMINDER, { kind: "dag" })
const DAG_CLEARED = Injection.wrap("reminder", DagMode.REMINDER_CLEARED, { kind: "dag" })

const todoText = (items: Todo.Info[]) =>
  Injection.wrap("reminder", SessionReminders.renderReminder(items), { kind: "todo" })

const shipping: Todo.Info[] = [
  { content: "ship feature", status: "in_progress", priority: "high" },
  { content: "done already", status: "completed", priority: "low" },
]
const SHIPPING = todoText([shipping[0]])

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────

const textPart = (
  id: string,
  messageID: string,
  text: string,
  extra: Partial<SessionV1.TextPart> = {},
): SessionV1.TextPart => ({
  id: PartID.make(id),
  sessionID,
  messageID: MessageID.make(messageID),
  type: "text",
  text,
  ...extra,
})

const userInfo = (id: string): SessionV1.User => ({
  id: MessageID.make(id),
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
})

const user = (id: string, parts?: SessionV1.Part[]): SessionV1.WithParts => ({
  info: userInfo(id),
  parts: parts ?? [textPart(`prt_${id}`, id, `text of ${id}`)],
})

const assistant = (id: string): SessionV1.WithParts => ({
  info: {
    id: MessageID.make(id),
    sessionID,
    role: "assistant",
    time: { created: 2 },
    parentID: MessageID.make("msg_parent"),
    mode: "build",
    agent: "build",
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [],
})

/** A user message an automation wrote: synthetic text only, one part carrying a marker. */
const automated = (id: string) =>
  user(id, [textPart(`prt_${id}`, id, "[Continuing toward your standing goal]", { synthetic: true })])

/** A local command exchange: ignored text parts that name the command. */
const command = (id: string) =>
  user(id, [textPart(`prt_${id}`, id, "/dag-mode on", { ignored: true, metadata: { command: "dag-mode" } })])

/** A reminder part as `settle` persists it: the kind, and the digest of its text or `cleared`. */
const note = (kind: ReminderState.Kind, text: string, messageID: string, mark = ReminderState.digest(text)) =>
  textPart(`prt_${kind}_${messageID}`, messageID, text, {
    synthetic: true,
    metadata: { [ReminderState.KEY]: { kind, digest: mark } },
  })

const withNotes = (message: SessionV1.WithParts, ...notes: SessionV1.Part[]): SessionV1.WithParts => ({
  ...message,
  parts: [...message.parts, ...notes],
})

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}
const plan: Agent.Info = { ...build, name: "plan" }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const entry of Object.values(value)) deepFreeze(entry)
  }
  return value
}

const texts = (message: SessionV1.WithParts | undefined) =>
  (message?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))

// ── ReminderState (pure) ────────────────────────────────────────────────────────────────────────────────────────────

describe("ReminderState.digest and lastDigest", () => {
  test("the digest is 16 hex digits of the text, so two texts tell apart", () => {
    expect(ReminderState.digest("a")).toMatch(/^[0-9a-f]{16}$/)
    expect(ReminderState.digest("a")).toBe(ReminderState.digest("a"))
    expect(ReminderState.digest("a")).not.toBe(ReminderState.digest("b"))
  })

  test("the kinds are plan, todo, dag in that order, and the key is not the automation marker", () => {
    expect(ReminderState.ORDER).toEqual(["plan", "todo", "dag"])
    expect(ReminderState.KEY).toBe("stateReminder")
    expect(ReminderState.KEY).not.toBe("reminder")
  })

  test("is the newest note of the kind, scanning messages and parts from the end", () => {
    const messages = [
      withNotes(user("msg_1"), note("todo", "first", "msg_1"), note("plan", "plan", "msg_1")),
      assistant("msg_2"),
      withNotes(user("msg_3"), note("todo", "second", "msg_3"), note("todo", "third", "msg_3")),
      user("msg_4"),
    ]
    expect(ReminderState.lastDigest(messages, "todo")).toBe(ReminderState.digest("third"))
    expect(ReminderState.lastDigest(messages, "plan")).toBe(ReminderState.digest("plan"))
    expect(ReminderState.lastDigest(messages, "dag")).toBeUndefined()
    expect(ReminderState.lastDigest([], "todo")).toBeUndefined()
  })

  test("reads the digest of a withdrawal as it is", () => {
    const messages = [
      withNotes(user("msg_1"), note("todo", "x", "msg_1")),
      withNotes(user("msg_2"), note("todo", TODO_CLEARED, "msg_2", ReminderState.CLEARED)),
    ]
    expect(ReminderState.lastDigest(messages, "todo")).toBe(ReminderState.CLEARED)
  })

  test("ignores parts that are not marks: other types, no metadata, a malformed mark", () => {
    const malformed = [
      textPart("prt_a", "msg_1", "no metadata", { synthetic: true }),
      textPart("prt_b", "msg_1", "other key", {
        synthetic: true,
        metadata: { reminder: { kind: "todo", digest: "x" } },
      }),
      textPart("prt_c", "msg_1", "not a record", { synthetic: true, metadata: { [ReminderState.KEY]: "todo" } }),
      textPart("prt_d", "msg_1", "no digest", { synthetic: true, metadata: { [ReminderState.KEY]: { kind: "todo" } } }),
      textPart("prt_e", "msg_1", "no kind", { synthetic: true, metadata: { [ReminderState.KEY]: { digest: "x" } } }),
    ]
    const reasoning: SessionV1.ReasoningPart = {
      id: PartID.make("prt_f"),
      sessionID,
      messageID: MessageID.make("msg_1"),
      type: "reasoning",
      text: "thinking",
      time: { start: 1 },
      metadata: { [ReminderState.KEY]: { kind: "todo", digest: "x" } },
    }
    expect(ReminderState.lastDigest([user("msg_1", [...malformed, reasoning])], "todo")).toBeUndefined()
  })
})

describe("ReminderState.pending", () => {
  const cleared = { plan: "plan cleared", todo: "todo cleared", dag: "dag cleared" }
  const idle = { plan: undefined, todo: undefined, dag: undefined }
  const asked = (
    messages: SessionV1.WithParts[],
    desired: Partial<Record<ReminderState.Kind, ReminderState.Desired>>,
  ) => ReminderState.pending({ messages, desired: { ...idle, ...desired }, cleared })

  test("writes a text no note of the history says, with its digest", () => {
    expect(asked([user("msg_1")], { todo: "T" })).toEqual([
      { kind: "todo", text: "T", digest: ReminderState.digest("T") },
    ])
  })

  test("writes nothing for a text the newest note of the kind already says", () => {
    expect(asked([withNotes(user("msg_1"), note("todo", "T", "msg_1")), user("msg_2")], { todo: "T" })).toEqual([])
  })

  test("writes a changed text, and the newest note is the one that counts", () => {
    const history = [withNotes(user("msg_1"), note("todo", "A", "msg_1"), note("todo", "B", "msg_1")), user("msg_2")]
    expect(asked(history, { todo: "B" })).toEqual([])
    expect(asked(history, { todo: "A" })).toEqual([{ kind: "todo", text: "A", digest: ReminderState.digest("A") }])
  })

  test("writes no note for a state that never had one", () => {
    expect(asked([user("msg_1")], {})).toEqual([])
  })

  test("withdraws a note that is still in force, once", () => {
    const history = [withNotes(user("msg_1"), note("todo", "T", "msg_1")), user("msg_2")]
    expect(asked(history, { todo: undefined })).toEqual([
      { kind: "todo", text: "todo cleared", digest: ReminderState.CLEARED },
    ])
    const after = [
      ...history.slice(0, 1),
      withNotes(user("msg_2"), note("todo", "todo cleared", "msg_2", ReminderState.CLEARED)),
      user("msg_3"),
    ]
    expect(asked(after, { todo: undefined })).toEqual([])
  })

  test("writes the same text again once a withdrawal came after it", () => {
    const history = [
      withNotes(user("msg_1"), note("todo", "T", "msg_1")),
      withNotes(user("msg_2"), note("todo", "todo cleared", "msg_2", ReminderState.CLEARED)),
      user("msg_3"),
    ]
    expect(asked(history, { todo: "T" })).toEqual([{ kind: "todo", text: "T", digest: ReminderState.digest("T") }])
  })

  test("leaves a skipped kind alone, whatever the history says", () => {
    const history = [withNotes(user("msg_1"), note("todo", "T", "msg_1"), note("dag", "D", "msg_1")), user("msg_2")]
    expect(asked(history, { todo: ReminderState.SKIP, dag: ReminderState.SKIP })).toEqual([])
    expect(asked([user("msg_1")], { todo: ReminderState.SKIP })).toEqual([])
  })

  test("decides each kind on its own and lists them in order, not in the order asked", () => {
    const history = [withNotes(user("msg_1"), note("plan", "P", "msg_1")), user("msg_2")]
    expect(asked(history, { dag: "D", todo: "T", plan: "P" }).map((entry) => entry.kind)).toEqual(["todo", "dag"])
    expect(asked(history, { dag: "D", todo: "T", plan: "Q" }).map((entry) => entry.kind)).toEqual([
      "plan",
      "todo",
      "dag",
    ])
    expect(
      asked([withNotes(user("msg_1"), note("plan", "P", "msg_1"), note("dag", "D", "msg_1")), user("msg_2")], {
        plan: undefined,
        todo: "T",
        dag: undefined,
      }),
    ).toEqual([
      { kind: "plan", text: "plan cleared", digest: ReminderState.CLEARED },
      { kind: "todo", text: "T", digest: ReminderState.digest("T") },
      { kind: "dag", text: "dag cleared", digest: ReminderState.CLEARED },
    ])
  })
})

// ── SessionReminders.renderReminder ─────────────────────────────────────────────────────────────────────────────────

describe("SessionReminders.renderReminder", () => {
  test("counts the items and lists each with its status", () => {
    const text = SessionReminders.renderReminder([
      { content: "one", status: "pending", priority: "high" },
      { content: "two", status: "in_progress", priority: "low" },
    ])
    expect(text).toStartWith("[todo reminder] 2 uncompleted todo items:\n- pending: one\n- in_progress: two\n")
    expect(text).toEndWith("Update via todowrite.")
  })

  test("says one uncompleted item in the singular", () => {
    expect(SessionReminders.renderReminder([{ content: "one", status: "pending", priority: "high" }])).toContain(
      "[todo reminder] 1 uncompleted todo item:",
    )
  })
})

// ── SessionReminders.settle ─────────────────────────────────────────────────────────────────────────────────────────

const persisted: SessionV1.Part[] = []
beforeEach(() => {
  persisted.length = 0
})

const sessions = Layer.mock(Session.Service, {
  updatePart: <T extends SessionV1.Part>(part: T) => Effect.sync(() => (persisted.push(part), part)),
})
const it = testEffect(Layer.mergeAll(RuntimeFlags.layer({ experimentalPlanMode: false }), sessions))
const itExperimental = testEffect(Layer.mergeAll(RuntimeFlags.layer({ experimentalPlanMode: true }), sessions))

const todoLayer = (get: () => Effect.Effect<Todo.Info[]>) => Layer.mock(Todo.Service, { get })

const lastUserOf = (messages: SessionV1.WithParts[]): SessionV1.User => {
  const info = messages.at(-1)?.info
  if (info?.role !== "user") throw new Error("the last message is not a user message")
  return info
}

/** What a persisted part says: its text, and the mark it carries, when it is a text part. */
const textOf = (part: SessionV1.Part | undefined) => (part?.type === "text" ? part.text : undefined)
const markOf = (part: SessionV1.Part | undefined) =>
  part?.type === "text" ? part.metadata?.[ReminderState.KEY] : undefined
const written = () => persisted.map(textOf)

interface Turn {
  agent?: Agent.Info
  tools?: readonly string[]
  dag?: boolean
  todos?: Todo.Info[] | "fails" | "missing"
  lastUser?: SessionV1.User
}

const settle = (messages: SessionV1.WithParts[], turn: Turn = {}) => {
  const run = SessionReminders.settle({
    messages,
    lastUser: turn.lastUser ?? lastUserOf(messages),
    agent: turn.agent ?? build,
    tools: turn.tools ?? ["todowrite"],
    dagEligible: turn.dag ?? false,
  })
  if (turn.todos === "missing") return run
  if (turn.todos === "fails") return run.pipe(Effect.provide(todoLayer(() => Effect.die("todo unavailable"))))
  const todos = turn.todos ?? []
  return run.pipe(Effect.provide(todoLayer(() => Effect.succeed(todos))))
}

describe("SessionReminders.settle: when it works", () => {
  it.effect("writes nothing when the history does not end with a user message", () =>
    Effect.gen(function* () {
      const messages = deepFreeze([user("msg_1"), assistant("msg_2")])
      const next = yield* settle(messages, { todos: shipping, dag: true, agent: plan, lastUser: userInfo("msg_1") })
      expect(next).toBe(messages)
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("writes nothing when the last message is not the latest user message", () =>
    Effect.gen(function* () {
      const messages = deepFreeze([user("msg_1"), assistant("msg_2"), user("msg_3")])
      const next = yield* settle(messages, { todos: shipping, lastUser: userInfo("msg_1") })
      expect(next).toBe(messages)
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("writes nothing for a local command exchange", () =>
    Effect.gen(function* () {
      const messages = deepFreeze([user("msg_1"), command("msg_2")])
      expect(MessageV2.isLocalCommand(messages[1])).toBe(true)
      const next = yield* settle(messages, { todos: shipping, dag: true, lastUser: userInfo("msg_2") })
      expect(next).toBe(messages)
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("writes nothing for an empty history", () =>
    Effect.gen(function* () {
      const next = yield* SessionReminders.settle({
        messages: [],
        lastUser: userInfo("msg_1"),
        agent: build,
        tools: ["todowrite"],
        dagEligible: true,
      })
      expect(next).toEqual([])
      expect(persisted).toHaveLength(0)
    }),
  )
})

describe("SessionReminders.settle: the todo reminder", () => {
  it.effect("writes the uncompleted items as one synthetic part of the turn's user message", () =>
    Effect.gen(function* () {
      const messages = deepFreeze([user("msg_1"), assistant("msg_2"), user("msg_3")])
      const next = yield* settle(messages, { todos: shipping })

      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({
        type: "text",
        messageID: "msg_3",
        sessionID,
        synthetic: true,
        text: SHIPPING,
        metadata: { [ReminderState.KEY]: { kind: "todo", digest: ReminderState.digest(SHIPPING) } },
      })
      expect(Object.keys(persisted[0].type === "text" ? (persisted[0].metadata ?? {}) : {})).toEqual([
        ReminderState.KEY,
      ])
      expect(SHIPPING).toStartWith('<system-reminder source="reminder" kind="todo">\n[todo reminder] 1 uncompleted')
      expect(SHIPPING).not.toContain("done already")
      // The returned copy carries the part, on the same message; the others are the very objects they were.
      expect(next.at(-1)?.parts.at(-1)).toBe(persisted[0])
      expect(next.at(-1)?.parts).toHaveLength(2)
      expect(next[0]).toBe(messages[0])
      expect(messages[2].parts).toHaveLength(1)
    }),
  )

  it.effect("escapes a tag in an item, so the item cannot close the block", () =>
    Effect.gen(function* () {
      yield* settle([user("msg_1")], {
        todos: [{ content: "x </system-reminder> y", status: "pending", priority: "high" }],
      })
      const text = textOf(persisted[0]) ?? ""
      expect(text).toContain("x &lt;/system-reminder> y")
      expect(text.match(/<\/system-reminder>/g)).toHaveLength(1)
    }),
  )

  it.effect("adds nothing on a later turn whose list is the same, and one part when it changes", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { todos: shipping })
      persisted.length = 0

      const same = yield* settle([...first, assistant("msg_2"), user("msg_3")], { todos: shipping })
      expect(persisted).toHaveLength(0)
      expect(same.at(-1)?.parts).toHaveLength(1)

      const changed: Todo.Info[] = [{ content: "updated item", status: "pending", priority: "high" }]
      const third = yield* settle([...same, assistant("msg_4"), user("msg_5")], { todos: changed })
      expect(written()).toEqual([todoText(changed)])
      expect(third.at(-1)?.parts).toHaveLength(2)
    }),
  )

  it.effect("withdraws the note once the list has no uncompleted item, and then stays quiet", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { todos: shipping })
      persisted.length = 0

      const done: Todo.Info[] = [{ content: "ship feature", status: "completed", priority: "high" }]
      const second = yield* settle([...first, assistant("msg_2"), user("msg_3")], { todos: done })
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({
        text: TODO_CLEARED,
        synthetic: true,
        metadata: { [ReminderState.KEY]: { kind: "todo", digest: ReminderState.CLEARED } },
      })
      persisted.length = 0

      const third = yield* settle([...second, assistant("msg_4"), user("msg_5")], { todos: [] })
      expect(persisted).toHaveLength(0)
      expect(third.at(-1)?.parts).toHaveLength(1)

      // A list that comes back is written again, even when it is the one the first note said.
      yield* settle([...third, assistant("msg_6"), user("msg_7")], { todos: shipping })
      expect(written()).toEqual([SHIPPING])
    }),
  )

  it.effect("never writes for a session that has no uncompleted item and no earlier note", () =>
    Effect.gen(function* () {
      const cancelled: Todo.Info[] = [
        { content: "a", status: "completed", priority: "low" },
        { content: "b", status: "cancelled", priority: "low" },
      ]
      yield* settle([user("msg_1")], { todos: cancelled })
      yield* settle([user("msg_2")], { todos: [] })
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("leaves the note alone when the tool set has no todowrite, even with an earlier note", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { todos: shipping })
      persisted.length = 0
      yield* settle([...first, assistant("msg_2"), user("msg_3")], { todos: [], tools: ["read"] })
      yield* settle([user("msg_4")], { todos: shipping, tools: [] })
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("does not read the todo list when the tool set has no todowrite", () =>
    Effect.gen(function* () {
      let reads = 0
      yield* SessionReminders.settle({
        messages: [user("msg_1")],
        lastUser: userInfo("msg_1"),
        agent: build,
        tools: ["read"],
        dagEligible: false,
      }).pipe(
        Effect.provide(
          todoLayer(() =>
            Effect.sync(() => {
              reads += 1
              return shipping
            }),
          ),
        ),
      )
      expect(reads).toBe(0)
    }),
  )

  it.effect("leaves the note alone when the Todo service is missing", () =>
    Effect.gen(function* () {
      const next = yield* settle([user("msg_1")], { todos: "missing" })
      expect(next.at(-1)?.parts).toHaveLength(1)
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("leaves the note alone when the todo list cannot be read, and the turn goes on", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { todos: shipping })
      persisted.length = 0
      const next = yield* settle([...first, assistant("msg_2"), user("msg_3")], { todos: "fails" })
      expect(next.at(-1)?.parts).toHaveLength(1)
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("writes to an automation message as well, which stays an automation message", () =>
    Effect.gen(function* () {
      const message = automated("msg_1")
      expect(MessageV2.isAutomationMessage(message)).toBe(true)
      const next = yield* settle([message], { todos: shipping })
      expect(persisted).toHaveLength(1)
      expect(MessageV2.isAutomationMessage(next[0])).toBe(true)
    }),
  )

  it.effect("keeps a user's own message a user's message", () =>
    Effect.gen(function* () {
      const next = yield* settle([user("msg_1")], { todos: shipping, dag: true })
      expect(MessageV2.isAutomationMessage(next[0])).toBe(false)
      expect(next[0].parts.filter((part) => part.type === "text" && !part.synthetic)).toHaveLength(1)
    }),
  )
})

describe("SessionReminders.settle: the plan reminder", () => {
  it.effect("writes the plan prompt on the plan agent's first turn, and nothing on its later turns", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { agent: plan })
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({
        text: PLAN_REMINDER,
        synthetic: true,
        metadata: { [ReminderState.KEY]: { kind: "plan", digest: ReminderState.digest(PLAN_REMINDER) } },
      })
      persisted.length = 0

      const second = yield* settle([...first, assistant("msg_2"), user("msg_3")], { agent: plan })
      yield* settle([...second, assistant("msg_4"), user("msg_5")], { agent: plan })
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("writes the build switch once on the turn that leaves plan mode", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { agent: plan })
      persisted.length = 0

      const left = yield* settle([...first, assistant("msg_2"), user("msg_3")], { agent: build })
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({
        text: BUILD_SWITCH_REMINDER,
        messageID: "msg_3",
        metadata: { [ReminderState.KEY]: { kind: "plan", digest: ReminderState.CLEARED } },
      })
      persisted.length = 0

      yield* settle([...left, assistant("msg_4"), user("msg_5")], { agent: build })
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("writes the plan prompt again when the plan agent comes back", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { agent: plan })
      const left = yield* settle([...first, assistant("msg_2"), user("msg_3")], { agent: build })
      persisted.length = 0
      yield* settle([...left, assistant("msg_4"), user("msg_5")], { agent: plan })
      expect(written()).toEqual([PLAN_REMINDER])
    }),
  )

  it.effect("writes nothing for a build agent that never was in plan mode", () =>
    Effect.gen(function* () {
      yield* settle([user("msg_1")], { agent: build })
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("writes the plan prompt again once the history no longer holds it, as after a compaction", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { agent: plan })
      expect(persisted).toHaveLength(1)
      persisted.length = 0
      // The compaction kept a summary and the newest message only: the note went with the older turns.
      const kept = [assistant("msg_summary"), user("msg_3")]
      expect(ReminderState.lastDigest(first, "plan")).toBeDefined()
      expect(ReminderState.lastDigest(kept, "plan")).toBeUndefined()
      yield* settle(kept, { agent: plan })
      expect(written()).toEqual([PLAN_REMINDER])
    }),
  )

  itExperimental.effect("leaves plan mode to the experimental path, which persists its own reminders", () =>
    Effect.gen(function* () {
      const first = user("msg_1", [note("plan", PLAN_REMINDER, "msg_1")])
      yield* settle([first, assistant("msg_2"), user("msg_3")], { agent: build })
      yield* settle([user("msg_4")], { agent: plan })
      expect(persisted).toHaveLength(0)
    }),
  )
})

describe("SessionReminders.settle: the DAG reminder", () => {
  it.effect("writes the note when the mode is on, once, and nothing while it stays on", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { dag: true })
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({
        text: DAG_ON,
        synthetic: true,
        metadata: { [ReminderState.KEY]: { kind: "dag", digest: ReminderState.digest(DAG_ON) } },
      })
      expect(DAG_ON).toStartWith('<system-reminder source="reminder" kind="dag">\n[Follow the latest dag_mode context')
      persisted.length = 0

      const second = yield* settle([...first, assistant("msg_2"), user("msg_3")], { dag: true })
      yield* settle([...second, assistant("msg_4"), user("msg_5")], { dag: true })
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("writes nothing while the mode is off or the workflow tool is not available", () =>
    Effect.gen(function* () {
      yield* settle([user("msg_1")], { dag: false })
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("withdraws the note once when the mode goes off, and writes it again when it comes back", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { dag: true })
      persisted.length = 0

      const off = yield* settle([...first, assistant("msg_2"), user("msg_3")], { dag: false })
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({
        text: DAG_CLEARED,
        metadata: { [ReminderState.KEY]: { kind: "dag", digest: ReminderState.CLEARED } },
      })
      expect(DagMode.REMINDER_CLEARED).toBe(
        "[The earlier DAG mode note no longer applies: follow the latest dag_mode context.]",
      )
      persisted.length = 0

      const stillOff = yield* settle([...off, assistant("msg_4"), user("msg_5")], { dag: false })
      expect(persisted).toHaveLength(0)

      yield* settle([...stillOff, assistant("msg_6"), user("msg_7")], { dag: true })
      expect(written()).toEqual([DAG_ON])
    }),
  )

  it.effect("leaves an automated turn alone: no note while on, no withdrawal while off", () =>
    Effect.gen(function* () {
      yield* settle([automated("msg_1")], { dag: true })
      expect(persisted).toHaveLength(0)

      const first = yield* settle([user("msg_2")], { dag: true })
      persisted.length = 0
      yield* settle([...first, assistant("msg_3"), automated("msg_4")], { dag: false })
      expect(persisted).toHaveLength(0)
    }),
  )
})

describe("SessionReminders.settle: several states on one turn", () => {
  it.effect("writes them in the order plan, todo, dag, each with its own mark", () =>
    Effect.gen(function* () {
      const next = yield* settle([user("msg_1")], { agent: plan, todos: shipping, dag: true })
      expect(written()).toEqual([PLAN_REMINDER, SHIPPING, DAG_ON])
      expect(persisted.map((part) => markOf(part)?.kind)).toEqual(["plan", "todo", "dag"])
      const ids = persisted.map((part) => String(part.id))
      expect([...ids].sort()).toEqual(ids)
      expect(texts(next[0])).toEqual(["text of msg_1", PLAN_REMINDER, SHIPPING, DAG_ON])
    }),
  )

  it.effect("writes only the state that changed", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { agent: plan, todos: shipping, dag: true })
      persisted.length = 0
      const changed: Todo.Info[] = [{ content: "next", status: "pending", priority: "high" }]
      yield* settle([...first, assistant("msg_2"), user("msg_3")], { agent: plan, todos: changed, dag: true })
      expect(written()).toEqual([todoText(changed)])
    }),
  )

  it.effect("writes no part twice for one turn when the same turn is settled again from its own result", () =>
    Effect.gen(function* () {
      const first = yield* settle([user("msg_1")], { agent: plan, todos: shipping, dag: true })
      const count = persisted.length
      yield* settle(first, { agent: plan, todos: shipping, dag: true })
      expect(persisted).toHaveLength(count)
    }),
  )
})
