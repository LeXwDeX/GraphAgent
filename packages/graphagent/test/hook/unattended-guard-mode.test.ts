// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- partial agent, session and processor fixtures use `as never` shims.
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { SessionTools } from "@/session/tools"
import { SettingsHook, type HookPayload, type TriggerContext, type TriggerResult } from "@/hook"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { SafetyGuard } from "@/permission/safety-guard"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildOwner, ChildPermissionPolicy } from "@/session/child/types"
import { MessageID, SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { builtinEntry } from "../fixture/tool-registry"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

/**
 * #1324 P4, `permission_mode` of the tool hook events (Q9). An external command
 * guard decides from the mode it is told. Under the `allow` tier an unattended
 * session (a DAG node, or a task child of a root in DAG mode) has nobody to ask,
 * so its tool hooks see `dontAsk`; under `readonly` they see `plan`; both beat
 * whatever `hookPermissions.mode` is configured. The `ask` tier states nothing of
 * its own, and a session that is not unattended (a root session, a task child
 * while DAG mode is off) keeps the mode it always had.
 */

const directory = "/repo/project"
const rootSessionID = SessionID.make("ses_guard_mode_root")

type Tier = "allow" | "ask" | "readonly"

/** The tier and the hook permission mode the fake global configuration reports. */
const config: { tier: Tier | undefined; hookMode: string | undefined } = { tier: undefined, hookMode: undefined }

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const configLayer = TestConfig.layer({
  get: () => Effect.sync(() => (config.hookMode ? { hookPermissions: { mode: config.hookMode as never } } : {})),
  dagGlobal: () => Effect.sync(() => (config.tier ? { permission: config.tier } : {})),
})

// Every tool event the hook layer sees, with the mode its context carries.
const seen: { event: HookPayload["event"]; sessionID: string; mode: string | undefined }[] = []
const hooks = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload: HookPayload, context: TriggerContext) =>
      Effect.sync(() => {
        seen.push({ event: payload.event, sessionID: context.sessionID, mode: context.permissionMode })
        const result: TriggerResult = { additionalContexts: [], systemMessages: [] }
        return result
      }),
    list: () => Effect.succeed([]),
  }),
)

const noteDefinition = {
  id: "note",
  description: "Fixture tool that asks nothing",
  parameters: Schema.Struct({ text: Schema.String }),
  execute: () => Effect.succeed({ title: "noted", output: "NOTED", metadata: {} }),
}

const it = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(
      Layer.provide(database),
      Layer.provide(bridge),
      Layer.provide(SafetyGuard.layer),
      Layer.provide(hooks),
      Layer.provide(configLayer),
    ),
    hooks,
    configLayer,
    database,
    events,
    bridge,
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
    Layer.mock(Truncate.Service, {}),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed([noteDefinition]),
      resolve: () => Effect.succeed([builtinEntry(noteDefinition)]),
    }),
  ),
)

const register = (sessionID: SessionID, owner: ChildOwner, permission: ChildPermissionPolicy) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const entry = ChildRegistry.create({
        id: `crun_${sessionID}`,
        childSessionID: sessionID,
        parentSessionID: rootSessionID,
        ownerKind: owner.kind,
        ownerKey: owner,
        permission,
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)
      return entry
    }),
    (entry) =>
      Effect.sync(() => {
        ChildRegistry.end(entry, { type: "completed" })
        ChildRegistry.release(entry)
      }),
  )

/** Root session row; a task child's policy reads its `dag_mode` at the moment of the call. */
const seedRoot = (mode: "on" | "off") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_guard_mode"), worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: rootSessionID,
        project_id: Project.ID.make("prj_guard_mode"),
        slug: "guard-mode",
        directory: AbsolutePath.make(directory),
        title: "guard mode root",
        version: "0",
        dag_mode: mode,
      })
      .onConflictDoUpdate({ target: SessionTable.id, set: { dag_mode: mode } })
      .run()
      .pipe(Effect.orDie)
  })

/** One `note` call of `sessionID`; the modes its PreToolUse and PostToolUse hooks were told, in that order. */
const toolHookModes = (sessionID: SessionID, options: { readonly root?: boolean } = {}) =>
  Effect.gen(function* () {
    seen.length = 0
    const instance = yield* TestInstance
    const tools = (yield* SessionTools.resolve({
      agent: { name: "general", permission: [], options: {} } as never,
      model: ProviderTest.model(),
      session: {
        id: sessionID,
        ...(options.root ? {} : { parentID: rootSessionID }),
        directory: instance.directory,
        permission: [],
      } as never,
      processor: {
        message: { id: MessageID.ascending(), sessionID },
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      } as never,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })) as unknown as Record<
      string,
      {
        execute: (
          args: Record<string, unknown>,
          options: { toolCallId: string; messages: unknown[]; abortSignal: AbortSignal },
        ) => Promise<{ output: string }>
      }
    >
    const result = yield* Effect.tryPromise(() =>
      tools.note.execute(
        { text: "hello" },
        { toolCallId: "call-note", messages: [], abortSignal: new AbortController().signal },
      ),
    )
    expect(result.output).toContain("NOTED")
    const tool = seen.filter((entry) => entry.event === "PreToolUse" || entry.event === "PostToolUse")
    expect(tool.map((entry) => entry.event)).toEqual(["PreToolUse", "PostToolUse"])
    expect(tool.every((entry) => entry.sessionID === sessionID)).toBe(true)
    return tool.map((entry) => entry.mode)
  })

/** Every case starts from a clean configuration, and a failing case cannot leak its tier into the next one. */
const withConfig = <A, E, R>(tier: Tier | undefined, hookMode: string | undefined, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      config.tier = tier
      config.hookMode = hookMode
    }),
    () => body,
    () =>
      Effect.sync(() => {
        config.tier = undefined
        config.hookMode = undefined
      }),
  )

const node: ChildOwner = { kind: "dag_node", workflowID: "dag_guard_mode", nodeID: "n01", attempt: 0 }
const task: ChildOwner = { kind: "task", toolCallID: "call_guard_mode" }

// A tier that is not set is the default one: `allow`.
const unattendedModes: ReadonlyArray<readonly [Tier | undefined, string | undefined, string | undefined]> = [
  [undefined, undefined, "dontAsk"],
  ["allow", undefined, "dontAsk"],
  // The configured hook mode is overridden: the tier decides what the session does.
  ["allow", "acceptEdits", "dontAsk"],
  ["allow", "bypassPermissions", "dontAsk"],
  ["readonly", undefined, "plan"],
  ["readonly", "acceptEdits", "plan"],
  ["readonly", "bypassPermissions", "plan"],
  // The ask tier states nothing: the mode the session had stays.
  ["ask", undefined, "default"],
  ["ask", "acceptEdits", "acceptEdits"],
]

describe("permission_mode of the tool hooks in an unattended session", () => {
  for (const [tier, hookMode, expected] of unattendedModes) {
    const label = `tier ${tier ?? "(unset)"}, hookPermissions.mode ${hookMode ?? "(unset)"}`

    it.instance(
      `a DAG node, ${label}: ${expected}`,
      () =>
        Effect.gen(function* () {
          const sessionID = SessionID.make("ses_guard_mode_node")
          yield* register(sessionID, node, { ask: "auto" })
          const modes = yield* withConfig(tier, hookMode, toolHookModes(sessionID))
          expect(modes).toEqual([expected, expected])
        }),
      { git: true },
    )

    it.instance(
      `a task child under a DAG-on root, ${label}: ${expected}`,
      () =>
        Effect.gen(function* () {
          yield* seedRoot("on")
          const sessionID = SessionID.make("ses_guard_mode_task_on")
          yield* register(sessionID, task, { ask: "root-dag-mode" })
          const modes = yield* withConfig(tier, hookMode, toolHookModes(sessionID))
          expect(modes).toEqual([expected, expected])
        }),
      { git: true },
    )
  }

  // Not unattended: the tier does not touch the mode, whatever it is.
  for (const tier of ["allow", "ask", "readonly"] as const) {
    for (const [hookMode, expected] of [
      [undefined, "default"],
      ["acceptEdits", "acceptEdits"],
    ] as const) {
      const label = `tier ${tier}, hookPermissions.mode ${hookMode ?? "(unset)"}`

      it.instance(
        `a root session, ${label}: ${expected}, as before`,
        () =>
          Effect.gen(function* () {
            const modes = yield* withConfig(
              tier,
              hookMode,
              toolHookModes(SessionID.make("ses_guard_mode_root_session"), { root: true }),
            )
            expect(modes).toEqual([expected, expected])
          }),
        { git: true },
      )

      it.instance(
        `a task child while DAG mode is off, ${label}: ${expected}, as before`,
        () =>
          Effect.gen(function* () {
            yield* seedRoot("off")
            const sessionID = SessionID.make("ses_guard_mode_task_off")
            yield* register(sessionID, task, { ask: "root-dag-mode" })
            const modes = yield* withConfig(tier, hookMode, toolHookModes(sessionID))
            expect(modes).toEqual([expected, expected])
          }),
        { git: true },
      )
    }
  }

  it.instance(
    "the tier is read at every hook event: a switch reaches a node that is already running",
    () =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("ses_guard_mode_switch")
        yield* register(sessionID, node, { ask: "auto" })
        const before = yield* withConfig("allow", "acceptEdits", toolHookModes(sessionID))
        const during = yield* withConfig("readonly", "acceptEdits", toolHookModes(sessionID))
        const after = yield* withConfig("ask", "acceptEdits", toolHookModes(sessionID))
        expect([before, during, after]).toEqual([
          ["dontAsk", "dontAsk"],
          ["plan", "plan"],
          ["acceptEdits", "acceptEdits"],
        ])
      }),
    { git: true },
  )
})
