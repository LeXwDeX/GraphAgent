// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- test instance contexts are narrowed from their producing APIs

import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { Context, Effect, Layer } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "@graphagent/core/database/database"
import { FSUtil } from "@graphagent/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { InstanceRef } from "@/effect/instance-ref"
import { SettingsHook, mergeSettings, type HookCommand, type HookLayer, type Settings } from "@/hook"
import { enabledGroups, enabledMatchers, fileSide, sessionSide } from "@/hook/engine/disabled"
import { HookFileWatch } from "@/hook/file-watch"
import { SessionHooks } from "@/hook/session-hooks"
import type { InstanceContext } from "@/project/instance-context"
import { ProjectTrust } from "@/project/trust"
import { SessionID } from "@/session/schema"
import { BUILTIN_SKILLS } from "@/skill/builtin"
import { TestInstance } from "../fixture/fixture"
import { isolatedGlobalConfig, writeHookLayers, type HookLayerFiles } from "../fixture/hook-layers"
import { pollWithTimeout, testEffect } from "../lib/effect"

// `disableAllHooks` applies by the layer that wrote it:
//   - the global layer switches off every hook, whatever layer defines it;
//   - the project and local layers switch off only the hooks defined on the
//     project side (hooks.json, hooks.local.json and project-sourced scoped
//     skill/agent hooks); global hooks keep running;
//   - false in the project or local layer has no effect;
//   - the outcome does not depend on project trust or on Git tracking.

const base = SettingsHook.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(Database.defaultLayer))
const it = testEffect(base.pipe(Layer.provideMerge(SessionHooks.defaultLayer)))

const staticCalls: (readonly string[])[] = []
const watchIt = testEffect(
  base.pipe(
    Layer.provide(
      Layer.mock(HookFileWatch.Service, {
        refreshStatic: (paths) => Effect.sync(() => void staticCalls.push(paths)),
        replace: () => Effect.void,
        clear: () => Effect.void,
        paths: () => Effect.succeed(undefined),
      }),
    ),
    Layer.provideMerge(SessionHooks.defaultLayer),
  ),
)

/** A PreToolUse command hook that reports `marker` as additional context. */
const preToolHook = (marker: string) => ({
  type: "command" as const,
  command: process.execPath,
  args: [
    "-e",
    `process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: marker } }))})`,
  ],
})
const preTool = (marker: string) => ({ PreToolUse: [{ hooks: [preToolHook(marker)] }] })
const fileChanged = (matcher: string) => ({
  FileChanged: [{ matcher, hooks: [{ type: "command" as const, command: "true" }] }],
})

/** Write the three hooks files, then hand back the engine (its state loads on first use). */
const setup = (files: HookLayerFiles) =>
  Effect.gen(function* () {
    const { dir } = yield* isolatedGlobalConfig
    const { directory } = yield* TestInstance
    yield* writeHookLayers(directory, dir, files)
    return yield* SettingsHook.Service
  })

let counter = 0
const preToolContexts = (hook: SettingsHook.Interface, sessionID: string = `sess-disable-layers-${++counter}`) =>
  hook
    .trigger(
      { event: "PreToolUse", toolName: "bash", toolInput: { command: "true" } },
      { sessionID, transcript: () => Effect.succeed("") },
    )
    .pipe(Effect.map((result) => result.additionalContexts))

const scopes = (hook: SettingsHook.Interface) => hook.list().pipe(Effect.map((entries) => entries.map((e) => e.scope)))

describe("disableAllHooks in the project layer", () => {
  it.instance("turns off project and local hooks and leaves the global hook running", () =>
    Effect.gen(function* () {
      const hook = yield* setup({
        global: preTool("GLOBAL"),
        project: { ...preTool("PROJECT"), disableAllHooks: true },
        local: preTool("LOCAL"),
      })
      expect(yield* preToolContexts(hook)).toEqual(["GLOBAL"])
      expect(yield* scopes(hook)).toEqual(["global"])
      expect(yield* hook.hasEvent!("PreToolUse")).toBe(true)
    }),
  )

  it.instance("has the same outcome when only the project layer holds hooks of its own", () =>
    Effect.gen(function* () {
      const hook = yield* setup({ project: { ...preTool("PROJECT"), disableAllHooks: true } })
      expect(yield* preToolContexts(hook)).toEqual([])
      expect(yield* scopes(hook)).toEqual([])
      expect(yield* hook.hasEvent!("PreToolUse")).toBe(false)
    }),
  )

  it.instance("has no effect on the static watch paths of the global layer", () =>
    Effect.gen(function* () {
      const hook = yield* setup({
        global: fileChanged(".envrc"),
        project: { ...fileChanged(".env.local"), disableAllHooks: true },
        local: fileChanged(".env.dev"),
      })
      expect(yield* hook.fileWatchPaths!()).toEqual([".envrc"])
    }),
  )
})

describe("disableAllHooks in the local layer", () => {
  it.instance(
    "an untracked hooks.local.json turns off project and local hooks and leaves the global hook running",
    () =>
      Effect.gen(function* () {
        const hook = yield* setup({
          global: preTool("GLOBAL"),
          project: preTool("PROJECT"),
          local: { ...preTool("LOCAL"), disableAllHooks: true },
        })
        expect(yield* preToolContexts(hook)).toEqual(["GLOBAL"])
        expect(yield* scopes(hook)).toEqual(["global"])
      }),
    { git: true },
  )

  it.instance(
    "a hooks.local.json tracked by Git gives the same outcome",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const hook = yield* setup({
          global: preTool("GLOBAL"),
          project: preTool("PROJECT"),
          local: { ...preTool("LOCAL"), disableAllHooks: true },
        })
        execFileSync("git", ["add", "-f", ".agents/hooks.local.json"], { cwd: directory })
        expect(yield* preToolContexts(hook)).toEqual(["GLOBAL"])
        expect(yield* scopes(hook)).toEqual(["global"])
      }),
    { git: true },
  )
})

describe("disableAllHooks in the global layer", () => {
  it.instance("turns off every layer whatever the project and local layers say", () =>
    Effect.gen(function* () {
      const hook = yield* setup({
        global: { ...preTool("GLOBAL"), ...fileChanged(".envrc"), disableAllHooks: true },
        project: { ...preTool("PROJECT"), ...fileChanged(".env.local"), disableAllHooks: false },
        local: { ...preTool("LOCAL"), disableAllHooks: false },
      })
      expect(yield* preToolContexts(hook)).toEqual([])
      expect(yield* scopes(hook)).toEqual([])
      expect(yield* hook.hasEvent!("PreToolUse")).toBe(false)
      expect(yield* hook.fileWatchPaths!()).toEqual([])
    }),
  )

  it.instance("turns off every layer when the project layers do not mention it", () =>
    Effect.gen(function* () {
      const hook = yield* setup({
        global: { ...preTool("GLOBAL"), disableAllHooks: true },
        project: preTool("PROJECT"),
        local: preTool("LOCAL"),
      })
      expect(yield* preToolContexts(hook)).toEqual([])
    }),
  )
})

describe("disableAllHooks false", () => {
  it.instance("in the project and local layers changes nothing", () =>
    Effect.gen(function* () {
      const hook = yield* setup({
        global: preTool("GLOBAL"),
        project: { ...preTool("PROJECT"), disableAllHooks: false },
        local: { ...preTool("LOCAL"), disableAllHooks: false },
      })
      expect(yield* preToolContexts(hook)).toEqual(["GLOBAL", "PROJECT", "LOCAL"])
      expect(yield* scopes(hook)).toEqual(["global", "project", "local"])
    }),
  )

  it.instance("in the local layer does not undo a true in the project layer", () =>
    Effect.gen(function* () {
      const hook = yield* setup({
        global: preTool("GLOBAL"),
        project: { ...preTool("PROJECT"), disableAllHooks: true },
        local: { ...preTool("LOCAL"), disableAllHooks: false },
      })
      expect(yield* preToolContexts(hook)).toEqual(["GLOBAL"])
    }),
  )

  it.instance("in the global layer changes nothing", () =>
    Effect.gen(function* () {
      const hook = yield* setup({
        global: { ...preTool("GLOBAL"), disableAllHooks: false },
        project: preTool("PROJECT"),
      })
      expect(yield* preToolContexts(hook)).toEqual(["GLOBAL", "PROJECT"])
    }),
  )
})

describe("scoped hooks follow the layer that defines them", () => {
  const registerAll = (hook: SettingsHook.Interface, sessionID: SessionID) =>
    Effect.gen(function* () {
      const register = (
        kind: "agent" | "skill",
        name: string,
        source: "user" | "builtin" | "project" | undefined,
        origin = `${kind}:/scoped/${name}.md`,
      ) =>
        hook.registerScoped!(sessionID, {
          kind,
          origin,
          ...(source === undefined ? {} : { source }),
          hooks: preTool(name),
        })
      yield* register("agent", "AGENT_USER", "user")
      yield* register("agent", "AGENT_BUILTIN", "builtin")
      yield* register("agent", "AGENT_UNSOURCED", undefined)
      // An inline `agent.<name>.hooks` registration names no defining file, whatever source its loader recorded.
      yield* register("agent", "AGENT_INLINE", "project", "agent-config:inline")
      yield* register("agent", "AGENT_PROJECT", "project")
      yield* register("skill", "SKILL_USER", "user")
      yield* register("skill", "SKILL_PROJECT", "project")
    })

  it.instance("a project-layer true turns off project-sourced scoped hooks only", () =>
    Effect.gen(function* () {
      const hook = yield* setup({ project: { disableAllHooks: true } })
      const sessionID = SessionID.descending()
      yield* registerAll(hook, sessionID)
      expect(yield* preToolContexts(hook, sessionID)).toEqual([
        "AGENT_USER",
        "AGENT_BUILTIN",
        "AGENT_UNSOURCED",
        "AGENT_INLINE",
        "SKILL_USER",
      ])
      expect(yield* hook.hasEvent!("PreToolUse", sessionID)).toBe(true)
    }),
  )

  it.instance("a project-layer true leaves nothing to run when every scoped hook is project-sourced", () =>
    Effect.gen(function* () {
      const hook = yield* setup({ project: { disableAllHooks: true } })
      const sessionID = SessionID.descending()
      yield* hook.registerScoped!(sessionID, {
        kind: "agent",
        origin: "agent:/scoped/ONLY_PROJECT.md",
        source: "project",
        hooks: preTool("ONLY_PROJECT"),
      })
      expect(yield* preToolContexts(hook, sessionID)).toEqual([])
      expect(yield* hook.hasEvent!("PreToolUse", sessionID)).toBe(false)
    }),
  )

  it.instance("a local-layer true gives the same outcome", () =>
    Effect.gen(function* () {
      const hook = yield* setup({ local: { disableAllHooks: true } })
      const sessionID = SessionID.descending()
      yield* registerAll(hook, sessionID)
      expect(yield* preToolContexts(hook, sessionID)).toEqual([
        "AGENT_USER",
        "AGENT_BUILTIN",
        "AGENT_UNSOURCED",
        "AGENT_INLINE",
        "SKILL_USER",
      ])
    }),
  )

  it.instance("a global-layer true turns off scoped hooks from every source", () =>
    Effect.gen(function* () {
      const hook = yield* setup({ global: { disableAllHooks: true } })
      const sessionID = SessionID.descending()
      yield* registerAll(hook, sessionID)
      expect(yield* preToolContexts(hook, sessionID)).toEqual([])
      expect(yield* hook.hasEvent!("PreToolUse", sessionID)).toBe(false)
    }),
  )

  it.instance("without the setting every scoped hook runs", () =>
    Effect.gen(function* () {
      const hook = yield* setup({})
      const sessionID = SessionID.descending()
      yield* registerAll(hook, sessionID)
      expect(yield* preToolContexts(hook, sessionID)).toEqual([
        "AGENT_USER",
        "AGENT_BUILTIN",
        "AGENT_UNSOURCED",
        "AGENT_INLINE",
        "AGENT_PROJECT",
        "SKILL_USER",
        "SKILL_PROJECT",
      ])
    }),
  )
})

describe("disableAllHooks reloads", () => {
  watchIt.instance(
    "a reload that flips the project layer refreshes the static watch paths by layer",
    () =>
      Effect.gen(function* () {
        const hook = yield* setup({
          global: fileChanged(".envrc"),
          project: { ...fileChanged(".env.local"), disableAllHooks: false },
        })
        const { directory } = yield* TestInstance
        staticCalls.length = 0
        expect(yield* hook.fileWatchPaths!()).toEqual([".envrc", ".env.local"])
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(directory, ".agents", "hooks.json"),
            JSON.stringify({ ...fileChanged(".env.local"), disableAllHooks: true }),
          ),
        )
        yield* pollWithTimeout(
          Effect.sync(() => (staticCalls.length > 0 ? true : undefined)),
          "static watchers were not refreshed",
          "12 seconds",
        )
        expect(staticCalls.at(-1)).toEqual([".envrc"])
        expect(yield* hook.fileWatchPaths!()).toEqual([".envrc"])
      }),
    { timeout: 30_000 },
  )
})

describe("mergeSettings records which layer switched hooks off", () => {
  const layer = (scope: HookLayer["scope"], disableAllHooks?: boolean): HookLayer => ({
    scope,
    settings: disableAllHooks === undefined ? {} : { disableAllHooks },
  })
  const merged = (...layers: HookLayer[]) => mergeSettings(layers).hooksDisabled

  test("a global true records the global fact", () => {
    expect(merged(layer("global", true), layer("project", false))).toEqual({ global: true, project: false })
  })
  test("a project or local true records the project-side fact", () => {
    expect(merged(layer("global"), layer("project", true))).toEqual({ global: false, project: true })
    expect(merged(layer("global"), layer("project"), layer("local", true))).toEqual({ global: false, project: true })
  })
  test("a false never records a fact, and a true is not undone by a later false", () => {
    expect(merged(layer("global", false), layer("project", false), layer("local", false))).toBeUndefined()
    expect(merged(layer("project", true), layer("local", false))).toEqual({ global: false, project: true })
  })
  test("both facts can hold together", () => {
    expect(merged(layer("global", true), layer("local", true))).toEqual({ global: true, project: true })
  })
  test("the merged settings no longer carry a single boolean", () => {
    expect(mergeSettings([layer("global", true), layer("project", true)])).not.toHaveProperty("disableAllHooks")
  })
})

describe("which side of the chain a hook is defined on", () => {
  const hook = (command: string, scope: "global" | "project" | "local"): HookCommand => ({
    type: "command",
    command,
    __source: { scope, file: `/${scope}/hooks.json` },
  })
  const settings = (hooksDisabled?: Settings["hooksDisabled"]): Settings => ({
    ...(hooksDisabled === undefined ? {} : { hooksDisabled }),
    hooks: {
      FileChanged: [
        { matcher: ".envrc", hooks: [hook("g", "global")] },
        { matcher: ".env.local", hooks: [hook("p", "project")] },
        { matcher: ".env.dev|.env.test", hooks: [hook("l", "local")] },
        { matcher: ".mixed", hooks: [hook("g2", "global"), hook("p2", "project")] },
      ],
    },
  })
  const commands = (groups: readonly { hooks: HookCommand[] }[]) => groups.flatMap((g) => g.hooks.map((h) => h.command))

  test("a hooks file is project-side for the project and local layers only", () => {
    expect(fileSide("global")).toBe("global")
    expect(fileSide("project")).toBe("project")
    expect(fileSide("local")).toBe("project")
    expect(fileSide(undefined)).toBe("global")
  })

  test("a session hook is project-side only when its definition is project-sourced", () => {
    expect(sessionSide({ source: "project", origin: "agent:/repo/.agents/agents/a.md" })).toBe("project")
    expect(sessionSide({ source: "project", origin: "skill:/repo/.agents/skills/s/SKILL.md" })).toBe("project")
    expect(sessionSide({ source: "user", origin: "agent:/config/agents/a.md" })).toBe("global")
    expect(sessionSide({ source: "builtin", origin: "agent:build" })).toBe("global")
    expect(sessionSide({})).toBe("global")
  })

  test("an inline agent-config registration counts as global whatever source it carries", () => {
    expect(sessionSide({ source: "project", origin: "agent-config:inline" })).toBe("global")
    expect(sessionSide({ source: "user", origin: "agent-config:inline" })).toBe("global")
    expect(sessionSide({ origin: "agent-config:inline" })).toBe("global")
  })

  test("a project-side switch drops project and local hooks, including from a mixed group", () => {
    const value = settings({ global: false, project: true })
    const groups = value.hooks!.FileChanged!
    expect(commands(enabledMatchers(value, groups))).toEqual(["g", "g2"])
    expect(enabledMatchers(value, groups).map((g) => g.matcher)).toEqual([".envrc", ".mixed"])
  })

  test("a global switch drops every hook", () => {
    const value = settings({ global: true, project: false })
    expect(enabledMatchers(value, value.hooks!.FileChanged!)).toEqual([])
  })

  test("without a switch the groups come back as they are", () => {
    const value = settings()
    const groups = value.hooks!.FileChanged!
    expect(enabledMatchers(value, groups)).toBe(groups)
  })

  test("a kept compiled group retains its compiled matcher", () => {
    const value = settings({ global: false, project: true })
    const matches = () => true
    const compiled = value.hooks!.FileChanged!.map((group) => ({ group, test: matches }))
    const kept = enabledGroups(value, compiled)
    expect(kept.map((item) => item.group.matcher)).toEqual([".envrc", ".mixed"])
    expect(kept.every((item) => item.test === matches)).toBe(true)
    expect(kept[0]).toBe(compiled[0])
  })
})

describe("the configure-hooks skill states the layer rules", () => {
  const skill = BUILTIN_SKILLS.find((item) => item.name === "configure-hooks")?.content ?? ""

  test("describes the switch by the layer that wrote it", () => {
    expect(skill).toContain("`disableAllHooks` is a switch that applies by the layer that wrote it")
    expect(skill).toContain("`true` in the global `hooks.json` switches off every hook")
    expect(skill).toContain("switches off only the project side")
    expect(skill).toContain("`false` in a project or local layer has no effect")
    expect(skill).toContain("when the defining file is unknown it counts as global")
    expect(skill).toContain("None of this depends on project trust or on whether Git tracks `hooks.local.json`")
  })

  test("no longer says a later layer overrides an earlier one", () => {
    expect(skill).not.toContain("a later configuration layer")
    expect(skill).not.toContain("project-level `false` overrides")
  })
})

// ── An untrusted project ─────────────────────────────────────────────────────
// `it.instance` always boots a trusted instance, so this suite builds its own
// untrusted InstanceRef and a trust store in a temporary state directory.

const untrustedLayer = (stateDirectory: string) =>
  SettingsHook.layer.pipe(
    Layer.provideMerge(SessionHooks.defaultLayer),
    Layer.provideMerge(ProjectTrust.makeLayer({ stateDirectory })),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
  )

const untrustedContext = (root: string): InstanceContext => ({
  directory: root,
  worktree: root,
  root,
  project: { id: "global" } as never,
})

const untrusted = testEffect(Layer.empty)

const withUntrustedProject = <A, E, R>(
  body: (input: {
    root: string
    globalDir: string
    hooks: SettingsHook.Interface
    trust: ProjectTrust.Interface
    inInstance: <A2, E2, R2>(effect: Effect.Effect<A2, E2, R2>) => Effect.Effect<A2, E2, R2>
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "hook-disable-root-")))
    const stateDirectory = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "hook-disable-state-")))
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await fs.rm(root, { recursive: true, force: true })
        await fs.rm(stateDirectory, { recursive: true, force: true })
      }),
    )
    const { dir } = yield* isolatedGlobalConfig
    const services = yield* Layer.build(untrustedLayer(stateDirectory))
    const ctx = untrustedContext(root)
    const inInstance = <A2, E2, R2>(effect: Effect.Effect<A2, E2, R2>) =>
      effect.pipe(Effect.provideService(InstanceRef, ctx))
    yield* writeHookLayers(root, dir, {})
    return yield* body({
      root,
      globalDir: dir,
      hooks: Context.get(services, SettingsHook.Service),
      trust: Context.get(services, ProjectTrust.Service),
      inInstance,
    })
  })

describe("disableAllHooks while the project is untrusted", () => {
  untrusted.live("a project-layer true leaves the global hook running", () =>
    withUntrustedProject(({ root, globalDir, hooks, trust, inInstance }) =>
      Effect.gen(function* () {
        yield* writeHookLayers(root, globalDir, {
          global: preTool("GLOBAL"),
          project: { ...preTool("PROJECT"), disableAllHooks: true },
        })
        const pending = yield* inInstance(trust.list()).pipe(
          Effect.map((entries) => entries.filter((entry) => entry.state === "pending")),
        )
        expect(pending).toHaveLength(1)
        expect(yield* inInstance(preToolContexts(hooks))).toEqual(["GLOBAL"])
        expect(yield* inInstance(scopes(hooks))).toEqual(["global"])
      }),
    ),
  )

  untrusted.live("an untracked hooks.local.json true leaves the global hook running", () =>
    withUntrustedProject(({ root, globalDir, hooks, inInstance }) =>
      Effect.gen(function* () {
        yield* writeHookLayers(root, globalDir, {
          global: preTool("GLOBAL"),
          project: preTool("PROJECT"),
          local: { ...preTool("LOCAL"), disableAllHooks: true },
        })
        expect(yield* inInstance(preToolContexts(hooks))).toEqual(["GLOBAL"])
      }),
    ),
  )

  untrusted.live("a global-layer true still turns off every layer", () =>
    withUntrustedProject(({ root, globalDir, hooks, inInstance }) =>
      Effect.gen(function* () {
        yield* writeHookLayers(root, globalDir, {
          global: { ...preTool("GLOBAL"), disableAllHooks: true },
          project: { ...preTool("PROJECT"), disableAllHooks: false },
        })
        expect(yield* inInstance(preToolContexts(hooks))).toEqual([])
      }),
    ),
  )
})
