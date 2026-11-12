// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- minimal WithParts fixture uses branded shims.

// #1027 D5: agent-mailbox delivery is event-driven; the 250ms poll is gone.
// These probes pin the three acceptance behaviours that replaced it:
// a lost change event is recovered by the inbox 30s tick (virtual clock), a
// nudge burst coalesces into one admission, and send-to-admission latency
// stays inside the p95 budget without a model turn. They also pin what the
// event-driven design must not break: a recipient's long model turn never
// holds back another recipient's change event.

import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore } from "@graphagent/core/dag/store"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AgentScheduler } from "@/session/agent-scheduler"
import { SessionInbox } from "@/session/inbox"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { it, pollWithTimeout } from "../lib/effect"

const DIRECTORY = process.cwd()
const PARENT = SessionID.make("ses_mailbox_event_parent")
const LATENCY_SAMPLES = 50

interface Probe {
  /** Flips after init: the rows exist, but no local change event is sent. */
  queued: boolean
  /** When true the admitted turn never settles, so the in-flight fence holds. */
  hold: boolean
  /** Sessions whose admitted turn waits on a gate the test opens: a long model turn. */
  gates: Map<string, Deferred.Deferred<void>>
  /** Sessions whose awaited turn was interrupted, which is what disposing the instance does to it. */
  interrupted: string[]
  admissions: SessionID[]
  receives: number
  /** Admission timestamps for the latency probe, in performance.now() units. */
  admittedAt: number[]
  messages: Map<string, DagMessages.Message>
}

function probe(): Probe {
  return {
    queued: false,
    hold: true,
    gates: new Map(),
    interrupted: [],
    admissions: [],
    receives: 0,
    admittedAt: [],
    messages: new Map(),
  }
}

function reply(sessionID: SessionID): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: DIRECTORY, root: DIRECTORY },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ type: "text", text: "handled" }] as never,
  }
}

/** What the admitted turn's model run does: wait on a test-owned gate, hang, or finish at once. */
function turnResult(state: Probe, sessionID: SessionID): Effect.Effect<SessionV1.WithParts> {
  const gate = state.gates.get(sessionID)
  if (gate)
    return Deferred.await(gate).pipe(
      Effect.as(reply(sessionID)),
      Effect.onInterrupt(() => Effect.sync(() => void state.interrupted.push(sessionID))),
    )
  return state.hold ? Effect.never : Effect.succeed(reply(sessionID))
}

function messageFor(sessionID: string, sequence: number): DagMessages.Message {  return {
    id: `agent_report_${sequence}`,
    workflowID: "dag_absent",
    sender: {
      id: "child_endpoint",
      kind: "node",
      sessionID: "ses_child",
      workflowID: "dag_absent",
      nodeID: "worker",
      attemptID: "attempt_1",
    },
    recipient: { id: `parent_endpoint_${sequence}`, kind: "main", sessionID: SessionID.make(sessionID) },
    recipientSequence: sequence,
    acceptedRevision: 1,
    content: "Completed investigation; please review.",
    state: "queued",
    transcriptID: `msg_agent_report_${sequence}`,
    partID: `prt_agent_report_${sequence}`,
    timeCreated: 1,
  }
}

function mailboxLayer(state: Probe, changes: Stream.Stream<DagMessages.Change>) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, status, dag, AgentScheduler.defaultLayer)
  const messages = Layer.mock(DagMessages.Service, {
    changed: changes,
    pendingRecipients: () =>
      Effect.succeed(state.queued ? [...state.messages.values()].map((message) => message.recipient) : []),
    receive: (caller) =>
      Effect.sync(() => {
        state.receives += 1
        const message = state.messages.get(caller.sessionID)
        return { ok: true as const, value: state.queued && message ? [message] : [] }
      }),
  })
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    messages: () => Effect.succeed([]),
  })
  const prompt = Layer.mock(SessionPrompt.Service, {
    prepareTurn: (input) =>
      Effect.sync(() => {
        state.admissions.push(input.sessionID)
        state.admittedAt.push(performance.now())
        return Option.some({
          turn: undefined,
          run: true,
          activate: Effect.void,
          result: turnResult(state, input.sessionID),
          abort: Effect.void,
        })
      }),
  })
  // The shared inbox owns the one idle subscription and drives DAG delivery
  // through its `dag.delivery` source. Merge it so the test sees the same
  // instance DagLoop builds against.
  const inbox = SessionInbox.layer.pipe(Layer.provide(bridge), Layer.provide(status))
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(messages),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(Layer.mock(Agent.Service, {})),
    Layer.provide(inbox),
  )
  return Layer.mergeAll(base, loop, inbox)
}

const initAll = Effect.gen(function* () {
  yield* (yield* DagLoop.Service).init()
  yield* (yield* SessionInbox.Service).init()
})

function run<A>(
  state: Probe,
  changes: Stream.Stream<DagMessages.Change>,
  work: Effect.Effect<A, Error, DagLoop.Service | SessionInbox.Service | SessionStatus.Service>,
) {
  return work.pipe(
    Effect.provide(mailboxLayer(state, changes)),
    Effect.provideService(InstanceRef, {
      directory: DIRECTORY,
      worktree: DIRECTORY,
      root: DIRECTORY,
      project: {
        id: Project.ID.make("project-1"),
        worktree: DIRECTORY,
        time: { created: 0, updated: 0 },
        sandboxes: [],
      },
    }),
    Effect.scoped,
  )
}

const settle = Effect.gen(function* () {
  for (let index = 0; index < 100; index++) yield* Effect.yieldNow
})

const change = (recipientSessionID: string): DagMessages.Change => ({
  recipientSessionID,
  directory: DIRECTORY,
  kind: "queued",
  mailboxVersion: 1,
})

describe("DagDelivery event-driven mailboxes (#1027 D5)", () => {
  it.effect("recovers a queued mailbox from the 30s inbox tick when the change event is lost", () =>
    Effect.gen(function* () {
      const state = probe()
      state.messages.set(PARENT, messageFor(PARENT, 1))
      yield* run(
        state,
        Stream.empty,
        Effect.gen(function* () {
          yield* initAll
          expect(state.admissions).toHaveLength(0)
          // Another process (or a crashed sender) committed the row after the
          // startup scan; no local `messages.changed` event reaches us.
          state.queued = true
          yield* TestClock.adjust("30 seconds")
          yield* settle
          expect(state.admissions).toEqual([PARENT])
        }),
      )
    }),
  )

  it.live("coalesces a burst of 100 change nudges into one admission", () =>
    Effect.gen(function* () {
      const state = probe()
      state.messages.set(PARENT, messageFor(PARENT, 1))
      const changes = yield* Queue.unbounded<DagMessages.Change>()
      yield* run(
        state,
        Stream.fromQueue(changes),
        Effect.gen(function* () {
          yield* initAll
          expect(state.admissions).toHaveLength(0)
          state.queued = true
          for (let index = 0; index < 100; index++) Queue.offerUnsafe(changes, change(PARENT))
          yield* pollWithTimeout(
            Effect.sync(() => (state.admissions.length === 1 ? true : undefined)),
            "mailbox was not admitted",
          )
          // The admitted turn holds the in-flight fence; the remaining nudges
          // must observe it instead of admitting again.
          yield* Effect.sleep("300 millis")
          expect(state.admissions).toEqual([PARENT])
          expect(state.receives).toBe(1)
        }),
      )
    }),
  )

  it.live("keeps send-to-admission p95 inside 100ms", () =>
    Effect.gen(function* () {
      const state = probe()
      state.hold = false
      const sessions = Array.from({ length: LATENCY_SAMPLES }, (_, index) => `ses_latency_${index}`)
      for (const [index, sessionID] of sessions.entries()) state.messages.set(sessionID, messageFor(sessionID, index + 1))
      const changes = yield* Queue.unbounded<DagMessages.Change>()
      yield* run(
        state,
        Stream.fromQueue(changes),
        Effect.gen(function* () {
          yield* initAll
          state.queued = true
          // The commit boundary: every change event is published from here.
          const sentAt = performance.now()
          for (const sessionID of sessions) Queue.offerUnsafe(changes, change(sessionID))
          yield* pollWithTimeout(
            Effect.sync(() => (state.admissions.length === sessions.length ? true : undefined)),
            `only ${state.admissions.length}/${sessions.length} mailboxes were admitted`,
            "10 seconds",
          )
          const latency = state.admittedAt.map((at) => at - sentAt).toSorted((a, b) => a - b)
          const p95 = latency[Math.floor(0.95 * (latency.length - 1))]
          expect(p95).toBeLessThanOrEqual(100)
        }),
      )
    }),
  )

  it.live("a long model turn for one recipient does not hold back another recipient's change event", () =>
    Effect.gen(function* () {
      const state = probe()
      state.hold = false
      const long = "ses_long_turn"
      const next = "ses_next_recipient"
      state.messages.set(long, messageFor(long, 1))
      state.messages.set(next, messageFor(next, 2))
      // The first recipient's admitted turn runs until the test opens the gate
      // (never, here): `inbox.nudge` resolves only after that drain ends.
      state.gates.set(long, Deferred.makeUnsafe<void>())
      const changes = yield* Queue.unbounded<DagMessages.Change>()
      yield* run(
        state,
        Stream.fromQueue(changes),
        Effect.gen(function* () {
          yield* initAll
          state.queued = true
          Queue.offerUnsafe(changes, change(long))
          yield* pollWithTimeout(
            Effect.sync(() => (state.admissions.includes(SessionID.make(long)) ? true : undefined)),
            "the long-turn mailbox was not admitted",
          )
          // The long turn is now in flight and holds its session's drain. The
          // next recipient's event must still be consumed and admitted.
          Queue.offerUnsafe(changes, change(next))
          yield* pollWithTimeout(
            Effect.sync(() => (state.admissions.includes(SessionID.make(next)) ? true : undefined)),
            "the next recipient was held back behind the long model turn",
            "2 seconds",
          )
          expect(state.admissions).toEqual([SessionID.make(long), SessionID.make(next)])
          expect(state.interrupted).toEqual([])
        }),
      )
      // Disposing the instance interrupts the forked nudge still waiting on
      // the long turn instead of leaking it.
      expect(state.interrupted).toEqual([long])
    }),
  )
})
