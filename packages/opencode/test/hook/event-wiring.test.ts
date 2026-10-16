import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { Goal } from "@/goal/goal"
import { SessionAutomationLease } from "@/session/automation-lease"
import { Dag } from "@/dag/dag"
import { SessionID } from "@/session/schema"
import { Permission } from "@/permission"
import { Notification } from "@/notification"
import { Instruction } from "@/session/instruction"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FetchHttpClient } from "effect/unstable/http"
import { SettingsHook, type HookPayload } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { InstanceBootstrap } from "@/project/bootstrap"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// hook-event-wiring integration tests: each newly wired trigger site fires the
// expected HookEvent with the expected payload. A recording SettingsHook stub
// captures trigger payloads; the service under test is built with the recorder
// provided so its serviceOption resolution sees it.

const emptyResult = {
  blocked: undefined,
  permissionDecision: undefined,
  permissionDecisionReason: undefined,
  additionalContexts: [] as string[],
  systemMessages: [] as string[],
  hookSpecificOutput: undefined,
}

function makeRecorder() {
  const recorded: HookPayload[] = []
  const layer = Layer.succeed(
    SettingsHook.Service,
    SettingsHook.Service.of({
      trigger: (payload) => Effect.sync(() => (recorded.push(payload), { ...emptyResult })),
      list: () => Effect.succeed([]),
    }),
  )
  return { recorded, layer }
}

// ── 4.1 SessionEnd fires on session delete ─────────────────────

const sessionRecorder = makeRecorder()
const sessionEnv = Layer.mergeAll(
  Session.layer.pipe(
    Layer.provide(sessionRecorder.layer),
    Layer.provide(Database.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provide(SessionProjector.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(BackgroundJob.defaultLayer),
    Layer.provide(Goal.defaultLayer),
    Layer.provide(SessionAutomationLease.defaultLayer),
    Layer.provide(Dag.defaultLayer),
  ),
  Database.defaultLayer,
)

const sessionIt = testEffect(sessionEnv)

describe("SessionEnd trigger on session delete", () => {
  sessionIt.instance("fires with the documented other reason", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "doomed" })
      // The session row is projected asynchronously from Event.Created — wait
      // until it is queryable before deleting.
      yield* pollWithTimeout(
        sessions.get(chat.id).pipe(
          Effect.as(true as const),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
        "session row never became queryable",
        "5 seconds",
      )
      yield* sessions.remove(chat.id)
      const events = sessionRecorder.recorded.filter((p) => p.event === "SessionEnd")
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ event: "SessionEnd", reason: "other" })
    }),
  )
})

// ── 4.4 InstructionsLoaded fires per instruction file, truncated ──

const instructionRecorder = makeRecorder()
const instructionEnv = Instruction.layer.pipe(
  Layer.provide([
    instructionRecorder.layer,
    Config.defaultLayer,
    Global.layer,
    FSUtil.defaultLayer,
    FetchHttpClient.layer,
    RuntimeFlags.defaultLayer,
  ]),
)

const instructionIt = testEffect(instructionEnv)

const BIG_CONTENT = "A".repeat(40 * 1024)

describe("InstructionsLoaded trigger on instruction file load", () => {
  instructionIt.instance(
    "fires once per loaded file with 32KB-truncated content",
    () =>
      Effect.gen(function* () {
        const instruction = yield* Instruction.Service
        yield* instruction.system({ sessionID: "ses_instructions", transcriptPath: "/tmp/instruction-fixture.jsonl" })
        const events = instructionRecorder.recorded.filter(
          (p): p is Extract<HookPayload, { event: "InstructionsLoaded" }> =>
            p.event === "InstructionsLoaded" && !!p.path?.endsWith("AGENTS.md"),
        )
        expect(events).toHaveLength(1)
        expect(events[0].content).toHaveLength(32 * 1024)

        // Second load must not re-announce (once per instance)
        yield* instruction.system({ sessionID: "ses_instructions", transcriptPath: "/tmp/instruction-fixture.jsonl" })
        const again = instructionRecorder.recorded.filter(
          (p) => p.event === "InstructionsLoaded" && (p as { path?: string }).path?.endsWith("AGENTS.md"),
        )
        expect(again).toHaveLength(1)
      }),
    {
      init: (dir) => Effect.promise(() => fs.writeFile(path.join(dir, "AGENTS.md"), BIG_CONTENT)),
    },
  )
})

// ── 4.6 Setup runs only for explicit initialization ─────────────

const setupRecorder = makeRecorder()
const bootstrapEnv = Layer.mergeAll(InstanceBootstrap.defaultLayer, setupRecorder.layer)

const bootstrapIt = testEffect(bootstrapEnv)

describe("Setup trigger on instance bootstrap", () => {
  bootstrapIt.instance("does not run for ordinary startup", () =>
    Effect.gen(function* () {
      const bootstrap = yield* InstanceBootstrap.Service
      yield* bootstrap.run
      const events = setupRecorder.recorded.filter((p) => p.event === "Setup")
      expect(events).toEqual([])
    }),
  )
})

// ── 4.5 Notification fires on permission ask without blocking ───

const notificationRecorder = makeRecorder()
// Permission.layer's HARD deps (EventV2Bridge, Database) are yielded at
// construction, so they must be Layer.provided (mergeAll siblings don't
// cross-provide at construction). The OPTIONAL deps (Notification emitter,
// recording SettingsHook) are resolved at call time via serviceOption, so they
// are merged as siblings to be visible at call time.
const permissionEnv = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(EventV2Bridge.defaultLayer)),
  notificationRecorder.layer,
  Notification.defaultLayer,
)

const permissionIt = testEffect(permissionEnv)

describe("Notification trigger on permission ask", () => {
  permissionIt.instance("fires permission_prompt only after six seconds without blocking pending", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const fiber = yield* permission
        .ask({
          sessionID: SessionID.make("ses_notify_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        })
        .pipe(Effect.forkScoped)

      // The ask surfaces as pending (flow not blocked by the hook)...
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const items = yield* permission.list()
          return items.length === 1 ? (true as const) : undefined
        }),
        "permission ask never became pending",
        "5 seconds",
      )
      expect(notificationRecorder.recorded.filter((p) => p.event === "Notification")).toEqual([])
      yield* Effect.sleep("6 seconds")
      // ...and the delayed Notification trigger fires.
      yield* pollWithTimeout(
        Effect.sync(() =>
          notificationRecorder.recorded.some((p) => p.event === "Notification") ? (true as const) : undefined,
        ),
        "Notification hook never fired",
        "5 seconds",
      )
      const events = notificationRecorder.recorded.filter(
        (p): p is Extract<HookPayload, { event: "Notification" }> => p.event === "Notification",
      )
      expect(events[0].notificationType).toBe("permission_prompt")
      expect(events[0].message).toContain("bash")

      // Unblock the pending ask.
      for (const item of yield* permission.list()) {
        yield* permission.reply({ requestID: item.id, reply: "reject" })
      }
      yield* Fiber.await(fiber)
    }),
  )
})

// CwdChanged now belongs to persisted MoveSession, not worktree creation.
// The real producer → command → transcript/ownership path is exercised in
// hooks-lifecycle-cwd.test.ts.

// ── 4.3 ConfigChange fires on hooks.json hot-reload ─────────────
// Uses the REAL SettingsHook layer: a ConfigChange command hook touches a
// marker file when the watched hooks.json is modified.

const settingsEnv = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)

const settingsIt = testEffect(settingsEnv)

const opencodeDir = (dir: string) => path.join(dir, ".opencode")
const hooksPath = (dir: string) => path.join(opencodeDir(dir), "hooks.json")
const markerPath = (dir: string) => path.join(dir, "configchange-fired")

const configChangeSettings = (dir: string, version: string) => ({
  // version key forces distinct file content across writes
  __version: version,
  ConfigChange: [{ hooks: [{ type: "command", command: `touch '${markerPath(dir)}'` }] }],
})

const writeHooks = (dir: string, version: string) =>
  Effect.promise(async () => {
    await fs.mkdir(opencodeDir(dir), { recursive: true })
    await fs.writeFile(hooksPath(dir), JSON.stringify(configChangeSettings(dir, version)))
  })

describe("ConfigChange trigger on hooks hot-reload", () => {
  settingsIt.instance(
    "fires when a watched hooks.json is modified",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const inst = yield* TestInstance

        // First trigger constructs state and starts the watcher (v1 on disk).
        yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess_wiring_test", transcriptPath: "" },
        )

        // Modify the watched hooks.json → hot-reload → ConfigChange fires →
        // command hook touches the marker file. Explicitly bump mtime to a
        // distinct future timestamp: on coarse-mtime filesystems (WSL2 DrvFs,
        // some network FS) a same-resolution write may not register as changed,
        // starving the mtime poll. utimes forces a detectable change.
        yield* writeHooks(inst.directory, "v2")
        yield* Effect.promise(async () => {
          const future = new Date(Date.now() + 2000)
          await fs.utimes(hooksPath(inst.directory), future, future)
        })
        yield* pollWithTimeout(
          Effect.promise(() =>
            fs.access(markerPath(inst.directory)).then(
              () => true as const,
              () => undefined,
            ),
          ),
          "ConfigChange hook did not fire within timeout",
          "10 seconds",
        )
      }),
    { init: (dir) => writeHooks(dir, "v1") },
  )
})
