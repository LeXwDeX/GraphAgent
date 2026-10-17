import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { SettingsHook, type HookPayload, type TriggerContext } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import type { Message } from "@/hook/transcript"
import { promptIdentity, variantToEffort } from "@/hook/prompt-identity"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { hookCommand } from "../fixture/claude-hook"

const it = testEffect(
  SettingsHook.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provideMerge(SessionHooks.defaultLayer),
  ),
)

// CC common-envelope fields added for parity: prompt_id, scratchpad_dir and
// effort. Capture the real stdin envelope through a session-registered hook.
const capture = (
  payload: HookPayload,
  context: Omit<TriggerContext, "sessionID" | "transcriptPath"> = {},
  options: { sessionID?: SessionID; run?: string } = {},
) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const hooks = yield* SettingsHook.Service
    const store = yield* SessionHooks.Service
    const id = options.sessionID ?? SessionID.descending()
    const audit = path.join(test.directory, `hook-envelope-${options.run ?? id}.jsonl`)
    const command = hookCommand(`
      const input = JSON.parse(await Bun.stdin.text());
      const fs = await import('node:fs/promises');
      await fs.appendFile(${JSON.stringify(audit)}, JSON.stringify(input) + '\\n');
    `)
    yield* store.add(id, { event: payload.event, matcher: "*", hooks: [{ type: "command", command }] })
    yield* hooks.trigger(payload, { sessionID: id, transcriptPath: "", ...context })
    return yield* Effect.promise(async () =>
      (await fs.readFile(audit, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    )
  })

describe("prompt_id / scratchpad_dir / effort envelope fields", () => {
  it.instance("PreToolUse carries prompt_id, a per-session scratchpad_dir and effort", () =>
    Effect.gen(function* () {
      const [envelope] = yield* capture(
        { event: "PreToolUse", toolName: "Bash", toolInput: { command: "ls" }, toolUseID: "toolu_1" },
        { promptID: "msg_prompt_1", effort: "high" },
      )
      expect(envelope.prompt_id).toBe("msg_prompt_1")
      expect(envelope.effort).toEqual({ level: "high" })
      // The scratchpad is materialized lazily by the trigger and is a real,
      // session-hashed directory under the temp root.
      expect(envelope.scratchpad_dir).toContain(path.join("hooks", "scratchpad"))
      const stat = yield* Effect.promise(() => fs.stat(envelope.scratchpad_dir))
      expect(stat.isDirectory()).toBe(true)
    }),
  )

  it.instance("scratchpad_dir is stable across triggers of the same session", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const [first] = yield* capture(
        { event: "PreToolUse", toolName: "Bash", toolInput: { command: "ls" } },
        {},
        { sessionID, run: "first" },
      )
      const [second] = yield* capture(
        { event: "PostToolUse", toolName: "Bash", toolInput: { command: "ls" }, toolResponse: "ok" },
        {},
        { sessionID, run: "second" },
      )
      expect(first.scratchpad_dir).toBe(second.scratchpad_dir)
    }),
  )

  it.instance("effort is limited to tool-use-context events", () =>
    Effect.gen(function* () {
      const [envelope] = yield* capture({ event: "SessionStart", source: "startup" }, { effort: "max" })
      expect(envelope.effort).toBeUndefined()
      expect(envelope.scratchpad_dir).toBeDefined()
    }),
  )

  it.instance("Stop carries effort", () =>
    Effect.gen(function* () {
      const [stop] = yield* capture(
        { event: "Stop", stopHookActive: false },
        { promptID: "msg_prompt_2", effort: "low" },
      )
      expect(stop.prompt_id).toBe("msg_prompt_2")
      expect(stop.effort).toEqual({ level: "low" })
    }),
  )
})

describe("sessionless Notification", () => {
  it.instance("omits session_id, prompt_id and scratchpad_dir", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const hooks = yield* SettingsHook.Service
      const audit = path.join(test.directory, "hook-envelope-sessionless.jsonl")
      const command = hookCommand(`
        const input = JSON.parse(await Bun.stdin.text());
        const fs = await import('node:fs/promises');
        await fs.appendFile(${JSON.stringify(audit)}, JSON.stringify(input) + '\\n');
      `)
      yield* Effect.promise(() =>
        fs
          .mkdir(path.join(test.directory, ".opencode"), { recursive: true })
          .then(() =>
            fs.writeFile(
              path.join(test.directory, ".opencode", "hooks.json"),
              JSON.stringify({ Notification: [{ hooks: [{ type: "command", command }] }] }),
            ),
          ),
      )
      yield* hooks.trigger(
        { event: "Notification", message: "auth required" },
        { sessionID: "", transcriptPath: "", promptID: "msg_ignored", effort: "high" },
      )
      const envelope = yield* Effect.promise(async () =>
        JSON.parse((await fs.readFile(audit, "utf8")).trim().split("\n")[0]),
      )
      expect(envelope.session_id).toBeUndefined()
      expect(envelope.transcript_path).toBeUndefined()
      expect(envelope.prompt_id).toBeUndefined()
      expect(envelope.scratchpad_dir).toBeUndefined()
      expect(envelope.effort).toBeUndefined()
      expect(envelope.hook_event_name).toBe("Notification")
    }),
  )
})

describe("prompt identity derivation", () => {
  const message = (id: string, role: "user" | "assistant", variant?: string, parts: unknown[] = []) =>
    ({
      info: {
        id,
        sessionID: "ses_1",
        role,
        time: { created: 0 },
        ...(variant ? { model: { providerID: "p", modelID: "m", variant } } : {}),
      },
      parts,
    }) satisfies Message

  test("variantToEffort maps CC levels and clamps provider-only tiers", () => {
    expect(variantToEffort("low")).toBe("low")
    expect(variantToEffort("xhigh")).toBe("xhigh")
    expect(variantToEffort("max")).toBe("max")
    expect(variantToEffort("none")).toBe("low")
    expect(variantToEffort("minimal")).toBe("low")
    expect(variantToEffort("ultra")).toBe("max")
    expect(variantToEffort("custom-fast")).toBeUndefined()
    expect(variantToEffort(undefined)).toBeUndefined()
  })

  test("promptIdentity picks the newest user prompt and its variant", () => {
    expect(
      promptIdentity([
        message("msg_user_1", "user", "high"),
        message("msg_asst_1", "assistant"),
        message("msg_user_2", "user", "max"),
      ]),
    ).toEqual({ promptID: "msg_user_2", effort: "max" })
  })

  test("promptIdentity ignores compaction carriers and sessions without user input", () => {
    expect(
      promptIdentity([
        message("msg_user_1", "user", "high"),
        message("msg_compaction", "user", "high", [{ type: "compaction" }]),
      ]),
    ).toEqual({ promptID: "msg_user_1", effort: "high" })
    expect(promptIdentity([message("msg_asst", "assistant")])).toEqual({})
  })
})
