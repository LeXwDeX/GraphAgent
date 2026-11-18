// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SettingsHook, type TriggerResult } from "@/hook"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ToolRegistry } from "@/tool/registry"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { ARTIFACT_NAMES, answer, type ArtifactName } from "../agent/artifact-fixtures"
import { disposeAllInstances } from "../fixture/fixture"
import { initTaskTool } from "../lib/child-runs"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const baseLayer = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  EventV2Bridge.defaultLayer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  SessionRunState.defaultLayer,
  SessionStatus.defaultLayer,
  Truncate.defaultLayer,
  ToolRegistry.defaultLayer,
  Database.defaultLayer,
  RuntimeFlags.layer({}),
).pipe(Layer.provide(Ripgrep.defaultLayer))

const it = testEffect(baseLayer)
// A SubagentStop hook that blocks the first stop, so the child gets one more turn.
const stopped = testEffect(
  Layer.mergeAll(
    baseLayer,
    Layer.mock(SettingsHook.Service, {
      trigger: (payload): Effect.Effect<TriggerResult> =>
        Effect.succeed(
          payload.event === "SubagentStop" && !payload.stopHookActive
            ? { additionalContexts: [], systemMessages: [], blocked: { reason: "verify the answer", command: "mock" } }
            : { additionalContexts: [], systemMessages: [] },
        ),
      unregisterScoped: () => Effect.void,
    }),
  ),
)

const seed = Effect.fn("TaskArtifactTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Artifacts" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "explore",
      agent: input.agent ?? "explore",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

interface Sent {
  readonly input: SessionPrompt.PromptInput
  readonly options: unknown
  /** Every text part of the prompt, joined. */
  readonly text: string
  /** The text of the parts a synthetic turn carries (the correction). */
  readonly synthetic: string
}

/** A fake LLM: answers the nth prompt with the nth scripted text (the last repeats) and records what it was asked. */
function scripted(...answers: string[]) {
  const sent: Sent[] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input, options) =>
      Effect.sync(() => {
        const texts = input.parts.flatMap((part) => (part.type === "text" ? [part] : []))
        sent.push({
          input,
          options,
          text: texts.map((part) => part.text).join("\n"),
          synthetic: texts
            .filter((part) => part.synthetic === true)
            .map((part) => part.text)
            .join("\n"),
        })
        return reply(input, answers[Math.min(sent.length, answers.length) - 1] ?? "")
      }),
  }
  return { ops, sent }
}

/** A parent session, a task tool bound to it, and `run` to call that tool with a fake LLM. */
const harness = Effect.fn("TaskArtifactTest.harness")(function* () {
  const { chat, assistant } = yield* seed()
  const def = yield* initTaskTool(yield* TaskTool)
  const run = (
    subagent: string,
    ops: TaskPromptOps,
    extra: { prompt?: string; task_id?: string; command?: string } = {},
  ) =>
    def.execute(
      {
        description: "look into it",
        prompt: extra.prompt ?? "compare three persistence designs",
        subagent_type: subagent,
        ...(extra.task_id ? { task_id: extra.task_id } : {}),
        ...(extra.command ? { command: extra.command } : {}),
      },
      {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        // A command-driven subtask reaches the tool the way `handleSubtask` hands it over: the user's command as
        // the task's origin, with the agent check already done by the command.
        extra: {
          promptOps: ops,
          ...(extra.command
            ? { taskOrigin: { initiator: "user" as const, command: extra.command }, bypassAgentCheck: true }
            : {}),
        },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
  return { chat, def, run }
})

const outputOf = (result: { output: string }) => result.output

describe("task results that declare an artifact", () => {
  it.instance("asks a researcher task for a research_findings artifact and returns it as written", () =>
    Effect.gen(function* () {
      const { ops, sent } = scripted(answer("research_findings"))
      const result = yield* (yield* harness()).run("researcher", ops)

      expect(sent).toHaveLength(1)
      // The caller's request comes first and is left as written; the contract follows it.
      expect(sent[0].text.startsWith("compare three persistence designs")).toBe(true)
      expect(sent[0].text).toContain("[OUTPUT CONTRACT]")
      expect(sent[0].text).toContain('"research_findings"')
      // The schema itself is in the prompt, so the worker can see every required field.
      expect(sent[0].text).toContain('"not_examined"')
      expect(sent[0].text).toContain('"evidence"')
      expect(sent[0].text).toContain('"answers"')

      expect(outputOf(result)).toContain('state="completed"')
      expect(outputOf(result)).toContain(answer("research_findings"))
    }),
  )

  // Every built-in worker whose contract leaves `output.task` at its default.
  const workers: Array<[string, ArtifactName]> = [
    ["researcher", "research_findings"],
    ["architect", "architecture_proposal"],
    ["prototyper", "prototype"],
  ]
  for (const [worker, artifact] of workers) {
    it.instance(`takes the artifact from the ${worker} contract, not from the tool: ${artifact}`, () =>
      Effect.gen(function* () {
        const { ops, sent } = scripted(answer(artifact))
        const result = yield* (yield* harness()).run(worker, ops)
        expect(sent).toHaveLength(1)
        expect(sent[0].text).toContain(`"const": "${artifact}"`)
        for (const other of ARTIFACT_NAMES.filter((name) => name !== artifact)) {
          expect(sent[0].text, other).not.toContain(`"const": "${other}"`)
        }
        expect(outputOf(result)).toContain('state="completed"')
      }),
    )
  }

  for (const missing of ["not_examined", "evidence"]) {
    it.instance(`sends an answer without ${missing} back for one correction and returns the corrected artifact`, () =>
      Effect.gen(function* () {
        const incomplete = answer("research_findings", (payload) => {
          delete payload[missing]
        })
        const corrected = answer("research_findings", (payload) => {
          payload.summary = "corrected"
        })
        const { ops, sent } = scripted(incomplete, corrected)
        const { def, run } = yield* harness()
        const result = yield* run("researcher", ops)

        expect(sent).toHaveLength(2)
        // The correction goes to the same child session, as a synthetic turn that names the problem.
        expect(sent[1].input.sessionID).toBe(sent[0].input.sessionID)
        expect(sent[1].synthetic).toContain(`"${missing}"`)
        expect(sent[1].synthetic).toContain("research_findings")
        expect(sent[1].synthetic).toContain("Do not redo the work")
        expect(sent[1].options).toMatchObject({ continueToolBudget: true })
        expect(def.drives).toHaveLength(2)

        expect(outputOf(result)).toContain('state="completed"')
        expect(outputOf(result)).toContain(corrected)
        expect(outputOf(result)).not.toContain(incomplete)
      }),
    )
  }

  it.instance("sends a prose answer back for one correction too", () =>
    Effect.gen(function* () {
      const { ops, sent } = scripted("Here is what I found: the library defaults to LRU.", answer("research_findings"))
      const result = yield* (yield* harness()).run("researcher", ops)
      expect(sent).toHaveLength(2)
      expect(sent[1].synthetic).toContain("one JSON value")
      expect(outputOf(result)).toContain('state="completed"')
      expect(outputOf(result)).toContain('"artifact":"research_findings"')
    }),
  )

  it.instance("rejects a mislabeled artifact: another type's name is not this contract", () =>
    Effect.gen(function* () {
      const wrong = answer("research_findings", (payload) => {
        payload.artifact = "code_findings"
      })
      const { ops, sent } = scripted(wrong, answer("research_findings"))
      yield* (yield* harness()).run("researcher", ops)
      expect(sent[1].synthetic).toContain('"artifact"')
    }),
  )

  it.instance("fails the task when the correction is still not the artifact, after exactly one correction", () =>
    Effect.gen(function* () {
      const incomplete = answer("research_findings", (payload) => {
        delete payload.not_examined
      })
      const { ops, sent } = scripted(incomplete)
      const { chat, run } = yield* harness()
      const exit = yield* run("researcher", ops).pipe(Effect.exit)

      expect(sent).toHaveLength(2)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const message = Cause.pretty(exit.cause)
      expect(message).toContain('"research_findings"')
      expect(message).toContain('"not_examined"')
      expect(message).toContain("Partial output")
      expect(message).toContain(incomplete)
      // The child stays reachable, so the caller can ask the same worker to fix it.
      const children = yield* (yield* Session.Service).children(chat.id)
      expect(children).toHaveLength(1)
      expect(message).toContain(`task_id="${children[0].id}"`)
    }),
  )

  it.instance("asks a worker that declares no artifact for no artifact and accepts prose as before", () =>
    Effect.gen(function* () {
      const { ops, sent } = scripted("The persistence layer is in packages/core.")
      const result = yield* (yield* harness()).run("general", ops)
      expect(sent).toHaveLength(1)
      expect(sent[0].text).not.toContain("OUTPUT CONTRACT")
      // The request stays as written; `general` is asked for its three free-text sections after it (#1453).
      expect(sent[0].text.startsWith("compare three persistence designs")).toBe(true)
      expect(sent[0].text).toContain("[RETURN CONTRACT]")
      // Nothing parses or refuses the answer: prose outside the sections is returned as written.
      expect(outputOf(result)).toContain("The persistence layer is in packages/core.")
    }),
  )

  it.instance("asks the same of a resumed task: the contract applies to every run of the child", () =>
    Effect.gen(function* () {
      const { chat, run } = yield* harness()
      yield* run("researcher", scripted(answer("research_findings")).ops)
      const [child] = yield* (yield* Session.Service).children(chat.id)
      if (!child) throw new Error("Expected the first run's child session")

      const again = scripted("not json at all", answer("research_findings"))
      const result = yield* run("researcher", again.ops, { prompt: "go deeper", task_id: child.id })
      expect(again.sent).toHaveLength(2)
      expect(again.sent[0].input.sessionID).toBe(child.id)
      expect(again.sent[0].text).toContain("[OUTPUT CONTRACT]")
      expect(again.sent[1].synthetic).toContain("one JSON value")
      expect(outputOf(result)).toContain('state="completed"')
    }),
  )

  it.instance(
    "refuses an agent whose declared artifact is not in the catalog before any session exists",
    () =>
      Effect.gen(function* () {
        const { ops, sent } = scripted("never asked")
        const { chat, run } = yield* harness()
        const exit = yield* run("oddity", ops).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const message = Cause.pretty(exit.cause)
        expect(message).toContain('"no_such_type"')
        expect(message).toContain("code_findings")
        expect(sent).toHaveLength(0)
        expect(yield* (yield* Session.Service).children(chat.id)).toHaveLength(0)
      }),
    {
      config: {
        agent: {
          oddity: {
            mode: "subagent",
            description: "Declares an artifact the catalog does not have",
            contract: { output: { artifact: "no_such_type" } },
          },
        },
      },
    },
  )
})

// `explore` declares code_findings for composed runs and sets `output.task: false`: its task calls stay free text.
describe("a worker that opts out of task calls with output.task false", () => {
  it.instance("explore gets no output contract and its answer is returned as written", () =>
    Effect.gen(function* () {
      const prose = "The store is in packages/core/src/session/store.ts; every write goes through it."
      const { ops, sent } = scripted(prose)
      const result = yield* (yield* harness()).run("explore", ops)

      expect(sent).toHaveLength(1)
      // No artifact is asked for. The request stays as written, followed by the free-text return contract (#1453).
      expect(sent[0].text.startsWith("compare three persistence designs")).toBe(true)
      expect(sent[0].text).toContain("[RETURN CONTRACT]")
      expect(sent[0].text).not.toContain("OUTPUT CONTRACT")
      expect(outputOf(result)).toContain('state="completed"')
      expect(outputOf(result)).toContain(prose)
    }),
  )

  it.instance("an answer that looks like a broken artifact is not checked, corrected or refused", () =>
    Effect.gen(function* () {
      const broken = '{"artifact":"code_findings","summary":"no body, no evidence"}'
      const { ops, sent } = scripted(broken)
      const { chat, def, run } = yield* harness()
      const result = yield* run("explore", ops)
      expect(sent).toHaveLength(1)
      expect(def.drives).toHaveLength(1)
      expect(outputOf(result)).toContain('state="completed"')
      expect(outputOf(result)).toContain(broken)
      expect(yield* (yield* Session.Service).children(chat.id)).toHaveLength(1)
    }),
  )

  it.instance("a user command's subtask on explore is free text too", () =>
    Effect.gen(function* () {
      const prose = "Three call sites, all in packages/graphagent/src/tool."
      const { ops, sent } = scripted(prose)
      const result = yield* (yield* harness()).run("explore", ops, { command: "map", prompt: "map the tool layer" })
      expect(sent).toHaveLength(1)
      expect(sent[0].text.startsWith("map the tool layer")).toBe(true)
      expect(sent[0].text).toContain("[RETURN CONTRACT]")
      expect(outputOf(result)).toContain(prose)
      expect(outputOf(result)).not.toContain('state="error"')
    }),
  )

  it.instance("a user command's subtask on a worker that does owe an artifact is still checked", () =>
    Effect.gen(function* () {
      const { ops, sent } = scripted("Prose first.", answer("research_findings"))
      const result = yield* (yield* harness()).run("researcher", ops, { command: "research", prompt: "compare caches" })
      expect(sent).toHaveLength(2)
      expect(sent[0].text).toContain("[OUTPUT CONTRACT]")
      expect(outputOf(result)).toContain(answer("research_findings"))
    }),
  )

  // `output` is replaced as a unit when a user overrides it, so restating the artifact drops the opt-out;
  // writing `task: false` again keeps it.
  for (const output of [{ artifact: "code_findings" }, { artifact: "code_findings", task: true }]) {
    it.instance(
      `an override that sets explore's output to ${JSON.stringify(output)} owes the artifact to task calls`,
      () =>
        Effect.gen(function* () {
          const { ops, sent } = scripted("prose, not an artifact", answer("code_findings"))
          const result = yield* (yield* harness()).run("explore", ops)
          expect(sent).toHaveLength(2)
          expect(sent[0].text).toContain("[OUTPUT CONTRACT]")
          // An agent that owes an artifact is not also asked for the free-text sections.
          expect(sent[0].text).not.toContain("RETURN CONTRACT")
          expect(sent[0].text).toContain('"const": "code_findings"')
          expect(sent[1].synthetic).toContain("one JSON value")
          expect(outputOf(result)).toContain(answer("code_findings"))
        }),
      { config: { agent: { explore: { contract: { output } } } } },
    )
  }

  it.instance(
    "an override that writes task false again keeps explore free text",
    () =>
      Effect.gen(function* () {
        const { ops, sent } = scripted("still prose")
        yield* (yield* harness()).run("explore", ops)
        expect(sent).toHaveLength(1)
        expect(sent[0].text).not.toContain("OUTPUT CONTRACT")
        expect(sent[0].text).toContain("[RETURN CONTRACT]")
      }),
    { config: { agent: { explore: { contract: { output: { artifact: "code_findings", task: false } } } } } },
  )

  it.instance(
    "a custom worker that opts out is free text, even for an artifact name the catalog does not hold",
    () =>
      Effect.gen(function* () {
        const { ops, sent } = scripted("free text answer")
        const { run } = yield* harness()
        // The opt-out spares the call; the catalog diagnoses the bad name separately.
        for (const worker of ["scribe", "drifter"]) {
          const result = yield* run(worker, ops)
          expect(outputOf(result)).toContain("free text answer")
        }
        expect(sent).toHaveLength(2)
        for (const one of sent) {
          expect(one.text).not.toContain("OUTPUT CONTRACT")
          // Not built in, so not asked for the free-text return contract either (#1453).
          expect(one.text).toBe("compare three persistence designs")
        }
      }),
    {
      config: {
        agent: {
          scribe: {
            mode: "subagent",
            description: "Maps a codebase in free text",
            contract: { output: { artifact: "project_map", task: false } },
          },
          drifter: {
            mode: "subagent",
            description: "Opts out, with an artifact name that does not exist",
            contract: { output: { artifact: "no_such_type", task: false } },
          },
        },
      },
    },
  )
})

describe("a SubagentStop continuation still owes the artifact", () => {
  stopped.instance("corrects an invalid continued answer once and returns the corrected artifact", () =>
    Effect.gen(function* () {
      const { ops, sent } = scripted(
        answer("research_findings", (payload) => {
          payload.summary = "first, accepted before the hook ran"
        }),
        "the hook asked me to look again, and this is prose",
        answer("research_findings", (payload) => {
          payload.summary = "continued and corrected"
        }),
      )
      const result = yield* (yield* harness()).run("researcher", ops)
      expect(sent).toHaveLength(3)
      expect(sent[2].synthetic).toContain("one JSON value")
      expect(outputOf(result)).toContain('state="completed"')
      expect(outputOf(result)).toContain("continued and corrected")
      expect(outputOf(result)).not.toContain("first, accepted")
    }),
  )

  stopped.instance("reports an error when the continued answer cannot be corrected", () =>
    Effect.gen(function* () {
      const { ops, sent } = scripted(answer("research_findings"), "prose, not an artifact")
      const result = yield* (yield* harness()).run("researcher", ops)
      expect(sent).toHaveLength(3)
      expect(outputOf(result)).toContain('state="error"')
      expect(outputOf(result)).toContain('"research_findings"')
      expect(outputOf(result)).not.toContain('state="completed"')
    }),
  )

  stopped.instance("leaves a continued answer of a worker that opts out as it is", () =>
    Effect.gen(function* () {
      const { ops, sent } = scripted("first prose", "the continued prose")
      const result = yield* (yield* harness()).run("explore", ops)
      expect(sent).toHaveLength(2)
      expect(outputOf(result)).toContain('state="completed"')
      expect(outputOf(result)).toContain("the continued prose")
    }),
  )
})
