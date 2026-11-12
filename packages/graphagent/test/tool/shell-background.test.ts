// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { readFileSync } from "node:fs"
import path from "node:path"
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
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"

type WakeCall = {
  sessionID: SessionID
  match: Goal.WakeMatch
  payload?: string
  options?: { readonly evaluate?: boolean }
  /** Registry status of the woken job at the moment of the wake. */
  status?: BackgroundJob.Info["status"]
}

type PromptCall = {
  parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>
  /** Registry status of the job at the moment its notice was prompted. */
  status?: BackgroundJob.Info["status"]
}

// Tests in a file run sequentially, so one module-level recorder is enough and
// keeps the mock layer static for testEffect. `jobs` stands in for the registry
// so a test can observe the status a terminal side effect sees; `events` keeps
// the order of those side effects.
const hooks: {
  started: BackgroundJob.StartInput[]
  jobs: Map<string, BackgroundJob.Info>
  events: string[]
  wakes: WakeCall[]
  prompts: PromptCall[]
} = {
  started: [],
  jobs: new Map(),
  events: [],
  wakes: [],
  prompts: [],
}

const statusOf = (id: string | undefined) => (id === undefined ? undefined : hooks.jobs.get(id)?.status)

const promptOps = {
  cancel: () => Effect.void,
  resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt: (input: { parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }> }) =>
    Effect.sync(() => {
      hooks.events.push("prompt")
      hooks.prompts.push({ parts: input.parts, status: statusOf(hooks.started.at(-1)?.id) })
    }).pipe(Effect.as(undefined)),
}

const backgroundLayer = Layer.mergeAll(
  Layer.mock(BackgroundJob.Service, {
    start: (input: BackgroundJob.StartInput) =>
      Effect.sync(() => {
        hooks.started.push(input)
        const info: BackgroundJob.Info = {
          id: input.id ?? "job_unknown",
          type: input.type,
          status: "running",
          started_at: 0,
          title: input.title,
          metadata: input.metadata,
        }
        hooks.jobs.set(info.id, info)
        return { ...info }
      }),
    beginSettling: (id: string) =>
      Effect.sync(() => {
        hooks.events.push("settling")
        const job = hooks.jobs.get(id)
        if (job?.status === "running") job.status = "settling"
        return job
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
        hooks.events.push("wake")
        hooks.wakes.push({ sessionID, match, payload, options, status: statusOf(match.ids[0]) })
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

// Readiness and release probes for a child that publishes its pid to a file.
const readPid = (file: string) =>
  Effect.sync(() => {
    try {
      return Number(readFileSync(file, "utf8")) || undefined
    } catch {
      return undefined
    }
  })

const exited = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0)
      return undefined
    } catch {
      return true as const
    }
  })

beforeEach(() => {
  hooks.started.length = 0
  hooks.jobs.clear()
  hooks.events.length = 0
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
            expect(job.metadata).toEqual({ sessionID: ctx.sessionID, command: cmd })
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
    "marks the job settling before it wakes the goal and prompts the notice",
    (): Effect.Effect<void, unknown, ShellTestServices> =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* provideInstance(tmp)(
          Effect.gen(function* () {
            const shell = yield* init()
            const cmd = command("console.log('bg-done')")
            yield* shell.execute({ command: cmd, background: true }, promptCtx)
            yield* hooks.started[0].run.pipe(Effect.orDie)
            // The notice prompt waits for a whole session turn. A job that still reads
            // as running during it is awaited again after its only wake was spent.
            expect(hooks.events).toEqual(["settling", "wake", "prompt"])
            expect(hooks.wakes[0].status).toBe("settling")
            expect(hooks.prompts[0].status).toBe("settling")
          }),
        )
      }),
  )

  it.live(
    "delivers a failure notice and wakes the goal when the process cannot be started",
    (): Effect.Effect<void, unknown, ShellTestServices> =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* provideInstance(tmp)(
          Effect.gen(function* () {
            const shell = yield* init()
            const cmd = command("console.log('never-runs')")
            // The tool call succeeds and reports the job as started; only the spawn inside the job fails.
            const result = yield* shell.execute(
              { command: cmd, workdir: path.join(tmp, "missing-dir"), background: true },
              promptCtx,
            )
            expect(result.output).toContain("Background shell started")
            const job = hooks.started[0]
            const exit = yield* job.run.pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            expect(hooks.events).toEqual(["settling", "wake", "prompt"])
            expect(hooks.wakes).toHaveLength(1)
            expect(hooks.wakes[0].match).toEqual({ source: "background_job", ids: [job.id!] })
            expect(hooks.wakes[0].status).toBe("settling")
            expect(hooks.prompts).toHaveLength(1)
            expect(hooks.prompts[0].status).toBe("settling")
            const part = hooks.prompts[0].parts[0]
            expect(part.synthetic).toBe(true)
            expect(part.text).toContain(`Background shell failed (`)
            expect(part.text).toContain("missing-dir")
            expect(part.text).toContain(cmd)
            expect(part.text).toContain(`job: ${job.id}`)
            expect(part.text).toContain(`log: ${logPath(result.output)}`)
          }),
        )
      }),
  )

  it.live(
    "keeps the job cancellable while its failure notice waits for the notice turn",
    (): Effect.Effect<void, unknown, ShellTestServices> =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* provideInstance(tmp)(
          Effect.gen(function* () {
            const shell = yield* init()
            // A prompt that never returns stands in for a long notice turn.
            const waiting: Tool.Context = {
              ...ctx,
              extra: {
                promptOps: {
                  ...promptOps,
                  prompt: (input: Parameters<typeof promptOps.prompt>[0]) =>
                    promptOps.prompt(input).pipe(Effect.andThen(Effect.never)),
                },
              },
            }
            yield* shell.execute(
              {
                command: command("console.log('never-runs')"),
                workdir: path.join(tmp, "missing-dir"),
                background: true,
              },
              waiting,
            )
            const fiber = yield* Effect.forkChild(hooks.started[0].run)
            yield* pollWithTimeout(
              Effect.sync(() => (hooks.events.includes("prompt") ? (true as const) : undefined)),
              "the failure notice never reached its prompt",
            )
            yield* awaitWithTimeout(Fiber.interrupt(fiber), "interrupting the job hung on its failure notice")
          }),
        )
      }),
  )

  it.live(
    "wakes the goal with evaluate=true and releases the process when the job is interrupted",
    (): Effect.Effect<void, unknown, ShellTestServices> =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* provideInstance(tmp)(
          Effect.gen(function* () {
            const shell = yield* init()
            // The child publishes its pid once it is running, so the interrupt cannot race its startup.
            const ready = path.join(tmp, "bg-ready.pid")
            const cmd = command(
              `require('fs').writeFileSync('${ready.replaceAll("\\", "/")}', String(process.pid)); setTimeout(() => {}, 30000)`,
            )
            yield* shell.execute({ command: cmd, background: true }, promptCtx)
            const fiber = yield* Effect.forkChild(hooks.started[0].run)
            const pid = yield* pollWithTimeout(readPid(ready), "background shell never started")
            // The release probe below is only meaningful if the process is alive now.
            expect(() => process.kill(pid, 0)).not.toThrow()
            yield* Fiber.interrupt(fiber)
            expect(hooks.wakes).toHaveLength(1)
            expect(hooks.wakes[0].payload).toContain(`Background shell cancelled: ${cmd}`)
            expect(hooks.wakes[0].options).toEqual({ evaluate: true })
            // A cancel is not a result, so no notice prompt follows it.
            expect(hooks.prompts).toHaveLength(0)
            yield* pollWithTimeout(exited(pid), "background shell process survived the interrupt")
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
