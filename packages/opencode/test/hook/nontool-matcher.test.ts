import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { hookCommand } from "../fixture/claude-hook"

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(testLayer)

const ctxHook = (marker: string) => ({
  type: "command",
  command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { additionalContext: marker } })}'`,
})

// Claude Code matches non-tool events against an event-specific field:
// SessionStart → source (startup|resume|clear|compact), PreCompact → trigger
// (manual|auto), SessionEnd → reason, Notification → notification_type.
// /import-claude-hooks imports such matchers "as-is".
const write = (dir: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "hooks.json"),
      JSON.stringify({
        SessionStart: [
          { matcher: "startup", hooks: [ctxHook("session-start-startup")] },
          { matcher: "resume|compact", hooks: [ctxHook("session-start-resume")] },
        ],
        PreCompact: [
          {
            matcher: "auto",
            hooks: [
              {
                type: "command",
                command: `printf '%s' '${JSON.stringify({ decision: "block", reason: "precompact-auto" })}'`,
              },
            ],
          },
        ],
        SubagentStop: [{ matcher: "explore", hooks: [ctxHook("subagent-explore")] }],
        // UserPromptSubmit has no matcher support: the matcher is ignored.
        UserPromptSubmit: [{ matcher: "anything", hooks: [ctxHook("prompt-always")] }],
      }),
    )
  })

describe("matchers on non-tool events", () => {
  it.instance(
    "SessionStart matcher 'startup' fires for source=startup",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "ses_matcher_1", transcriptPath: "" },
        )
        expect(r.additionalContexts).toEqual(["session-start-startup"])
      }),
    { init: write },
  )

  it.instance(
    "PreCompact matcher 'auto' fires for trigger=auto",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "PreCompact", trigger: "auto" },
          { sessionID: "ses_matcher_2", transcriptPath: "" },
        )
        expect(r.blocked?.reason).toBe("precompact-auto")
        const manual = yield* hook.trigger(
          { event: "PreCompact", trigger: "manual" },
          { sessionID: "ses_matcher_2b", transcriptPath: "" },
        )
        expect(manual.blocked).toBeUndefined()
      }),
    { init: write },
  )

  it.instance(
    "SubagentStop matcher filters on agent type",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const hit = yield* hook.trigger(
          { event: "SubagentStop", stopHookActive: false, agentType: "explore" },
          { sessionID: "ses_matcher_3", transcriptPath: "" },
        )
        const miss = yield* hook.trigger(
          { event: "SubagentStop", stopHookActive: false, agentType: "general" },
          { sessionID: "ses_matcher_3", transcriptPath: "" },
        )
        expect(hit.additionalContexts).toEqual(["subagent-explore"])
        expect(miss.additionalContexts).toEqual([])
      }),
    { init: write },
  )

  it.instance(
    "events without matcher support ignore the matcher",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "UserPromptSubmit", prompt: "hi" },
          { sessionID: "ses_matcher_4", transcriptPath: "" },
        )
        expect(r.additionalContexts).toEqual(["prompt-always"])
      }),
    { init: write },
  )
})

// ConfigChange, StopFailure, InstructionsLoaded, Elicitation and ElicitationResult
// filter on their own target field. None of them consumes additionalContext, so
// observe execution through marker files instead of hook output.
const markerHook = (file: string) => ({
  type: "command",
  command: hookCommand(`require("node:fs").writeFileSync(${JSON.stringify(file)}, "1")`),
})

const writeMarkers = (dir: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    const marker = (name: string) => markerHook(path.join(dir, `marker-${name}`))
    await fs.writeFile(
      path.join(dir, ".opencode", "hooks.json"),
      JSON.stringify({
        ConfigChange: [{ matcher: "project_settings", hooks: [marker("config-change")] }],
        StopFailure: [{ matcher: "rate_limit|overloaded", hooks: [marker("stop-failure")] }],
        InstructionsLoaded: [{ matcher: "session_start", hooks: [marker("instructions-loaded")] }],
        Elicitation: [{ matcher: "fixture", hooks: [marker("elicitation")] }],
        ElicitationResult: [{ matcher: "fixture", hooks: [marker("elicitation-result")] }],
      }),
    )
  })

const markerExists = (directory: string, name: string) =>
  Effect.promise(() =>
    fs.access(path.join(directory, `marker-${name}`)).then(
      () => true,
      () => false,
    ),
  )

describe("matcher targets on lifecycle and elicitation events", () => {
  it.instance(
    "ConfigChange matcher filters on source",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const { directory } = yield* TestInstance
        yield* hook.trigger(
          { event: "ConfigChange", source: "user_settings", configPath: "/tmp/hooks.json" },
          {
            sessionID: "ses_matcher_config_miss",
            transcriptPath: "",
          },
        )
        expect(yield* markerExists(directory, "config-change")).toBe(false)
        yield* hook.trigger(
          { event: "ConfigChange", source: "project_settings", configPath: "/tmp/hooks.json" },
          {
            sessionID: "ses_matcher_config_hit",
            transcriptPath: "",
          },
        )
        expect(yield* markerExists(directory, "config-change")).toBe(true)
      }),
    { init: writeMarkers },
  )

  it.instance(
    "StopFailure matcher filters on error, including the exact-name list branch",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const { directory } = yield* TestInstance
        yield* hook.trigger(
          { event: "StopFailure", stopHookActive: false, error: "server_error" },
          {
            sessionID: "ses_matcher_stopfail_miss",
            transcriptPath: "",
          },
        )
        expect(yield* markerExists(directory, "stop-failure")).toBe(false)
        yield* hook.trigger(
          { event: "StopFailure", stopHookActive: false, error: "overloaded" },
          {
            sessionID: "ses_matcher_stopfail_hit",
            transcriptPath: "",
          },
        )
        expect(yield* markerExists(directory, "stop-failure")).toBe(true)
      }),
    { init: writeMarkers },
  )

  it.instance(
    "InstructionsLoaded matcher filters on load reason",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const { directory } = yield* TestInstance
        yield* hook.trigger(
          { event: "InstructionsLoaded", path: "/tmp/AGENTS.md", loadReason: "compact" },
          {
            sessionID: "ses_matcher_instructions_miss",
            transcriptPath: "",
          },
        )
        expect(yield* markerExists(directory, "instructions-loaded")).toBe(false)
        yield* hook.trigger(
          { event: "InstructionsLoaded", path: "/tmp/AGENTS.md", loadReason: "session_start" },
          {
            sessionID: "ses_matcher_instructions_hit",
            transcriptPath: "",
          },
        )
        expect(yield* markerExists(directory, "instructions-loaded")).toBe(true)
      }),
    { init: writeMarkers },
  )

  it.instance(
    "Elicitation matcher filters on MCP server name",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const { directory } = yield* TestInstance
        yield* hook.trigger(
          { event: "Elicitation", serverName: "other", message: "hi" },
          {
            sessionID: "ses_matcher_elicitation_miss",
            transcriptPath: "",
          },
        )
        expect(yield* markerExists(directory, "elicitation")).toBe(false)
        yield* hook.trigger(
          { event: "Elicitation", serverName: "fixture", message: "hi" },
          {
            sessionID: "ses_matcher_elicitation_hit",
            transcriptPath: "",
          },
        )
        expect(yield* markerExists(directory, "elicitation")).toBe(true)
      }),
    { init: writeMarkers },
  )

  it.instance(
    "ElicitationResult matcher filters on MCP server name",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const { directory } = yield* TestInstance
        yield* hook.trigger(
          { event: "ElicitationResult", serverName: "other", action: "accept" },
          {
            sessionID: "ses_matcher_elicitation_result_miss",
            transcriptPath: "",
          },
        )
        expect(yield* markerExists(directory, "elicitation-result")).toBe(false)
        yield* hook.trigger(
          { event: "ElicitationResult", serverName: "fixture", action: "accept" },
          {
            sessionID: "ses_matcher_elicitation_result_hit",
            transcriptPath: "",
          },
        )
        expect(yield* markerExists(directory, "elicitation-result")).toBe(true)
      }),
    { init: writeMarkers },
  )
})

// Model switch matchers match the canonical Claude model name. Dated suffixes
// (`-20250514`), `.0` alias minors and provider-qualified spellings must all
// converge on `claude-<family>-<major>[-<minor>]`; otherwise an exact canonical
// matcher silently skips the switch.
// PreModelSwitch controls the switch through permissionDecision and does not
// consume additionalContext; PostModelSwitch injects context.
const denySwitch = {
  type: "command",
  command: `printf '%s' '${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreModelSwitch",
      permissionDecision: "deny",
      permissionDecisionReason: "denied",
    },
  })}'`,
}

const writeModel = (dir: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "hooks.json"),
      JSON.stringify({
        PreModelSwitch: [{ matcher: "claude-sonnet-4", hooks: [denySwitch] }],
        PostModelSwitch: [{ matcher: "claude-opus-4|claude-haiku-4-5", hooks: [ctxHook("post-canonical")] }],
      }),
    )
  })

describe("model switch matchers use the canonical model name", () => {
  it.instance(
    "dated, alias and provider-qualified IDs match the canonical alias",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const pre = (toModel: string, id: string) =>
          hook.trigger(
            { event: "PreModelSwitch", fromModel: "claude-sonnet-3-7", toModel },
            { sessionID: id, transcriptPath: "" },
          )
        for (const [toModel, id] of [
          ["claude-sonnet-4-20250514", "ses_model_dated"],
          ["claude-sonnet-4.0", "ses_model_alias"],
          ["us.anthropic.claude-sonnet-4-20250514-v1:0", "ses_model_bedrock"],
        ] as const) {
          expect((yield* pre(toModel, id)).modelSwitchDecision).toBe("deny")
        }
        // An unrelated family must not be matched by the canonical alias.
        expect((yield* pre("claude-haiku-4-5", "ses_model_pre_miss")).modelSwitchDecision).toBeUndefined()
        const post = (toModel: string, id: string) =>
          hook.trigger(
            { event: "PostModelSwitch", fromModel: "claude-sonnet-4", toModel },
            { sessionID: id, transcriptPath: "" },
          )
        expect((yield* post("claude-opus-4.0", "ses_model_opus_alias")).additionalContexts).toEqual(["post-canonical"])
        expect((yield* post("claude-haiku-4-5-20250929", "ses_model_haiku_dated")).additionalContexts).toEqual([
          "post-canonical",
        ])
        // A different family is not silently matched by the canonical alias.
        expect((yield* post("claude-sonnet-4", "ses_model_miss")).additionalContexts).toEqual([])
      }),
    { init: writeModel },
  )
})
