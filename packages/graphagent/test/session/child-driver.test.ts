// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the driver stub answers with a hand-built message

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Cause, Effect, Exit, Logger, References, Scope } from "effect"
import { ChildAdmission } from "@/session/child/admission"
import { ChildRegistry } from "@/session/child/registry"
import { makeChildRuns, type ChildRuns } from "@/session/child/run"
import type { ChildRunCredential } from "@/session/child/types"
import type { PromptInput } from "@/session/prompt-input"
import { MessageID, SessionID } from "@/session/schema"
import type { AdmissionExtras, AdmissionOptions } from "@/session/turns"
import { testEffect } from "../lib/effect"

/**
 * Issue #1026 PR3b: a driver prompts its child session through the run. The
 * prompt goes out as a delegation under the credential of the session's active
 * run; the stop of a foreground task's child belongs to its tool call for as
 * long as the run is foreground and active; admission records the credential.
 */

const it = testEffect(Database.layerFromPath(":memory:"))

const parentID = (name: string) => SessionID.make(`ses_cd_${name}_parent_${Math.random().toString(36).slice(2)}`)
const childID = (name: string) => SessionID.make(`ses_cd_${name}_child_${Math.random().toString(36).slice(2)}`)

const ensureSession = (
  db: Database.Interface["db"],
  sessionID: SessionID,
  fields: { readonly title?: string; readonly agent?: string } = {},
) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_child_driver"), worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.make("prj_child_driver"),
        slug: "child-driver",
        directory: AbsolutePath.make("/tmp"),
        title: fields.title ?? "child driver",
        ...(fields.agent ? { agent: fields.agent } : {}),
        version: "0",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

interface Sent {
  readonly input: PromptInput
  readonly options: AdmissionOptions
  readonly extras: Pick<AdmissionExtras, "credential"> | undefined
}

const task = (callID: string) => ({ kind: "task" as const, toolCallID: callID })

/** One parent over the test database with a driver that records every prompt, template resolution and turn cancel. */
const setup = (name: string, options: { readonly driver?: boolean } = {}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    const sent: Sent[] = []
    const resolved: string[] = []
    const cancelled: Array<{ sessionID: string; reason: string | undefined }> = []
    const children = yield* makeChildRuns({
      db,
      scope,
      cancelSession: (sessionID, cancelOptions) =>
        Effect.sync(() => {
          cancelled.push({ sessionID, reason: cancelOptions?.reason?.reason })
        }),
      ...(options.driver === false
        ? {}
        : {
            driver: {
              prompt: (input, promptOptions, extras) =>
                Effect.sync(() => {
                  sent.push({ input, options: promptOptions, extras })
                  return {
                    info: { id: MessageID.ascending(), role: "assistant" },
                    parts: [],
                  } as unknown as SessionV1.WithParts
                }),
              resolvePromptParts: (template) =>
                Effect.sync(() => {
                  resolved.push(template)
                  return [{ type: "text" as const, text: `resolved:${template}` }]
                }),
            } satisfies ChildRuns.Driver,
          }),
    })
    const parent = parentID(name)
    yield* ensureSession(db, parent)
    const newChild = Effect.fn("ChildDriverTest.newChild")(function* (
      label = name,
      fields?: Parameters<typeof ensureSession>[2],
    ) {
      const id = childID(label)
      yield* ensureSession(db, id, fields)
      return id
    })
    const input = (sessionID: SessionID, text = "go"): PromptInput => ({
      sessionID,
      parts: [{ type: "text", text }],
    })
    /** Another parent, with its session row: a run of its child must not answer to this parent. */
    const stranger = Effect.fn("ChildDriverTest.stranger")(function* () {
      const id = parentID("stranger")
      yield* ensureSession(db, id)
      return children.forParent(id)
    })
    return {
      db,
      children,
      scoped: children.forParent(parent),
      parent,
      sent,
      resolved,
      cancelled,
      newChild,
      stranger,
      input,
    }
  })

describe("child run credential", () => {
  it.effect("is issued with a run, names its child session, and is revoked when the run ends", () =>
    Effect.gen(function* () {
      const { scoped, newChild } = yield* setup("issue")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: false })

      const credential = ChildRegistry.credentialOf(child)
      expect(credential).toBeDefined()
      expect(credential).toMatchObject({ runID: handle.id, childSessionID: child, revoked: false })
      expect(credential && ChildRegistry.live(credential)).toBe(true)

      yield* handle.settle({ type: "completed" })
      expect(credential?.revoked).toBe(true)
      expect(credential && ChildRegistry.live(credential)).toBe(false)
      expect(ChildRegistry.credentialOf(child)).toBeUndefined()
    }),
  )

  it.effect("belongs to one run: the next run of the same session gets its own, and the old one stays dead", () =>
    Effect.gen(function* () {
      const { scoped, newChild } = yield* setup("next")
      const child = yield* newChild()
      const first = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: false })
      const old = ChildRegistry.credentialOf(child)
      yield* first.settle({ type: "completed" })

      const second = yield* scoped.adopt({ childSessionID: child, owner: task("call_2"), detached: false })
      const current = ChildRegistry.credentialOf(child)
      expect(current?.runID).toBe(second.id)
      expect(current).not.toBe(old)
      expect(old && ChildRegistry.live(old)).toBe(false)
      expect(current && ChildRegistry.live(current)).toBe(true)
      yield* second.settle({ type: "completed" })
    }),
  )

  it.effect("is judged by admission: none, live, stale, or issued for another session", () =>
    Effect.gen(function* () {
      const { scoped, newChild } = yield* setup("verdict")
      const child = yield* newChild("a")
      const other = yield* newChild("b")
      const handle = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: false })
      const otherHandle = yield* scoped.start({ childSessionID: other, owner: task("call_2"), detached: false })
      const credential = ChildRegistry.credentialOf(child)
      const foreign = ChildRegistry.credentialOf(other)

      expect(ChildAdmission.verdictOf(child, undefined)).toBe("none")
      expect(ChildAdmission.verdictOf(child, credential)).toBe("live")
      expect(ChildAdmission.verdictOf(child, foreign)).toBe("foreign")
      yield* handle.settle({ type: "completed" })
      expect(ChildAdmission.verdictOf(child, credential)).toBe("stale")
      yield* otherHandle.settle({ type: "completed" })
    }),
  )
})

describe("ChildRuns.prompt", () => {
  it.effect("sends the prompt as a delegation under the credential of the session's active run", () =>
    Effect.gen(function* () {
      const { scoped, sent, newChild, input } = yield* setup("prompt")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: false })

      yield* scoped.prompt(input(child, "first"))
      yield* scoped.prompt(input(child, "more"), { continueToolBudget: true })

      expect(sent).toHaveLength(2)
      // Never the driver's to choose: the prompt is a delegation, and that is all its options say by default.
      expect(sent[0]?.options).toEqual({ internalDelegation: true })
      expect(sent[1]?.options).toEqual({ internalDelegation: true, continueToolBudget: true })
      for (const prompt of sent) {
        expect(prompt.extras?.credential).toBe(ChildRegistry.credentialOf(child))
        expect(prompt.extras?.credential?.runID).toBe(handle.id)
      }
      yield* handle.settle({ type: "completed" })
    }),
  )

  it.effect("appended input is sent under the run an earlier call registered", () =>
    Effect.gen(function* () {
      const { scoped, sent, newChild, input } = yield* setup("append")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: true })
      // The second call finds the run active, so it registers nothing and drives through the same session.
      yield* scoped.prompt(input(child, "appended"))
      expect(sent[0]?.extras?.credential?.runID).toBe(handle.id)
      yield* handle.settle({ type: "completed" })
    }),
  )

  it.effect("sends no credential once the run ended, and none for a child of another parent", () =>
    Effect.gen(function* () {
      const { scoped, sent, newChild, stranger: other, input } = yield* setup("none")
      const child = yield* newChild("own")
      const theirs = yield* newChild("theirs")
      const handle = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: false })
      const stranger = yield* (yield* other()).start({
        childSessionID: theirs,
        owner: task("call_2"),
        detached: false,
      })

      // A child that is not this parent's gets none of this parent's say.
      yield* scoped.prompt(input(theirs))
      expect(sent[0]?.extras).toBeUndefined()
      yield* handle.settle({ type: "completed" })
      yield* scoped.prompt(input(child))
      expect(sent[1]?.extras).toBeUndefined()
      // The prompt still goes out: admission records the missing credential, it does not refuse (PR5 does).
      expect(sent[1]?.options.internalDelegation).toBe(true)
      yield* stranger.settle({ type: "completed" })
    }),
  )

  it.effect(
    "sends the revoked credential of a cancelled run to nobody, though the session is still held for its driver",
    () =>
      Effect.gen(function* () {
        const { children, scoped, sent, newChild, input } = yield* setup("cancelled")
        const child = yield* newChild()
        const handle = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: true })
        yield* handle.markRunning
        const credential = ChildRegistry.credentialOf(child)

        yield* children.cancel(handle.id, { kind: "main_agent_tool", toolCallID: "call_2" })
        // The run is over but its driver has not stopped: the session is still reserved, and its credential is dead.
        expect(ChildRegistry.activeFor(child)?.phase).toBe("ended")
        expect(credential?.revoked).toBe(true)

        yield* scoped.prompt(input(child))
        expect(sent[0]?.extras).toBeUndefined()
        yield* handle.settle({ type: "completed" })
      }),
  )

  it.effect("a factory built without a driver cannot drive", () =>
    Effect.gen(function* () {
      const { scoped, newChild, input } = yield* setup("no-driver", { driver: false })
      const child = yield* newChild()
      const exit = yield* scoped.prompt(input(child)).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("without a driver")
      expect(Exit.isFailure(yield* scoped.resolvePromptParts("x").pipe(Effect.exit))).toBe(true)
    }),
  )

  it.effect("resolves the prompt template through the driver", () =>
    Effect.gen(function* () {
      const { scoped, resolved } = yield* setup("resolve")
      expect(yield* scoped.resolvePromptParts("read @file")).toEqual([{ type: "text", text: "resolved:read @file" }])
      expect(resolved).toEqual(["read @file"])
    }),
  )
})

describe("ChildRuns.interrupt", () => {
  it.effect("cancels the child's turn without a reason and leaves the run alone", () =>
    Effect.gen(function* () {
      const { scoped, cancelled, newChild } = yield* setup("interrupt")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: false })

      yield* scoped.interrupt(child)

      expect(cancelled).toEqual([{ sessionID: child, reason: undefined }])
      expect(ChildRegistry.activeFor(child)?.phase).toBe("queued")
      yield* handle.settle({ type: "completed" })
    }),
  )

  it.effect("does not stop a child of another parent, but stops one the registry no longer knows", () =>
    Effect.gen(function* () {
      const { scoped, cancelled, newChild, stranger: other } = yield* setup("interrupt-scope")
      const theirs = yield* newChild("theirs")
      const stranger = yield* (yield* other()).start({
        childSessionID: theirs,
        owner: task("call_2"),
        detached: false,
      })

      yield* scoped.interrupt(theirs)
      expect(cancelled).toEqual([])

      yield* stranger.settle({ type: "completed" })
      yield* scoped.interrupt(theirs)
      expect(cancelled).toEqual([{ sessionID: theirs, reason: undefined }])
    }),
  )
})

describe("ChildRegistry.delegateStop", () => {
  it.effect("is true only while the session's active run is a foreground task's, and records the delegation", () =>
    Effect.gen(function* () {
      const { scoped, newChild } = yield* setup("stop")
      const child = yield* newChild()
      expect(ChildRegistry.delegateStop(child)).toBe(false)

      const handle = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: false })
      expect(yield* handle.stopDelegated).toBe(false)
      expect(ChildRegistry.delegateStop(child)).toBe(true)
      expect(yield* handle.stopDelegated).toBe(true)

      yield* handle.settle({ type: "completed" })
      // The run is over: the child's loop keeps its own Stop, and the record stays readable.
      expect(ChildRegistry.delegateStop(child)).toBe(false)
      expect(yield* handle.stopDelegated).toBe(true)
    }),
  )

  it.effect("a promotion hands Stop back to the child, and a delegation made before it stays on record", () =>
    Effect.gen(function* () {
      const { scoped, newChild } = yield* setup("promoted")
      const early = yield* newChild("early")
      const late = yield* newChild("late")
      const promotedEarly = yield* scoped.start({ childSessionID: early, owner: task("call_1"), detached: false })
      const promotedLate = yield* scoped.start({ childSessionID: late, owner: task("call_2"), detached: false })

      // Promoted before the child exits: the child fires its own Stop and nothing was delegated.
      yield* promotedEarly.detach
      yield* promotedEarly.detach
      expect(ChildRegistry.delegateStop(early)).toBe(false)
      expect(yield* promotedEarly.stopDelegated).toBe(false)

      // Promoted after a clean exit that skipped its Stop: the tool call can still deliver it.
      expect(ChildRegistry.delegateStop(late)).toBe(true)
      yield* promotedLate.detach
      expect(ChildRegistry.delegateStop(late)).toBe(false)
      expect(yield* promotedLate.stopDelegated).toBe(true)

      yield* promotedEarly.settle({ type: "completed" })
      yield* promotedLate.settle({ type: "completed" })
    }),
  )

  it.effect("delegates for a DAG node's run, never for a background run or a session with no run", () =>
    Effect.gen(function* () {
      const { children, scoped, parent, newChild } = yield* setup("others")
      const background = yield* newChild("background")
      const node = yield* newChild("node")
      const loose = yield* newChild("loose")
      const detached = yield* scoped.start({ childSessionID: background, owner: task("call_1"), detached: true })
      const dag = yield* children.start({
        parentSessionID: parent,
        childSessionID: node,
        owner: { kind: "dag_node", workflowID: "wf", nodeID: "n01", attempt: 1 },
        detached: false,
      })

      expect(ChildRegistry.delegateStop(background)).toBe(false)
      // The DAG owns the child's one Stop notification when the attempt settles.
      expect(ChildRegistry.delegateStop(node)).toBe(true)
      expect(ChildRegistry.delegateStop(loose)).toBe(false)
      yield* detached.settle({ type: "completed" })
      yield* dag.settle({ type: "completed" })
    }),
  )

  it.effect("a run that ended delegates nothing, even while its session is still held for its driver", () =>
    Effect.gen(function* () {
      const { children, scoped, newChild } = yield* setup("ended")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: false })

      yield* children.cancel(handle.id, { kind: "engine", reason: "test" })
      expect(ChildRegistry.activeFor(child)?.phase).toBe("ended")
      expect(ChildRegistry.delegateStop(child)).toBe(false)
      expect(yield* handle.stopDelegated).toBe(false)
      yield* handle.settle({ type: "completed" })
    }),
  )

  it.effect("a later run of the session starts with nothing delegated", () =>
    Effect.gen(function* () {
      const { scoped, newChild } = yield* setup("fresh")
      const child = yield* newChild()
      const first = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: false })
      expect(ChildRegistry.delegateStop(child)).toBe(true)
      yield* first.settle({ type: "completed" })

      const second = yield* scoped.adopt({ childSessionID: child, owner: task("call_2"), detached: false })
      expect(yield* second.stopDelegated).toBe(false)
      yield* second.settle({ type: "completed" })
    }),
  )
})

describe("ChildAdmission.observe", () => {
  const record = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const lines: Array<{ readonly level: string; readonly message: string }> = []
      const logger = Logger.make((entry) => {
        lines.push({ level: entry.logLevel.toUpperCase(), message: String(entry.message) })
      })
      yield* effect.pipe(
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(Logger.layer([logger])),
      )
      return lines
    })

  it.effect("records a live credential at either junction and refuses nothing", () =>
    Effect.gen(function* () {
      const { scoped, newChild } = yield* setup("observe-live")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: false })
      const credential = ChildRegistry.credentialOf(child)
      const parentID_ = SessionID.make("ses_cd_observe_parent")

      const lines = yield* record(
        Effect.all([
          ChildAdmission.observe("admit", { id: child, parentID: parentID_ }, credential),
          ChildAdmission.observe("loop", { id: child }, credential),
        ]),
      )

      expect(lines.map((line) => line.level)).toEqual(["DEBUG", "DEBUG"])
      expect(lines.every((line) => line.message.includes("child run credential presented"))).toBe(true)
      yield* handle.settle({ type: "completed" })
    }),
  )

  it.effect("warns about a credential that is stale or belongs to another session, and about nothing else", () =>
    Effect.gen(function* () {
      const { scoped, newChild } = yield* setup("observe-bad")
      const child = yield* newChild("a")
      const other = yield* newChild("b")
      const handle = yield* scoped.start({ childSessionID: child, owner: task("call_1"), detached: false })
      const otherHandle = yield* scoped.start({ childSessionID: other, owner: task("call_2"), detached: false })
      const credential: ChildRunCredential | undefined = ChildRegistry.credentialOf(child)
      const foreign = ChildRegistry.credentialOf(other)
      yield* handle.settle({ type: "completed" })

      const lines = yield* record(
        Effect.all([
          ChildAdmission.observe("admit", { id: child }, credential),
          ChildAdmission.observe("admit", { id: other }, credential),
          ChildAdmission.observe("loop", { id: child }, foreign),
        ]),
      )

      expect(lines.map((line) => line.level)).toEqual(["WARN", "WARN", "WARN"])
      yield* otherHandle.settle({ type: "completed" })
    }),
  )

  it.effect("a session without a credential is a debug note when it is a child, and silent when it is not", () =>
    Effect.gen(function* () {
      const lines = yield* record(
        Effect.all([
          ChildAdmission.observe(
            "admit",
            { id: SessionID.make("ses_cd_a"), parentID: SessionID.make("ses_cd_p") },
            undefined,
          ),
          ChildAdmission.observe("admit", { id: SessionID.make("ses_cd_b") }, undefined),
          ChildAdmission.observe("loop", { id: SessionID.make("ses_cd_a") }, undefined),
        ]),
      )
      expect(lines.map((line) => line.level)).toEqual(["DEBUG"])
      expect(lines[0]?.message).toContain("without a run credential")
    }),
  )
})
