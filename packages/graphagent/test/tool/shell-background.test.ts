// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { readFileSync } from "node:fs"
import { BackgroundJob } from "@/background/job"
import { Goal } from "@/goal/goal"
import { GoalLoop } from "@/goal/loop"
import { Config } from "@/config/config"
import { Shell } from "@graphagent/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"

type WakeCall = {
  sessionID: SessionID
  match: Goal.WakeMatch
  payload?: string
  options?: { readonly evaluate?: boolean }
}

type PromptCall = { parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }> }

// Tests in a file run sequentially, so one module-level recorder is enough and
// keeps the mock layer static for testEffect.
const hooks: { started: BackgroundJob.StartInput[]; wakes: WakeCall[]; prompts: PromptCall[] } = {
  started: [],
  wakes: [],
  prompts: [],
}

const promptOps = {
  cancel: () => Effect.void,
  resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt: (input: { parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }> }) =>
    Effect.sync(() => {
      hooks.prompts.push({ parts: input.parts })
    }).pipe(Effect.as(undefined)),
}

const backgroundLayer = Layer.mergeAll(
  Layer.mock(BackgroundJob.Service, {
    start: (input: BackgroundJob.StartInput) =>
      Effect.sync(() => {
        hooks.started.push(input)
        return {
          id: input.id ?? "job_unknown",
          type: input.type,
          status: "running" as const,
          started_at: 0,
          title: input.title,
          metadata: input.metadata,
        } satisfies BackgroundJob.Info
      }),
  }),
  Layer.mock(GoalLoop.Service, {
    wake: (
      sessionID: SessionID,
      match: Goal.WakeMatch,
      payload?: string,
      options?: { readonly evaluate?: boolean },
    ) =>
      Effect.sync(() => {
        hooks.wakes.push({ sessionID, match, payload, options })
        return true
      }),
  }),
)

const shellLayer = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  FSUtil.defaultLayer,
  Truncate.defaultLayer,
  Config.defaultLayer,
  Agent.defaultLayer,
  RuntimeFlags.defaultLayer,
  backgroundLayer,
  testInstanceStoreLayer,
)

const it = testEffect(shellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_bg_test"),
  messageID: MessageID.make("msg_bg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const promptCtx: Tool.Context = { ...ctx, extra: { promptOps } }

const bin = `"${process.execPath.replaceAll("\\", "/")}"`
const shellName = () => Shell.name(Shell.acceptable())
const command = (code: string) => `${shellName() === "pwsh" || shellName() === "powershell" ? "& " : ""}${bin} -e "${code}"`

const init = Effect.fn("ShellBackgroundTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const logPath = (output: string) => {
  const match = output.match(/^log: (.+)$/m)
  if (!match?.[1]) throw new Error(`missing log path in tool output:\n${output}`)
  return match[1]
}

beforeEach(() => {
  hooks.started.length = 0
  hooks.wakes.length = 0
  hooks.prompts.length = 0
})

describe("shell background mode", () => {
  it.live(
    "returns immediately with the job id and session-scoped metadata",
    (): Effect.Effect<void, unknown, ShellTestServices> =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* provideInstance(tmp)(
          Effect.gen(function* () {
            const shell = yield* init()
            const cmd = command("console.log('bg-done')")
            const result = yield* shell.execute({ command: cmd, background: true }, promptCtx)
            expect(result.metadata.output).toBe("Background shell started")
            expect(result.metadata.exit).toBe(null)
            expect(hooks.started).toHaveLength(1)
            const job = hooks.started[0]
            expect(job.title).toBe(cmd)
            expect(job.type).toBe("bash")
            expect(job.metadata).toEqual({ sessionId: ctx.sessionID, command: cmd })
            expect(result.output).toContain(`job: ${job.id}`)
            expect(result.output).toContain(`log: ${logPath(result.output)}`)
          }),
        )
      }),
  )

  it.live(
    "delivers the completion notice, wakes the goal, and writes the log file",
    (): Effect.Effect<void, unknown, ShellTestServices> =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* provideInstance(tmp)(
          Effect.gen(function* () {
            const shell = yield* init()
            const cmd = command("console.log('bg-done')")
            const result = yield* shell.execute({ command: cmd, background: true }, promptCtx)
            const log = logPath(result.output)
            const job = hooks.started[0]
            const output = yield* job.run.pipe(Effect.orDie)
            expect(output).toContain("bg-done")
            expect(hooks.wakes).toHaveLength(1)
            expect(hooks.wakes[0].sessionID).toBe(ctx.sessionID)
            expect(hooks.wakes[0].match).toEqual({ source: "background_job", ids: [job.id!] })
            expect(hooks.wakes[0].options).toEqual({ evaluate: false })
            expect(hooks.wakes[0].payload).toContain(`Background shell completed: ${cmd}`)
            expect(hooks.prompts).toHaveLength(1)
            const part = hooks.prompts[0].parts[0]
            expect(part.type).toBe("text")
            expect(part.synthetic).toBe(true)
            expect(part.text).toContain(`Background shell completed: ${cmd}`)
            expect(part.text).toContain(`job: ${job.id}`)
            expect(part.text).toContain(`log: ${log}`)
            expect(readFileSync(log, "utf8")).toContain("bg-done")
          }),
        )
      }),
  )

  it.live(
    "reports a nonzero exit as a failed background shell",
    (): Effect.Effect<void, unknown, ShellTestServices> =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* provideInstance(tmp)(
          Effect.gen(function* () {
            const shell = yield* init()
            const cmd = command("process.exit(3)")
            yield* shell.execute({ command: cmd, background: true }, promptCtx)
            yield* hooks.started[0].run.pipe(Effect.orDie)
            expect(hooks.wakes).toHaveLength(1)
            expect(hooks.wakes[0].payload).toContain(`Background shell failed (exit 3): ${cmd}`)
            expect(hooks.wakes[0].options).toEqual({ evaluate: false })
            expect(hooks.prompts[0].parts[0].text).toContain("Background shell failed (exit 3)")
          }),
        )
      }),
  )

  it.live(
    "wakes the goal with evaluate=true when the job is interrupted",
    (): Effect.Effect<void, unknown, ShellTestServices> =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* provideInstance(tmp)(
          Effect.gen(function* () {
            const shell = yield* init()
            const cmd = command("console.log('bg-cancel'); setTimeout(() => {}, 5000)")
            yield* shell.execute({ command: cmd, background: true }, promptCtx)
            const fiber = yield* Effect.forkChild(hooks.started[0].run)
            yield* Effect.sleep("300 millis")
            yield* Fiber.interrupt(fiber)
            expect(hooks.wakes).toHaveLength(1)
            expect(hooks.wakes[0].payload).toContain(`Background shell cancelled: ${cmd}`)
            expect(hooks.wakes[0].options).toEqual({ evaluate: true })
          }),
        )
      }),
  )

  it.live(
    "refuses background mode without a session prompt context",
    (): Effect.Effect<void, unknown, ShellTestServices> =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* provideInstance(tmp)(
          Effect.gen(function* () {
            const shell = yield* init()
            const exit = yield* shell
              .execute({ command: command("console.log('no-ops')"), background: true }, ctx)
              .pipe(Effect.exit)
            if (!Exit.isFailure(exit)) throw new Error("expected background mode to be refused")
            expect(String(Cause.squash(exit.cause))).toContain("requires a session prompt context")
            expect(hooks.started).toHaveLength(0)
          }),
        )
      }),
  )
})
