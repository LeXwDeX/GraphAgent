import { describe, expect, test } from "bun:test"
import { Effect, Layer, Fiber } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { SettingsHook, type HookCommand } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { __test__ as agentToolsTest } from "@/hook/agent-tools"

const it = testEffect(
  SettingsHook.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provideMerge(SessionHooks.defaultLayer),
  ),
)
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
const command = (json: unknown, exit = 0) => `printf '%s' ${quote(JSON.stringify(json))}; exit ${exit}`
const runHook = (hook: HookCommand) =>
  Effect.gen(function* () {
    const store = yield* SessionHooks.Service
    const settings = yield* SettingsHook.Service
    const id = SessionID.descending()
    yield* store.add(id, { event: "PreToolUse", hooks: [hook] })
    return yield* settings.trigger(
      { event: "PreToolUse", toolName: "bash", toolInput: { command: "echo safe" } },
      { sessionID: id, transcriptPath: "" },
    )
  })

describe("hooks audit - actual runtime boundary", () => {
  it.instance("valid siblings survive invalid matcher and command shapes", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(instance.directory, ".opencode"), { recursive: true })
        await fs.writeFile(
          path.join(instance.directory, ".opencode/hooks.json"),
          JSON.stringify({
            PreToolUse: [
              null,
              { matcher: 42, hooks: [] },
              {
                hooks: [
                  null,
                  { type: "http" },
                  {
                    type: "command",
                    command: command({
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "deny",
                        permissionDecisionReason: "valid sibling",
                      },
                    }),
                  },
                ],
              },
            ],
          }),
        )
      })
      const settings = yield* SettingsHook.Service
      const result = yield* settings.trigger(
        { event: "PreToolUse", toolName: "write", toolInput: {} },
        { sessionID: SessionID.descending(), transcriptPath: "" },
      )
      expect(result.permissionDecision).toBe("deny")
      expect(result.permissionDecisionReason).toBe("valid sibling")
    }),
  )

  it.instance("invalid JSON-shaped output cannot become prompt context", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "UserPromptSubmit",
        hooks: [{ type: "command", command: command({ hookSpecificOutput: "broken" }) }],
      })
      const result = yield* settings.trigger(
        { event: "UserPromptSubmit", prompt: "hello" },
        { sessionID: id, transcriptPath: "" },
      )
      expect(result.additionalContexts).toEqual([])
    }),
  )

  it.instance("explicit bash interpreter handles bash syntax", () =>
    Effect.gen(function* () {
      const result = yield* runHook({
        type: "command",
        shell: "bash",
        command:
          "[[ -n $BASH_VERSION ]] && " +
          command({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "bash selected",
            },
          }),
      })
      expect(result.permissionDecisionReason).toBe("bash selected")
    }),
  )

  it.instance("timeout ignores JSON even when a TERM handler exits successfully", () =>
    Effect.gen(function* () {
      const result = yield* runHook({
        type: "command",
        timeout: 0.15,
        command:
          "trap 'exit 0' TERM; " +
          command({ decision: "block", reason: "expired" }).replace("; exit 0", "") +
          "; while :; do sleep 1; done",
      })
      expect(result.blocked).toBeUndefined()
    }),
  )

  it.instance("caller interruption kills a command hook process", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const pidFile = path.join(instance.directory, "hook.pid")
      const fiber = yield* runHook({ type: "command", command: `echo $$ > ${quote(pidFile)}; exec sleep 30` }).pipe(
        Effect.forkChild,
      )
      const pid = yield* pollWithTimeout(
        Effect.promise(async () => {
          try {
            return Number(await fs.readFile(pidFile, "utf8")) || undefined
          } catch {
            return undefined
          }
        }),
        "hook never started",
      )
      yield* Fiber.interrupt(fiber)
      yield* pollWithTimeout(
        Effect.sync(() => {
          try {
            process.kill(pid, 0)
            return undefined
          } catch {
            return true
          }
        }),
        "hook process survived caller cancellation",
      )
    }),
  )

  it.instance("a once group stays eligible until a condition matches, then all commands run once", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const settings = yield* SettingsHook.Service
      const id = SessionID.descending()
      const output = path.join(instance.directory, "group-once.txt")
      yield* store.add(id, {
        event: "PreToolUse",
        once: true,
        hooks: ["first", "second"].map((label) => ({
          type: "command",
          if: "Bash(match*)",
          command: `printf '${label}\\n' >> ${quote(output)}`,
        })),
      })
      const trigger = (value: string) =>
        settings.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: { command: value } },
          { sessionID: id, transcriptPath: "" },
        )
      yield* trigger("unmatched")
      expect(yield* store.listAll(id)).toHaveLength(1)
      yield* Effect.all([trigger("match1"), trigger("match2")], { concurrency: "unbounded" })
      expect((yield* Effect.promise(() => fs.readFile(output, "utf8"))).trim().split("\n").sort()).toEqual([
        "first",
        "second",
      ])
      expect(yield* store.listAll(id)).toHaveLength(0)
    }),
  )

  for (const async of [false, true]) {
    it.instance(`command once is atomic with async=${async}`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const store = yield* SessionHooks.Service
        const settings = yield* SettingsHook.Service
        const id = SessionID.descending()
        const output = path.join(instance.directory, "command-once.txt")
        yield* store.add(id, {
          event: "PreToolUse",
          hooks: [{ type: "command", once: true, async, command: `printf 'hit\\n' >> ${quote(output)}` }],
        })
        const trigger = () =>
          settings.trigger(
            { event: "PreToolUse", toolName: "bash", toolInput: {} },
            { sessionID: id, transcriptPath: "" },
          )
        yield* Effect.all([trigger(), trigger(), trigger()], { concurrency: "unbounded" })
        const content = yield* pollWithTimeout(
          Effect.promise(() => fs.readFile(output, "utf8").catch(() => undefined)),
          "once command did not finish",
        )
        expect(content).toBe("hit\n")
        yield* trigger()
        expect(yield* Effect.promise(() => fs.readFile(output, "utf8"))).toBe("hit\n")
      }),
    )
  }

  it.instance("control: exit 0 accepts PreToolUse permission output", () =>
    Effect.gen(function* () {
      const result = yield* runHook({
        type: "command",
        command: command({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "audit-block",
          },
        }),
      })
      expect(result.permissionDecisionReason).toBe("audit-block")
    }),
  )

  it.instance("control: exit 2 blocks using stderr", () =>
    Effect.gen(function* () {
      const result = yield* runHook({ type: "command", command: "printf '%s' 'audit-exit2' >&2; exit 2" })
      expect(result.blocked?.reason).toBe("audit-exit2")
    }),
  )

  it.instance("exit 1 must not apply stdout control decisions", () =>
    Effect.gen(function* () {
      const result = yield* runHook({
        type: "command",
        command: command({ decision: "block", reason: "audit-invalid-exit1" }, 1),
      })
      expect(result.blocked).toBeUndefined()
    }),
  )

  it.instance("malformed hookSpecificOutput must not crash the trigger", () =>
    Effect.gen(function* () {
      const exit = yield* runHook({
        type: "command",
        command: command({ hookSpecificOutput: "bad-output-type" }),
      }).pipe(Effect.exit)
      expect(exit._tag).toBe("Success")
    }),
  )

  it.instance("malformed matcher group must not crash the trigger", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(instance.directory, ".opencode"), { recursive: true })
        await fs.writeFile(
          path.join(instance.directory, ".opencode/hooks.json"),
          JSON.stringify({ PreToolUse: [{ matcher: "Bash" }] }),
        )
      })
      const settings = yield* SettingsHook.Service
      const exit = yield* settings
        .trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          { sessionID: SessionID.descending(), transcriptPath: "" },
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Success")
    }),
  )

  it.instance("once hook must execute only once across concurrent triggers", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const settings = yield* SettingsHook.Service
      const id = SessionID.descending()
      const output = path.join(instance.directory, "once-runs.txt")
      yield* store.add(id, {
        event: "PreToolUse",
        once: true,
        hooks: [{ type: "command", command: `sleep 0.1; printf 'hit\n' >> ${quote(output)}` }],
      })
      yield* Effect.all(
        [1, 2].map(() =>
          settings.trigger(
            { event: "PreToolUse", toolName: "bash", toolInput: {} },
            { sessionID: id, transcriptPath: "" },
          ),
        ),
        { concurrency: "unbounded" },
      )
      const lines = (yield* Effect.promise(() => fs.readFile(output, "utf8"))).trim().split("\n")
      expect(lines).toHaveLength(1)
    }),
  )

  for (const candidate of [
    "find . -delete",
    "sort /dev/null -o audit-output",
    "git diff --output=audit-output",
    "awk 'BEGIN {system(\"touch audit-output\")}'",
    "echo safe\ntouch audit-output",
  ]) {
    test(`read-only agent whitelist must reject: ${candidate}`, () => {
      const rejection = agentToolsTest.whitelistReject(candidate)
      expect(rejection).not.toBeNull()
    })
  }
})
