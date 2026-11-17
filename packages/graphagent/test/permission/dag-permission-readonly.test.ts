// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { expect } from "bun:test"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "@/config/config"
import { AppLayer } from "@/effect/app-runtime"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission, type AskOptions } from "@/permission"
import { SafetyGuard } from "@/permission/safety-guard"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildOwner, ChildPermissionPolicy } from "@/session/child/types"
import { SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { transactLayer } from "../dag/fixture/transact"

/**
 * #1324 P3: the `readonly` tier of `dag.permission`. An unattended session (a
 * DAG node, or a task child of a root in DAG mode) never asks under this tier:
 * the edit key is always denied, bash is limited to the review persona's own
 * allowlist, and an MCP tool is denied unless the user named exactly that
 * tool. Nothing settled by the rules above (RO-1) and the existing safety list
 * ever reaches the user; read, grep, glob and the `agent` tool are unaffected.
 */

const directory = "/repo/project"
const rootSessionID = SessionID.make("ses_dag_readonly_root")

/** The tier the fake global configuration reports; flipped between asks. */
const config: { tier: "allow" | "ask" | "readonly" | undefined } = { tier: undefined }

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = DagStore.layer.pipe(Layer.provide(database))
const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(transactLayer(database)))
const configLayer = TestConfig.layer({
  dagGlobal: () => Effect.sync(() => (config.tier ? { permission: config.tier } : {})),
})
const permissionLayer = Permission.layer.pipe(
  Layer.provide(database),
  Layer.provide(bridge),
  Layer.provide(SafetyGuard.layer),
  Layer.provide(configLayer),
)
const it = testEffect(Layer.mergeAll(permissionLayer, database, events, bridge, projector, store, dag))

/** Every case starts from the default tier, and a failing case cannot leak its tier into the next one. */
const withTier = <A, E, R>(tier: typeof config.tier, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      config.tier = tier
    }),
    () => body,
    () =>
      Effect.sync(() => {
        config.tier = undefined
      }),
  )

const makeRun = (
  label: string,
  options: { readonly owner?: ChildOwner; readonly permission?: ChildPermissionPolicy } = {},
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const childSessionID = SessionID.make(`ses_dag_readonly_${label}`)
      const owner = options.owner ?? { kind: "dag_node" as const, workflowID: "dag_unused", nodeID: "n01", attempt: 0 }
      const entry = ChildRegistry.create({
        id: `crun_dag_readonly_${label}`,
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
  readonly options?: AskOptions
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
        always: [],
        metadata: input.metadata ?? {},
        ruleset: [agentDefault, ...(input.ruleset ?? [])],
      },
      input.options,
    )
  })

const call = (sessionID: SessionID, permission: string, pattern: string, extra: Extra = {}) =>
  ask(sessionID, { permission, patterns: [pattern], ...extra })
const bash = (sessionID: SessionID, command: string, extra: Extra = {}) =>
  call(sessionID, "bash", command, { metadata: { command }, ...extra })
const edit = (sessionID: SessionID, pattern: string, extra: Extra = {}) => call(sessionID, "edit", pattern, extra)
/** What `SessionTools` hands the permission service for an MCP server tool. */
const mcp = (sessionID: SessionID, tool: string, extra: Extra = {}) =>
  call(sessionID, tool, "*", { metadata: { source: "mcp" }, ...extra })

const allow = (permission: string, pattern: string) => ({ permission, pattern, action: "allow" as const })
const deny = (permission: string, pattern: string) => ({ permission, pattern, action: "deny" as const })

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
      .values({ id: Project.ID.make("prj_dag_readonly"), worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: rootSessionID,
        project_id: Project.ID.make("prj_dag_readonly"),
        slug: "dag-readonly",
        directory: AbsolutePath.make(directory),
        title: "dag readonly root",
        version: "0",
        dag_mode: mode,
      })
      .onConflictDoUpdate({ target: SessionTable.id, set: { dag_mode: mode } })
      .run()
      .pipe(Effect.orDie)
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
    return Exit.isFailure(exit) ? { text: String(exit.cause) } : { text: "" }
  })

it.instance(
  "readonly tier: bash is limited to the review allowlist, and a user's explicit allow does not widen it",
  () =>
    withTier(
      "readonly",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const { childSessionID } = yield* makeRun("bash-allowlist")

        yield* settlesAlone(bash(childSessionID, "git diff --cached"))
        yield* settlesAlone(bash(childSessionID, "git log --oneline -5"))
        yield* settlesAlone(bash(childSessionID, "gh pr diff 42"))

        const denied = yield* failsWithout(bash(childSessionID, "npm test"))
        expect(denied.text).not.toContain("dag_safety:")
        yield* failsWithout(bash(childSessionID, "rm x"))
        yield* failsWithout(bash(childSessionID, "git commit -m x"))

        // Neither a whole-key allow nor a concrete allow lifts it: readonly is readonly.
        yield* failsWithout(bash(childSessionID, "npm test", { ruleset: [allow("bash", "*")] }))
        yield* failsWithout(bash(childSessionID, "npm test", { ruleset: [allow("bash", "npm test*")] }))

        // `--output` still overrides the allowlist, as it does for the review agent.
        yield* failsWithout(bash(childSessionID, "git diff --output=marker"))

        expect(asked).toEqual([])
      }),
    ),
  { git: true },
)

it.instance(
  "readonly tier: edit is always denied, even with a concrete user allow",
  () =>
    withTier(
      "readonly",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const { childSessionID } = yield* makeRun("edit-denied")
        yield* failsWithout(edit(childSessionID, "src/a.ts"))
        yield* failsWithout(edit(childSessionID, "src/a.ts", { ruleset: [allow("edit", "src/*")] }))
        expect(asked).toEqual([])
      }),
    ),
  { git: true },
)

it.instance(
  "readonly tier: an MCP tool is denied unless the user named exactly that tool",
  () =>
    withTier(
      "readonly",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const { childSessionID } = yield* makeRun("mcp-denied")
        const tool = "github_create_issue"

        yield* failsWithout(mcp(childSessionID, tool))
        // A whole-key allow or a server-wide wildcard still does not name this tool.
        yield* failsWithout(mcp(childSessionID, tool, { ruleset: [allow("*", "*")] }))
        yield* failsWithout(mcp(childSessionID, tool, { ruleset: [allow("github_*", "*")] }))
        // An allow for exactly this tool frees it.
        yield* settlesAlone(mcp(childSessionID, tool, { ruleset: [allow(tool, "*")] }))
        // Another tool's allow still does not name this one.
        yield* failsWithout(mcp(childSessionID, "github_list_issues", { ruleset: [allow(tool, "*")] }))

        expect(asked).toEqual([])
      }),
    ),
  { git: true },
)

/**
 * Codex #1334 P1: `readonlyOverride` must only narrow what the agent's own and
 * the user's configured rules already allow, never stand in for them. A user's
 * own `deny` — on a bash pattern the review allowlist would otherwise let
 * through, on edit, or on a named MCP tool — has to keep winning, with the
 * ordinary (non-readonly) denial wording, exactly as it does outside this tier.
 */
it.instance(
  "readonly tier: a user's own deny always wins over the tool-face override, never with the readonly wording",
  () =>
    withTier(
      "readonly",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const { childSessionID } = yield* makeRun("deny-wins")
        const tool = "github_create_issue"

        // The review allowlist would otherwise allow "git diff"; the user's own
        // deny on that exact pattern still wins, and the reason is not readonly's.
        const bashDenied = yield* failsWithout(
          bash(childSessionID, "git diff --cached", { ruleset: [deny("bash", "git diff*")] }),
        )
        expect(bashDenied.text).not.toContain('dag.permission is "readonly"')

        // edit and a named MCP tool deny the same way: still denied, but not by the override.
        const editDenied = yield* failsWithout(edit(childSessionID, "src/a.ts", { ruleset: [deny("edit", "src/*")] }))
        expect(editDenied.text).not.toContain('dag.permission is "readonly"')

        const mcpDenied = yield* failsWithout(mcp(childSessionID, tool, { ruleset: [deny(tool, "*")] }))
        expect(mcpDenied.text).not.toContain('dag.permission is "readonly"')

        // The tool face still denies what it always did: a pattern nobody wrote
        // a rule for, but that the review allowlist does not cover.
        const stillOverridden = yield* failsWithout(bash(childSessionID, "npm test"))
        expect(stillOverridden.text).toContain('dag.permission is "readonly"')

        expect(asked).toEqual([])
      }),
    ),
  { git: true },
)

it.instance(
  "readonly tier: read, grep, glob, webfetch and the agent tool are unaffected",
  () =>
    withTier(
      "readonly",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const { childSessionID } = yield* makeRun("unaffected")
        yield* settlesAlone(call(childSessionID, "read", "src/a.ts"))
        yield* settlesAlone(call(childSessionID, "grep", "TODO", { metadata: { pattern: "TODO", path: "src" } }))
        yield* settlesAlone(call(childSessionID, "glob", "*.ts", { metadata: { pattern: "*.ts", path: "src" } }))
        yield* settlesAlone(call(childSessionID, "webfetch", "https://example.test/"))
        yield* settlesAlone(call(childSessionID, "agent", "*"))
        expect(asked).toEqual([])
      }),
    ),
  { git: true },
)

it.instance(
  "readonly tier: nothing ever reaches the user; RO-1 catches what the list did not already decide",
  () =>
    withTier(
      "readonly",
      Effect.gen(function* () {
        const asked = yield* watchAsked
        const { childSessionID } = yield* makeRun("ro1")

        // read outside the project and outside the whitelist: under `allow` this is an
        // unmatched ask and passes; under `readonly` RO-1 denies it.
        const outside = yield* failsWithout(
          ask(childSessionID, {
            permission: "external_directory",
            patterns: ["/opt/other/*"],
            metadata: { filepath: "/opt/other/file.txt", parentDir: "/opt/other" },
            ruleset: [{ permission: "external_directory", pattern: "*", action: "ask" }],
          }),
        )
        expect(outside.text).toContain("dag_safety:RO-1")

        // The built-in list still decides first: doom_loop (SF-5), a forced hook ask (SF-6),
        // and a `.env` read (SF-2) are denied by their own rule, not by RO-1.
        const doomLoop = yield* failsWithout(call(childSessionID, "doom_loop", "echo hi"))
        expect(doomLoop.text).toContain("dag_safety:SF-5")
        const hookAsk = yield* failsWithout(
          call(childSessionID, "bash", "bash", { metadata: { hookAsk: true }, options: { force: true } }),
        )
        expect(hookAsk.text).toContain("dag_safety:SF-6")
        const envRead = yield* failsWithout(call(childSessionID, "read", ".env"))
        expect(envRead.text).toContain("dag_safety:SF-2")

        // A rule that resolves to allow (the default `webfetch`) is unaffected by RO-1.
        yield* settlesAlone(call(childSessionID, "webfetch", "https://example.test/"))

        expect(asked).toEqual([])
      }),
    ),
  { git: true },
)

it.instance(
  "readonly tier: a task child of a root in DAG mode is held to the same rules; DAG mode off leaves it attended",
  () =>
    withTier(
      "readonly",
      Effect.gen(function* () {
        yield* setRootDagMode("on")
        const on = yield* makeRun("task-on", {
          owner: { kind: "task", toolCallID: "call_on" },
          permission: { ask: "root-dag-mode" },
        })
        yield* failsWithout(bash(on.childSessionID, "npm test"))
        yield* failsWithout(edit(on.childSessionID, "src/a.ts"))
        yield* failsWithout(mcp(on.childSessionID, "srv_tool"))
        yield* settlesAlone(call(on.childSessionID, "read", "src/a.ts"))
        yield* settlesAlone(bash(on.childSessionID, "git diff"))

        // DAG mode off: the task child is attended, and an allowed call just runs.
        yield* setRootDagMode("off")
        const off = yield* makeRun("task-off", {
          owner: { kind: "task", toolCallID: "call_off" },
          permission: { ask: "root-dag-mode" },
        })
        yield* settlesAlone(bash(off.childSessionID, "npm test", { ruleset: [allow("bash", "*")] }))
        yield* settlesAlone(edit(off.childSessionID, "src/a.ts", { ruleset: [allow("edit", "*")] }))
      }),
    ),
  { git: true },
)

it.instance(
  "the tier is read at every ask: a switch to readonly reaches the node's next call and back",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("switch")
      yield* withTier(
        "allow",
        Effect.gen(function* () {
          yield* settlesAlone(bash(childSessionID, "npm test"))
          config.tier = "readonly"
          yield* failsWithout(bash(childSessionID, "npm test"))
          yield* failsWithout(edit(childSessionID, "src/a.ts"))
          config.tier = "allow"
          yield* settlesAlone(bash(childSessionID, "npm test"))
          yield* settlesAlone(edit(childSessionID, "src/a.ts"))
        }),
      )
    }),
  { git: true },
)

/**
 * RO-1 and the built-in list publish `NodeSafetyDenied` for a DAG node, which
 * lands on its row; a rule-based denial from the readonly tool face (bash
 * outside the allowlist, edit, an unnamed MCP tool) is a plain `DeniedError`
 * and never reaches that path.
 */
it.instance(
  "readonly tier: RO-1 and the safety list publish NodeSafetyDenied; the tool-face denials do not",
  () =>
    withTier(
      "readonly",
      Effect.gen(function* () {
        yield* setRootDagMode("off")
        const dagService = yield* Dag.Service
        const dagID = yield* dagService.create({
          projectID: "prj_dag_readonly",
          sessionID: rootSessionID,
          title: "readonly safety",
          config: {
            name: "readonly safety",
            nodes: [
              {
                id: "a",
                name: "a",
                worker_type: "build",
                depends_on: [],
                required: true,
                prompt_template: { inline: "a" },
              },
            ],
          },
        })
        const childSessionID = SessionID.make("ses_dag_readonly_node_a")
        yield* dagService.nodeQueued(dagID, "a")
        yield* dagService.nodeStarted(dagID, "a", childSessionID, Date.now() + 60_000, true)

        const entry = ChildRegistry.create({
          id: "crun_dag_readonly_node_a",
          childSessionID,
          parentSessionID: rootSessionID,
          ownerKind: "dag_node",
          ownerKey: { kind: "dag_node", workflowID: dagID, nodeID: "a", attempt: 0 },
          permission: { ask: "auto" },
          detached: false,
          directory: undefined,
          owner: {},
        })
        expect(ChildRegistry.register(entry)).toBe(true)

        // RO-1 (an unmatched ask outside the project).
        yield* failsWithout(
          ask(childSessionID, {
            permission: "external_directory",
            patterns: ["/opt/other/*"],
            metadata: { filepath: "/opt/other/file.txt", parentDir: "/opt/other" },
            ruleset: [{ permission: "external_directory", pattern: "*", action: "ask" }],
          }),
        )
        // The built-in list (SF-5, doom_loop).
        yield* failsWithout(call(childSessionID, "doom_loop", "echo hi"))
        // The readonly tool face: a plain rule denial for each of the three
        // classes it replaces, none a safety-list one.
        yield* failsWithout(bash(childSessionID, "npm test"))
        yield* failsWithout(edit(childSessionID, "src/a.ts"))
        yield* failsWithout(mcp(childSessionID, "github_create_issue"))

        ChildRegistry.end(entry, { type: "completed" })
        ChildRegistry.release(entry)

        const storeService = yield* DagStore.Service
        const row = yield* storeService.getNode(dagID, "a")
        expect(row?.safetyDenials?.total).toBe(2)
        expect(row?.safetyDenials?.items.map((item) => item.ruleID)).toEqual(["RO-1", "SF-5"])
      }),
    ),
  { git: true },
)

/**
 * Runtime configuration goes through the whole assembly, like the `ask` tier's
 * own equivalent test: the tier has to arrive through the global configuration
 * the user edits (the file, not a test double).
 */
const appIt = testEffect(AppLayer)

appIt.instance(
  "the full app assembly reads dag.permission: readonly from the global configuration",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dag-permission-readonly-"))),
        (created) => Effect.promise(() => fs.rm(created, { recursive: true, force: true })),
      )
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
            const { childSessionID } = yield* makeRun("app-tier")
            yield* write({ permission: "allow" })
            yield* settlesAlone(bash(childSessionID, "npm test"))
            yield* write({ permission: "readonly" })
            yield* failsWithout(bash(childSessionID, "npm test"))
            yield* write({ permission: "allow" })
            yield* settlesAlone(bash(childSessionID, "npm test"))
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
