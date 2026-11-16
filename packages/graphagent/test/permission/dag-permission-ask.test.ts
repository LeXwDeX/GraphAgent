// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "@/config/config"
import { AppLayer } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SettingsHook } from "@/hook"
import { Permission, type AskOptions } from "@/permission"
import { AskAdjudicator } from "@/permission/ask-adjudicator"
import { SafetyGuard } from "@/permission/safety-guard"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildOwner, ChildPermissionPolicy } from "@/session/child/types"
import { SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { pollWithTimeout, testEffect } from "../lib/effect"

/**
 * #1324 P1/P2: the `ask` tier of `dag.permission`. An unattended session (a DAG
 * node, or a task child of a root in DAG mode) normally never reaches the user:
 * the SafetyGuard settles every ask. Under the `ask` tier the edit key, the bash
 * key and MCP tools wait for the user instead. The user's own allow with a
 * concrete pattern and an "always" reply of the same session still settle a
 * call; a hook allow, `acceptEdits` and the safety list do not decide it.
 */

const directory = "/repo/project"
const rootSessionID = SessionID.make("ses_dag_ask_root")

/** The tier and the hook permission mode the fake global configuration reports; flipped between asks. */
const config: {
  tier: "allow" | "ask" | "readonly" | undefined
  hookMode: "dontAsk" | undefined
} = { tier: undefined, hookMode: undefined }

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const configLayer = TestConfig.layer({
  get: () => Effect.sync(() => (config.hookMode ? { hookPermissions: { mode: config.hookMode } } : {})),
  dagGlobal: () => Effect.sync(() => (config.tier ? { permission: config.tier } : {})),
})
const permissionLayer = Permission.layer.pipe(
  Layer.provide(database),
  Layer.provide(bridge),
  Layer.provide(SafetyGuard.layer),
  Layer.provide(configLayer),
)
const it = testEffect(Layer.mergeAll(permissionLayer, database, events, bridge))

/** Every case starts from the default tier, and a failing case cannot leak its tier into the next one. */
const withTier = <A, E, R>(tier: typeof config.tier, body: Effect.Effect<A, E, R>, hookMode?: typeof config.hookMode) =>
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

const makeRun = (
  label: string,
  options: { readonly owner?: ChildOwner; readonly permission?: ChildPermissionPolicy } = {},
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const childSessionID = SessionID.make(`ses_dag_ask_${label}`)
      const owner = options.owner ?? { kind: "dag_node" as const, workflowID: "dag_unused", nodeID: "n01", attempt: 0 }
      const entry = ChildRegistry.create({
        id: `crun_dag_ask_${label}`,
        childSessionID,
        parentSessionID: rootSessionID,
        ownerKind: owner.kind,
        ownerKey: owner,
        permission: options.permission ?? { ask: "auto" },
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)
      return { entry, childSessionID }
    }),
    ({ entry }) =>
      Effect.sync(() => {
        ChildRegistry.end(entry, { type: "completed" })
        ChildRegistry.release(entry)
      }),
  )

type Rules = Parameters<Permission.Interface["ask"]>[0]["ruleset"]

interface Extra {
  readonly metadata?: Record<string, unknown>
  readonly ruleset?: Rules
  readonly always?: readonly string[]
  readonly options?: AskOptions
  /** Leave the agent default out: no rule matches unless `ruleset` has one. */
  readonly bare?: boolean
}

/** The agent default every real session carries: `"*": "allow"`. It is not the user's own allow. */
const agentDefault = { permission: "*", pattern: "*", action: "allow" as const }

const ask = (
  sessionID: SessionID,
  input: Extra & { readonly permission: string; readonly patterns: readonly string[] },
) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(
      {
        sessionID,
        permission: input.permission,
        patterns: [...input.patterns],
        always: [...(input.always ?? [])],
        metadata: input.metadata ?? {},
        ruleset: [...(input.bare ? [] : [agentDefault]), ...(input.ruleset ?? [])],
      },
      input.options,
    )
  })

const call = (sessionID: SessionID, permission: string, pattern: string, extra: Extra = {}) =>
  ask(sessionID, { permission, patterns: [pattern], ...extra })
const bash = (sessionID: SessionID, command: string, extra: Extra = {}) =>
  call(sessionID, "bash", command, { metadata: { command }, always: [`${command.split(" ")[0]} *`], ...extra })
const edit = (sessionID: SessionID, pattern: string, extra: Extra = {}) =>
  call(sessionID, "edit", pattern, { always: ["*"], ...extra })
/** What `SessionTools` hands the permission service for an MCP server tool. */
const mcp = (sessionID: SessionID, tool: string, extra: Extra = {}) =>
  call(sessionID, tool, "*", { metadata: { source: "mcp" }, always: ["*"], ...extra })

const allow = (permission: string, pattern: string) => ({ permission, pattern, action: "allow" as const })
const deny = (permission: string, pattern: string) => ({ permission, pattern, action: "deny" as const })
const askRule = (permission: string, pattern: string) => ({ permission, pattern, action: "ask" as const })

/** Every `permission.asked` event the run publishes. */
const watchAsked = Effect.gen(function* () {
  const bridgeService = yield* EventV2Bridge.Service
  const asked: Array<{ sessionID: string; permission: string }> = []
  const stop = yield* bridgeService.listen((event) => {
    if (event.type === Permission.Event.Asked.type) {
      const { sessionID, permission } = Schema.decodeUnknownSync(PermissionV1.Request)(event.data)
      asked.push({ sessionID, permission })
    }
    return Effect.void
  })
  yield* Effect.addFinalizer(() => stop)
  return asked
})

/** Root session row the task policy reads at ask time. */
const setRootDagMode = (mode: "on" | "off") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_dag_ask"), worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: rootSessionID,
        project_id: Project.ID.make("prj_dag_ask"),
        slug: "dag-ask",
        directory: AbsolutePath.make(directory),
        title: "dag ask root",
        version: "0",
        dag_mode: mode,
      })
      .onConflictDoUpdate({ target: SessionTable.id, set: { dag_mode: mode } })
      .run()
      .pipe(Effect.orDie)
  })

/**
 * The call goes to the user: it is forked, shows up as the one pending request
 * and, once answered, finishes with the reply's outcome. A call that was settled
 * or denied on its own never shows up, which fails here instead of hanging.
 */
const waitsForUser = <A, E, R>(effect: Effect.Effect<A, E, R>, sessionID: SessionID, permissionKey: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* effect.pipe(Effect.forkScoped)
    const request = yield* pollWithTimeout(
      permission.list().pipe(Effect.map((list) => list.find((item) => item.sessionID === sessionID))),
      () => `no pending ${permissionKey} request for ${sessionID}`,
    )
    expect(request.permission).toBe(permissionKey)
    return {
      request,
      fiber,
      /** Answer the request and return how the call ended. */
      reply: (reply: "once" | "always" | "reject") =>
        Effect.gen(function* () {
          yield* permission.reply({ requestID: request.id, reply })
          return yield* Fiber.await(fiber)
        }),
    }
  })

/** The call settles on its own: no dialog, nothing pending. */
const settlesAlone = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const outcome = yield* effect.pipe(Effect.timeoutOption("2 seconds"))
    // None means the call kept waiting for somebody to answer it.
    expect(Option.isSome(outcome)).toBe(true)
    expect(yield* permission.list()).toEqual([])
  })

/** The call fails without ever asking; the error and the text of its cause come back. */
const failsWithout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const exit = yield* effect.pipe(Effect.timeoutOption("2 seconds"), Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* permission.list()).toEqual([])
    return Exit.isFailure(exit)
      ? { error: Cause.squash(exit.cause), text: String(exit.cause) }
      : { error: undefined, text: "" }
  })

it.instance(
  "ask tier: a DAG node's bash, edit and MCP calls each wait for the user, from the node's own session",
  () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const { childSessionID } = yield* makeRun("node-classes")

        for (const [key, calling] of [
          ["bash", bash(childSessionID, "echo hi")],
          ["edit", edit(childSessionID, "src/a.ts")],
          ["github_create_issue", mcp(childSessionID, "github_create_issue")],
        ] as const) {
          const pending = yield* waitsForUser(calling, childSessionID, key)
          expect(pending.request.sessionID).toBe(childSessionID)
          expect(Exit.isSuccess(yield* pending.reply("once"))).toBe(true)
        }

        expect(asked).toEqual([
          { sessionID: childSessionID, permission: "bash" },
          { sessionID: childSessionID, permission: "edit" },
          { sessionID: childSessionID, permission: "github_create_issue" },
        ])
      }),
    ),
  { git: true },
)

it.instance(
  "ask tier: read, grep, glob and the other keys stay silent; an outside read keeps its external_directory ask",
  () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const { childSessionID } = yield* makeRun("node-silent")
        yield* settlesAlone(call(childSessionID, "read", "src/a.ts"))
        yield* settlesAlone(call(childSessionID, "grep", "TODO", { metadata: { pattern: "TODO", path: "src" } }))
        yield* settlesAlone(call(childSessionID, "glob", "*.ts", { metadata: { pattern: "*.ts", path: "src" } }))
        yield* settlesAlone(call(childSessionID, "webfetch", "https://example.test/"))
        // A tool whose key is not one of the three classes, MCP or not by name alone.
        yield* settlesAlone(call(childSessionID, "agent", "*"))
        yield* settlesAlone(call(childSessionID, "github_create_issue", "*"))
        expect(asked).toEqual([])

        // `external_directory` was an ask before the tier existed, and it still goes to the user.
        const outside = yield* waitsForUser(
          ask(childSessionID, {
            permission: "external_directory",
            patterns: ["/opt/other/*"],
            always: ["/opt/other/*"],
            metadata: { filepath: "/opt/other/file.txt", parentDir: "/opt/other" },
            ruleset: [{ permission: "external_directory", pattern: "*", action: "ask" }],
          }),
          childSessionID,
          "external_directory",
        )
        yield* outside.reply("reject")
      }),
    ),
  { git: true },
)

it.instance(
  "ask tier: only the user's own allow with a concrete pattern frees a call; a whole-key allow does not",
  () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const { childSessionID } = yield* makeRun("node-explicit")

        // `bash: {"bun test*": "allow"}` frees what it covers and nothing else.
        yield* settlesAlone(bash(childSessionID, "bun test --bail", { ruleset: [allow("bash", "bun test*")] }))
        const other = yield* waitsForUser(
          bash(childSessionID, "bun build", { ruleset: [allow("bash", "bun test*")] }),
          childSessionID,
          "bash",
        )
        yield* other.reply("once")

        // `bash: "allow"` is a whole-key allow: still asks.
        const whole = yield* waitsForUser(
          bash(childSessionID, "bun test --bail", { ruleset: [allow("bash", "*")] }),
          childSessionID,
          "bash",
        )
        yield* whole.reply("once")
        // So is a key wildcard.
        const wildcard = yield* waitsForUser(
          bash(childSessionID, "bun test --bail", { ruleset: [allow("*", "bun test*")] }),
          childSessionID,
          "bash",
        )
        yield* wildcard.reply("once")

        // The same goes for edit.
        yield* settlesAlone(edit(childSessionID, "src/a.ts", { ruleset: [allow("edit", "src/*")] }))
        const edits = yield* waitsForUser(
          edit(childSessionID, "docs/a.md", { ruleset: [allow("edit", "src/*")] }),
          childSessionID,
          "edit",
        )
        yield* edits.reply("once")

        // A role or default allow is not the user's, even with a concrete pattern.
        const defaults = yield* waitsForUser(
          bash(childSessionID, "bun test --bail", {
            options: {
              resolveRuleset: () =>
                Effect.succeed({ native: [], rules: [allow("bash", "bun test*")], userRuleIndices: [] }),
            },
          }),
          childSessionID,
          "bash",
        )
        yield* defaults.reply("once")
        yield* settlesAlone(
          bash(childSessionID, "bun test --bail", {
            options: {
              resolveRuleset: () =>
                Effect.succeed({ native: [], rules: [allow("bash", "bun test*")], userRuleIndices: [0] }),
            },
          }),
        )

        expect(asked.map((entry) => entry.permission)).toEqual(["bash", "bash", "bash", "edit", "bash"])
      }),
    ),
  { git: true },
)

it.instance(
  "ask tier: an allow the user wrote for exactly one MCP tool frees that tool; a server wildcard or a whole-key allow does not",
  () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const { childSessionID } = yield* makeRun("node-mcp-allow")
        const tool = "github_create_issue"

        // An MCP request has no concrete pattern (it is always `*`), so what the user can name is the tool itself.
        yield* settlesAlone(mcp(childSessionID, tool, { ruleset: [allow(tool, "*")] }))

        // Another tool's allow, a server-wide wildcard, a whole-key allow and a `?` wildcard
        // all name more (or other) than this tool: the question stays.
        for (const rules of [
          [allow("github_list_issues", "*")],
          [allow("github_*", "*")],
          [allow("*", "*")],
          [allow("github_create_?ssue", "*")],
        ]) {
          const pending = yield* waitsForUser(mcp(childSessionID, tool, { ruleset: rules }), childSessionID, tool)
          yield* pending.reply("once")
        }

        // A later ask rule for the same tool decides: the user asked to be asked.
        const asking = yield* waitsForUser(
          mcp(childSessionID, tool, { ruleset: [allow(tool, "*"), { permission: tool, pattern: "*", action: "ask" }] }),
          childSessionID,
          tool,
        )
        yield* asking.reply("once")

        // A deny rule still denies without a question.
        const refused = yield* failsWithout(mcp(childSessionID, tool, { ruleset: [allow(tool, "*"), deny(tool, "*")] }))
        expect(refused.error).toBeInstanceOf(PermissionV1.DeniedError)

        // The allow has to be the user's own: a role or default rule with the same key does not count.
        const defaults = yield* waitsForUser(
          mcp(childSessionID, tool, {
            options: {
              resolveRuleset: () => Effect.succeed({ native: [], rules: [allow(tool, "*")], userRuleIndices: [] }),
            },
          }),
          childSessionID,
          tool,
        )
        yield* defaults.reply("once")
        yield* settlesAlone(
          mcp(childSessionID, tool, {
            options: {
              resolveRuleset: () => Effect.succeed({ native: [], rules: [allow(tool, "*")], userRuleIndices: [0] }),
            },
          }),
        )

        // The exemption is only for MCP tools: a whole-key allow on the bash key still does not free a command.
        const command = yield* waitsForUser(
          bash(childSessionID, "echo hi", { ruleset: [allow("bash", "*")] }),
          childSessionID,
          "bash",
        )
        yield* command.reply("once")

        expect(asked.map((entry) => entry.permission)).toEqual([tool, tool, tool, tool, tool, tool, "bash"])
      }),
    ),
  { git: true },
)

it.instance(
  "ask tier: an always reply for an MCP tool frees it in the same session only",
  () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const first = yield* makeRun("node-mcp-always-a")
        const second = yield* makeRun("node-mcp-always-b")
        const tool = "github_create_issue"

        const pending = yield* waitsForUser(mcp(first.childSessionID, tool), first.childSessionID, tool)
        expect(Exit.isSuccess(yield* pending.reply("always"))).toBe(true)
        yield* settlesAlone(mcp(first.childSessionID, tool))
        const elsewhere = yield* waitsForUser(mcp(second.childSessionID, tool), second.childSessionID, tool)
        yield* elsewhere.reply("once")
      }),
    ),
  { git: true },
)

it.instance(
  "ask tier: a deny rule still denies without asking",
  () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const { childSessionID } = yield* makeRun("node-deny")
        const denied = yield* failsWithout(bash(childSessionID, "rm -rf build", { ruleset: [deny("bash", "rm *")] }))
        expect(denied.error).toBeInstanceOf(PermissionV1.DeniedError)
        yield* failsWithout(edit(childSessionID, "secrets.txt", { ruleset: [deny("edit", "secrets.txt")] }))
        // A deny wins over a reply of "always" given before it existed.
        const first = yield* waitsForUser(bash(childSessionID, "rm a", { always: ["rm *"] }), childSessionID, "bash")
        yield* first.reply("always")
        yield* failsWithout(bash(childSessionID, "rm b", { ruleset: [deny("bash", "rm *")], always: ["rm *"] }))
        yield* Effect.yieldNow
        expect(asked).toHaveLength(1)
      }),
    ),
  { git: true },
)

it.instance(
  "ask tier: an always reply frees the same pattern in the same session only",
  () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const first = yield* makeRun("node-always-a")
        const second = yield* makeRun("node-always-b")

        const pending = yield* waitsForUser(bash(first.childSessionID, "bun test a"), first.childSessionID, "bash")
        expect(Exit.isSuccess(yield* pending.reply("always"))).toBe(true)

        // Same session, same pattern (`bun *`): settled without a dialog.
        yield* settlesAlone(bash(first.childSessionID, "bun test b"))
        // Another pattern still asks.
        const other = yield* waitsForUser(bash(first.childSessionID, "rm x"), first.childSessionID, "bash")
        yield* other.reply("once")
        // Another node's session keeps asking.
        const elsewhere = yield* waitsForUser(bash(second.childSessionID, "bun test c"), second.childSessionID, "bash")
        yield* elsewhere.reply("once")

        expect(asked).toHaveLength(3)
      }),
    ),
  { git: true },
)

it.instance(
  "ask tier: a hook allow and acceptEdits cannot skip the question; dontAsk refuses without asking",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const permission = yield* Permission.Service
      const { childSessionID } = yield* makeRun("node-hooks")

      // A PreToolUse hook that answered `allow` (`hookAllowed`).
      yield* withTier(
        "ask",
        Effect.gen(function* () {
          const bashAllowed = yield* waitsForUser(
            bash(childSessionID, "echo hi", { options: { hookAllowed: true } }),
            childSessionID,
            "bash",
          )
          yield* bashAllowed.reply("once")
          const editAllowed = yield* waitsForUser(
            edit(childSessionID, "src/a.ts", { options: { hookAllowed: true } }),
            childSessionID,
            "edit",
          )
          yield* editAllowed.reply("once")

          // The session policy `acceptEdits` accepted edits before; it no longer does.
          yield* permission.applyHookUpdates(childSessionID, [
            { type: "setMode", mode: "acceptEdits", destination: "session" },
          ])
          const accepted = yield* waitsForUser(edit(childSessionID, "src/b.ts"), childSessionID, "edit")
          yield* accepted.reply("once")
          const acceptedBash = yield* waitsForUser(bash(childSessionID, "echo ok"), childSessionID, "bash")
          yield* acceptedBash.reply("once")
          // Forget the session policy, so the configured mode below is the one in force.
          yield* permission.clearHookPolicy(childSessionID)
        }),
      )
      expect(asked).toHaveLength(4)

      // `hookPermissions.mode: dontAsk` refuses what would have been asked.
      yield* withTier(
        "ask",
        Effect.gen(function* () {
          const bashRefused = yield* failsWithout(bash(childSessionID, "echo refused"))
          expect(bashRefused.error).toBeInstanceOf(PermissionV1.RejectedError)
          const editRefused = yield* failsWithout(edit(childSessionID, "src/c.ts"))
          expect(editRefused.error).toBeInstanceOf(PermissionV1.RejectedError)
        }),
        "dontAsk",
      )
      yield* Effect.yieldNow
      expect(asked).toHaveLength(4)
    }),
  { git: true },
)

it.instance(
  "ask tier: a rule that asks is held like any unsettled call; a hook allow and acceptEdits cannot skip it",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const permission = yield* Permission.Service
      const { childSessionID } = yield* makeRun("node-ask-rule")
      const tool = "github_create_issue"

      yield* withTier(
        "ask",
        Effect.gen(function* () {
          // `"*": "ask"` is no explicit ask (permission `*` covers every key), and neither is the
          // question left when no rule matches at all: under the ask tier both are the user's to answer.
          for (const extra of [{ ruleset: [askRule("*", "*")] }, { bare: true }]) {
            for (const [key, calling] of [
              ["bash", bash(childSessionID, "echo hi", { ...extra, options: { hookAllowed: true } })],
              ["edit", edit(childSessionID, "src/a.ts", { ...extra, options: { hookAllowed: true } })],
              [tool, mcp(childSessionID, tool, { ...extra, options: { hookAllowed: true } })],
            ] as const) {
              const pending = yield* waitsForUser(calling, childSessionID, key)
              yield* pending.reply("once")
            }
          }

          // The session policy `acceptEdits` accepts edits only where nobody asks: here somebody does.
          yield* permission.applyHookUpdates(childSessionID, [
            { type: "setMode", mode: "acceptEdits", destination: "session" },
          ])
          const accepted = yield* waitsForUser(
            edit(childSessionID, "src/b.ts", { ruleset: [askRule("*", "*")] }),
            childSessionID,
            "edit",
          )
          yield* accepted.reply("once")
          const acceptedBare = yield* waitsForUser(
            edit(childSessionID, "src/c.ts", { bare: true }),
            childSessionID,
            "edit",
          )
          yield* acceptedBare.reply("once")
          yield* permission.clearHookPolicy(childSessionID)
        }),
      )
      expect(asked).toHaveLength(8)

      // `hookPermissions.mode: dontAsk` still refuses what would have been asked.
      yield* withTier(
        "ask",
        Effect.gen(function* () {
          const refused = yield* failsWithout(bash(childSessionID, "echo refused", { ruleset: [askRule("*", "*")] }))
          expect(refused.error).toBeInstanceOf(PermissionV1.RejectedError)
        }),
        "dontAsk",
      )
      expect(asked).toHaveLength(8)
    }),
  { git: true },
)

it.instance(
  "ask tier: an explicit allow after a rule that asks, and an always reply, still settle the call",
  () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const first = yield* makeRun("node-ask-rule-allow-a")
        const second = yield* makeRun("node-ask-rule-allow-b")

        // The user's own allow, written after the general question, decides: `evaluate` takes the last match.
        yield* settlesAlone(
          bash(first.childSessionID, "bun test --bail", { ruleset: [askRule("*", "*"), allow("bash", "bun test*")] }),
        )
        // Written before it, the allow is overridden and the question stays.
        const overridden = yield* waitsForUser(
          bash(first.childSessionID, "bun test --bail", { ruleset: [allow("bash", "bun test*"), askRule("*", "*")] }),
          first.childSessionID,
          "bash",
        )
        yield* overridden.reply("once")

        // An "always" reply settles the pattern for this session even under `"*": "ask"`; another session still asks.
        const rules = { ruleset: [askRule("*", "*")] }
        const pending = yield* waitsForUser(
          bash(first.childSessionID, "bun test a", rules),
          first.childSessionID,
          "bash",
        )
        expect(Exit.isSuccess(yield* pending.reply("always"))).toBe(true)
        yield* settlesAlone(bash(first.childSessionID, "bun test b", rules))
        const elsewhere = yield* waitsForUser(
          bash(second.childSessionID, "bun test c", rules),
          second.childSessionID,
          "bash",
        )
        yield* elsewhere.reply("once")

        // A deny rule after the question still denies without asking.
        yield* failsWithout(bash(first.childSessionID, "rm x", { ruleset: [askRule("*", "*"), deny("bash", "rm *")] }))
        expect(asked).toHaveLength(3)
      }),
    ),
  { git: true },
)

it.instance(
  "the default tier leaves a rule that asks alone: an unattended node is settled, an attended session keeps its hook allow",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("node-ask-rule-default")
      const attended = SessionID.make("ses_dag_ask_attended_rule")

      // The adjudicator settles a node's configured question without bothering the user.
      yield* withTier(undefined, settlesAlone(bash(childSessionID, "echo hi", { ruleset: [askRule("*", "*")] })))
      // Under the ask tier an attended session is untouched: a hook allow skips a general question, as it always did.
      yield* withTier(
        "ask",
        Effect.gen(function* () {
          yield* settlesAlone(
            bash(attended, "echo hi", { ruleset: [askRule("*", "*")], options: { hookAllowed: true } }),
          )
          yield* settlesAlone(edit(attended, "src/a.ts", { bare: true, options: { hookAllowed: true } }))
        }),
      )
      expect(asked).toEqual([])
    }),
  { git: true },
)

it.instance(
  "ask tier: the user's rejection ends the call with a rejection and settles nothing else",
  () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const { childSessionID } = yield* makeRun("node-reject")
        const pending = yield* waitsForUser(bash(childSessionID, "make deploy"), childSessionID, "bash")
        const exit = yield* pending.reply("reject")
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
        // Nothing was remembered: the next call asks again.
        const again = yield* waitsForUser(bash(childSessionID, "make deploy"), childSessionID, "bash")
        yield* again.reply("once")
      }),
    ),
  { git: true },
)

it.instance(
  "ask tier: a task child of a root in DAG mode asks the same way; with DAG mode off it behaves as before",
  () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        yield* setRootDagMode("on")
        const on = yield* makeRun("task-on", {
          owner: { kind: "task", toolCallID: "call_on" },
          permission: { ask: "root-dag-mode" },
        })
        const bashPending = yield* waitsForUser(bash(on.childSessionID, "echo hi"), on.childSessionID, "bash")
        yield* bashPending.reply("once")
        const editPending = yield* waitsForUser(edit(on.childSessionID, "src/a.ts"), on.childSessionID, "edit")
        yield* editPending.reply("once")
        const mcpPending = yield* waitsForUser(mcp(on.childSessionID, "srv_tool"), on.childSessionID, "srv_tool")
        yield* mcpPending.reply("once")
        yield* settlesAlone(call(on.childSessionID, "read", "src/a.ts"))
        expect(asked).toHaveLength(3)

        // DAG mode off: an ordinary child. Its allowed calls run unasked, whatever the tier says,
        // and a rule that asks still reaches the user.
        yield* setRootDagMode("off")
        const off = yield* makeRun("task-off", {
          owner: { kind: "task", toolCallID: "call_off" },
          permission: { ask: "root-dag-mode" },
        })
        yield* settlesAlone(bash(off.childSessionID, "echo hi", { ruleset: [allow("bash", "*")] }))
        yield* settlesAlone(edit(off.childSessionID, "src/a.ts", { ruleset: [allow("edit", "*")] }))
        yield* settlesAlone(mcp(off.childSessionID, "srv_tool", { ruleset: [allow("srv_tool", "*")] }))
        const configured = yield* waitsForUser(
          bash(off.childSessionID, "make deploy", {
            ruleset: [{ permission: "bash", pattern: "make *", action: "ask" }],
          }),
          off.childSessionID,
          "bash",
        )
        yield* configured.reply("once")
        expect(asked).toHaveLength(4)
      }),
    ),
  { git: true },
)

it.instance(
  "ask tier: the safety list does not decide; a destructive command and a hook ask go to the user",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("node-list")

      // Under the default tier the list denies `git reset --hard` (SF-3) and a hook ask (SF-6).
      yield* withTier(
        undefined,
        Effect.gen(function* () {
          const reset = yield* failsWithout(bash(childSessionID, "git reset --hard"))
          expect(reset.text).toContain("dag_safety:SF-3")
          const forced = yield* failsWithout(
            call(childSessionID, "bash", "bash", { metadata: { hookAsk: true }, options: { force: true } }),
          )
          expect(forced.text).toContain("dag_safety:SF-6")
        }),
      )
      expect(asked).toEqual([])

      yield* withTier(
        "ask",
        Effect.gen(function* () {
          const reset = yield* waitsForUser(bash(childSessionID, "git reset --hard"), childSessionID, "bash")
          yield* reset.reply("once")
          const hookAsk = yield* waitsForUser(
            call(childSessionID, "bash", "bash", { metadata: { hookAsk: true }, options: { force: true } }),
            childSessionID,
            "bash",
          )
          yield* hookAsk.reply("once")
        }),
      )
      expect(asked).toHaveLength(2)
    }),
  { git: true },
)

it.instance(
  "the tier is read at every ask: a switch reaches the node's next call and back",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("node-switch")

      yield* withTier(
        "allow",
        Effect.gen(function* () {
          yield* settlesAlone(bash(childSessionID, "echo one"))
          // allow -> ask: the very next call asks.
          config.tier = "ask"
          const pending = yield* waitsForUser(bash(childSessionID, "echo two"), childSessionID, "bash")
          yield* pending.reply("once")
          // ask -> allow: the next call is settled again.
          config.tier = "allow"
          yield* settlesAlone(bash(childSessionID, "echo three"))
          // An absent key is the default tier.
          config.tier = undefined
          yield* settlesAlone(bash(childSessionID, "echo four"))
        }),
      )
      expect(asked).toHaveLength(1)
    }),
  { git: true },
)

it.instance(
  "the tier touches unattended sessions only: a root session and an attended child keep their rules",
  () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        // A session that was never a child run: allowed calls run unasked.
        const standalone = SessionID.make("ses_dag_ask_standalone")
        yield* settlesAlone(bash(standalone, "echo hi", { ruleset: [allow("bash", "*")] }))
        yield* settlesAlone(edit(standalone, "src/a.ts", { ruleset: [allow("edit", "*")] }))
        // A child run that asks its user keeps the ordinary rules as well.
        const attended = yield* makeRun("child-user", { permission: { ask: "user" } })
        yield* settlesAlone(bash(attended.childSessionID, "echo hi", { ruleset: [allow("bash", "*")] }))
        expect(asked).toEqual([])
      }),
    ),
  { git: true },
)

/**
 * The default tier is untouched by the ask tier's MCP rule: the adjudicator is
 * still told `explicit` by the original test (a concrete pattern on the key), so
 * an allow for exactly one MCP tool is not explicit there.
 */
const adjudicated: Array<{ permission: string; rule: AskAdjudicator.AskRule }> = []
const recorder = Layer.succeed(
  AskAdjudicator.Service,
  AskAdjudicator.Service.of({
    decide: (input) =>
      Effect.sync(() => {
        adjudicated.push({ permission: input.request.permission, rule: input.rule })
        return "allow" as const
      }),
  }),
)
const recordingIt = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(
      Layer.provide(database),
      Layer.provide(bridge),
      Layer.provide(recorder),
      Layer.provide(configLayer),
    ),
    database,
    events,
    bridge,
  ),
)

recordingIt.instance(
  "the default tier still tells the adjudicator that an allow for one MCP tool is not explicit (#1324)",
  () =>
    Effect.gen(function* () {
      adjudicated.length = 0
      const { childSessionID } = yield* makeRun("node-recorded")
      yield* withTier(
        undefined,
        Effect.gen(function* () {
          yield* settlesAlone(
            mcp(childSessionID, "github_create_issue", { ruleset: [allow("github_create_issue", "*")] }),
          )
          yield* settlesAlone(bash(childSessionID, "bun test --bail", { ruleset: [allow("bash", "bun test*")] }))
          yield* settlesAlone(bash(childSessionID, "echo hi", { ruleset: [allow("bash", "*")] }))
        }),
      )
      expect(adjudicated).toEqual([
        { permission: "github_create_issue", rule: { action: "allow", explicit: false } },
        { permission: "bash", rule: { action: "allow", explicit: true } },
        { permission: "bash", rule: { action: "allow", explicit: false } },
      ])
    }),
  { git: true },
)

/**
 * A PermissionRequest hook is the other way an automation answers "allow". Like a
 * PreToolUse allow it may settle a general question, but not one the ask tier
 * holds for the user.
 */
const hookAnswer: { current: "allow" | undefined } = { current: undefined }
const allowingHook = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload) =>
      Effect.sync(() => ({
        additionalContexts: [],
        systemMessages: [],
        ...(payload.event === "PermissionRequest" && hookAnswer.current
          ? { permissionRequestDecision: { behavior: hookAnswer.current } }
          : {}),
      })),
    list: () => Effect.succeed([]),
  }),
)
const hookedIt = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(
      Layer.provide(database),
      Layer.provide(bridge),
      Layer.provide(SafetyGuard.layer),
      Layer.provide(configLayer),
      Layer.provide(allowingHook),
    ),
    database,
    events,
    bridge,
  ),
)

hookedIt.instance(
  "ask tier: a PermissionRequest hook that allows cannot skip a question the tier holds",
  () =>
    Effect.gen(function* () {
      hookAnswer.current = "allow"
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("node-hook-allow")

      yield* withTier(
        "ask",
        Effect.gen(function* () {
          // An allow nobody wrote for the call, a general question and no rule at all: all the user's to answer.
          for (const extra of [{}, { ruleset: [askRule("*", "*")] }, { bare: true }]) {
            const pending = yield* waitsForUser(bash(childSessionID, "echo hi", extra), childSessionID, "bash")
            yield* pending.reply("once")
          }
        }),
      )
      expect(asked).toHaveLength(3)

      // The same hook still answers an attended session's general question, as it always did.
      yield* withTier(
        "ask",
        settlesAlone(bash(SessionID.make("ses_dag_ask_attended_hook"), "echo hi", { ruleset: [askRule("*", "*")] })),
      )
      expect(asked).toHaveLength(3)
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          hookAnswer.current = undefined
        }),
      ),
    ),
  { git: true },
)

/**
 * Runtime configuration goes through the whole assembly: `Permission` is given
 * its own `Config`, so the tier has to arrive through the global configuration
 * the user edits (the file, not a test double), and a write has to reach a node
 * that is already running.
 */
const appIt = testEffect(AppLayer)

appIt.instance(
  "the full app assembly reads dag.permission from the global configuration at every ask",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dag-permission-ask-"))),
        (created) => Effect.promise(() => fs.rm(created, { recursive: true, force: true })),
      )
      // The global configuration directory the app reads, as a test redirects it.
      const write = (dag: object) =>
        Effect.promise(() => fs.writeFile(path.join(dir, "graphagent.json"), JSON.stringify({ dag }))).pipe(
          Effect.andThen(Config.use.invalidate().pipe(Effect.orDie)),
        )
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.env.GRAPHAGENT_TEST_CONFIG_DIR
          process.env.GRAPHAGENT_TEST_CONFIG_DIR = dir
          return previous
        }),
        () =>
          Effect.gen(function* () {
            const asked = yield* watchAsked
            const { childSessionID } = yield* makeRun("app-tier")

            // No key and `allow` settle a node's calls without a question.
            yield* write({})
            yield* settlesAlone(bash(childSessionID, "echo one"))
            yield* write({ permission: "allow" })
            yield* settlesAlone(bash(childSessionID, "echo two"))

            // The user writes `ask`: the node's very next call waits for them.
            yield* write({ permission: "ask" })
            const pending = yield* waitsForUser(bash(childSessionID, "echo three"), childSessionID, "bash")
            yield* pending.reply("once")

            // And back: the next call is settled by itself again.
            yield* write({ permission: "allow" })
            yield* settlesAlone(bash(childSessionID, "echo four"))
            expect(asked).toEqual([{ sessionID: childSessionID, permission: "bash" }])
          }),
        (previous) =>
          Effect.gen(function* () {
            if (previous === undefined) delete process.env.GRAPHAGENT_TEST_CONFIG_DIR
            else process.env.GRAPHAGENT_TEST_CONFIG_DIR = previous
            yield* Config.use.invalidate().pipe(Effect.orDie)
          }),
      )
    }),
  { git: true },
)
