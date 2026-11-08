import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SettingsHook } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { makeFakeProvider, textScript, toolCallScript } from "../../lib/fake-provider"
import { reset, settle, snapshot, stepBook } from "../../lib/engine-probe"
import { TestInstance } from "../../fixture/fixture"
import { auditHookCommand } from "../../fixture/claude-hook"
import type { BaselineRequest } from "../fingerprint"
import { fingerprintRequests } from "../fingerprint"
import { makePerfLayer, perfConfig } from "../harness"
import { seedHistory } from "../seed"
import type { Measurement, Scenario } from "./types"

// S7: S2's history and compaction pair with PreToolUse, PostToolUse and Stop
// hooks active. The hooks engine materializes a transcript and spawns a shell
// per configured event, so the scenario measures the long-history cost of the
// hook path. Hooks are foreground: the prompt effect awaits every trigger, and
// the audit file is complete when `prompt.prompt` returns.
//
// The read call happens after both compactions, so it cannot re-expose the
// oversized summary that S2 uses to force the second compaction. The turn
// therefore ends with two conversation requests (tool call, then final text)
// instead of S2's one.
export const MESSAGES = 500
const TURNS = MESSAGES / 2
const CONTEXT = 10_000
const OUTPUT = 1_000
const TRIGGER_TOKENS = CONTEXT - 500
const PROMPT_TEXT = "continue the task\n\n" + "context ".repeat(2_000)

export interface S7AuditEntry {
  readonly event: string
  readonly tool: string | null
}

/** One measured pass: its counters and the observations the assertions read. */
export interface S7PassResult extends Measurement {
  /** Request shapes issued by the measured turn. */
  readonly requests: ReadonlyArray<BaselineRequest>
  readonly compactionRequests: number
  readonly conversationRequests: number
  readonly compactionMessages: number
  readonly audit: ReadonlyArray<S7AuditEntry>
  readonly finalRole: SessionV1.Info["role"]
}

export interface S7Result extends S7PassResult {
  /** The first measured pass; the top-level fields mirror the second one. */
  readonly first: S7PassResult
}

export function s7Scenario(): Scenario<S7Result, Session.Service | SessionPrompt.Service> {
  const baseModel = perfConfig.provider.test.models["test-model"]
  const config = {
    ...perfConfig,
    compaction: { auto: true },
    provider: {
      ...perfConfig.provider,
      test: {
        ...perfConfig.provider.test,
        models: {
          "test-model": { ...baseModel, limit: { context: CONTEXT, output: OUTPUT } },
        },
      },
    },
  }

  // Timeout is in seconds; the default is ten minutes, so a hung hook would
  // otherwise drain the test timeout instead of failing on the audit assertion.
  const hook = { type: "command" as const, command: auditHookCommand(), timeout: 10 }
  const hooksConfig = {
    PreToolUse: [{ matcher: "read", hooks: [hook] }],
    PostToolUse: [{ matcher: "read", hooks: [hook] }],
    Stop: [{ hooks: [hook] }],
  }

  // SettingsHook.layer only needs SessionHooks for the command handler; the
  // default layer would construct MCP, provider and other production services.
  const hooks: Layer.Layer<SettingsHook.Service> = SettingsHook.layer.pipe(
    Layer.provideMerge(SessionHooks.defaultLayer),
  )

  let compactions = 0
  let conversation = 0
  const fake = makeFakeProvider({
    title: "S7",
    script: (input, request) => {
      if (request.purpose === "compaction") {
        compactions += 1
        return textScript(compactions === 1 ? "oversized summary ".repeat(3_000) : "short summary")
      }
      if (request.purpose !== "conversation") return textScript("ok")
      const step = conversation
      conversation += 1
      if (step === 0)
        return toolCallScript(input, {
          id: "call-read-s7",
          name: "read",
          input: { filePath: "read-target.txt" },
        })
      return textScript("done")
    },
  })

  const run = Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const { directory } = yield* TestInstance
    const auditPath = path.join(directory, ".agents", "hook-audit.jsonl")

    const runScenario = (title: string) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.rm(auditPath, { force: true }))
        const session = yield* sessions.create({ title })
        yield* seedHistory(session.id, {
          turns: TURNS,
          lastTokens: { input: TRIGGER_TOKENS, output: 50 },
        })
        reset()
        fake.reset()
        compactions = 0
        conversation = 0
        const result = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: PROMPT_TEXT }],
        })
        yield* settle({ activity: fake.activity, timeoutMs: 30_000 })
        // Snapshot before reading the audit file: that read parses JSON
        // through the global counter and would otherwise be measured.
        const counts = snapshot()
        // Close the per-step book immediately too: `sessions.messages` and the
        // audit read below touch the same counters.
        const book = stepBook()
        const requests = fake.requests.filter((request) => request.purpose !== "auxiliary")
        const messages = yield* sessions.messages({ sessionID: session.id })
        const audit = yield* Effect.promise(async () => {
          try {
            const text = await fs.readFile(auditPath, "utf8")
            return text
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as S7AuditEntry)
          } catch {
            return []
          }
        })
        return {
          counts,
          steps: book.steps,
          perStep: book.perStep,
          requests: fingerprintRequests(requests),
          compactionRequests: requests.filter((request) => request.purpose === "compaction").length,
          conversationRequests: requests.filter((request) => request.purpose === "conversation").length,
          compactionMessages: messages.filter((message) => message.parts.some((part) => part.type === "compaction"))
            .length,
          audit,
          finalRole: result.info.role,
        }
      })

    yield* runScenario("S7 warmup")

    const first = yield* runScenario("S7 first")
    const second = yield* runScenario("S7 second")
    return { ...second, first }
  })

  return {
    id: "S7",
    layer: makePerfLayer(fake, { hooks }),
    instance: {
      git: true,
      config,
      init: (directory) =>
        Effect.promise(async () => {
          const agents = path.join(directory, ".agents")
          await fs.mkdir(agents, { recursive: true })
          await Bun.write(path.join(agents, "hooks.json"), JSON.stringify(hooksConfig))
          await Bun.write(path.join(directory, "read-target.txt"), "hook target\n")
        }),
    },
    timeout: 180_000,
    run,
  }
}
