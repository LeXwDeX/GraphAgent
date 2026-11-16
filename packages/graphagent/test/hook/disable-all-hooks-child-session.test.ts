// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the session, agent and processor are minimal fixtures for SessionTools.resolve

import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@graphagent/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SettingsHook } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { SessionID, MessageID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { TestInstance } from "../fixture/fixture"
import { isolatedGlobalConfig, writeHookLayers, type HookLayerFiles } from "../fixture/hook-layers"
import { builtinEntry } from "../fixture/tool-registry"
import { testEffect } from "../lib/effect"

// `disableAllHooks` applies by layer to the tool calls a child session makes
// (a task sub-agent or a DAG node), exactly as it does to the root session's:
// the real hook engine runs behind SessionTools.resolve with a child session
// (one with a parentID), and each hook reports that it ran by creating a marker
// file.

const hookLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)

const writeDefinition = {
  id: "write",
  description: "Fixture leaf writer",
  parameters: Schema.Struct({ filePath: Schema.String, content: Schema.String }),
  execute: (args: { filePath: string; content: string }) =>
    Effect.promise(async () => {
      await fs.writeFile(args.filePath, args.content)
      return { title: "written", output: "WRITE_COMPLETE", metadata: {} }
    }),
}

const it = testEffect(
  Layer.mergeAll(
    hookLayer,
    Layer.mock(Permission.Service, {
      ask: () => Effect.void,
      hookPolicy: () => Effect.succeed({ rules: [], directories: [] }),
    }),
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
    Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false }) }),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed([writeDefinition]),
      resolve: () => Effect.succeed([builtinEntry(writeDefinition)]),
    }),
  ),
)

const NAMES = ["GLOBAL", "PROJECT", "LOCAL", "AGENT_USER", "AGENT_PROJECT"] as const
type Name = (typeof NAMES)[number]

/** A PreToolUse hook that creates `<root>/<name>.mark` when it runs. */
const markerHook = (root: string, name: Name) => ({
  PreToolUse: [
    {
      hooks: [
        {
          type: "command" as const,
          command: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", path.join(root, `${name}.mark`)],
        },
      ],
    },
  ],
})

/** Run one tool call as a child session of another and report which hooks ran. */
const childToolCall = (files: (root: string) => HookLayerFiles) =>
  Effect.gen(function* () {
    const { dir } = yield* isolatedGlobalConfig
    const { directory } = yield* TestInstance
    yield* writeHookLayers(directory, dir, files(directory))
    const hook = yield* SettingsHook.Service
    const parentID = SessionID.descending()
    const childID = SessionID.descending()
    // The agent frontmatter hooks a sub-agent or DAG node registers for its own session.
    for (const [name, source] of [
      ["AGENT_USER", "user"],
      ["AGENT_PROJECT", "project"],
    ] as const)
      yield* hook.registerScoped!(childID, {
        kind: "agent",
        origin: `agent:/agents/${name}.md`,
        source,
        child: true,
        hooks: markerHook(directory, name),
      })
    const tools = yield* SessionTools.resolve({
      agent: { name: "general", permission: [], options: {} } as any,
      model: ProviderTest.model(),
      session: { id: childID, parentID, directory, permission: [] } as any,
      processor: {
        message: { id: MessageID.ascending(), sessionID: childID },
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      } as any,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as any,
    })
    const target = path.join(directory, "child.txt")
    yield* Effect.promise(() =>
      (tools as any).write.execute(
        { filePath: target, content: "child-output" },
        { toolCallId: "child-write", messages: [], abortSignal: new AbortController().signal },
      ),
    )
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("child-output")
    const ran = yield* Effect.promise(() =>
      Promise.all(
        NAMES.map((name) =>
          fs.access(path.join(directory, `${name}.mark`)).then(
            () => true,
            () => false,
          ),
        ),
      ),
    )
    return NAMES.filter((_, index) => ran[index])
  })

describe("disableAllHooks for tool calls inside a child session", () => {
  it.instance("a project-layer true keeps the global and user-sourced hooks running", () =>
    Effect.gen(function* () {
      const ran = yield* childToolCall((root) => ({
        global: markerHook(root, "GLOBAL"),
        project: { ...markerHook(root, "PROJECT"), disableAllHooks: true },
        local: markerHook(root, "LOCAL"),
      }))
      expect(ran).toEqual(["GLOBAL", "AGENT_USER"])
    }),
  )

  it.instance("a local-layer true gives the same outcome", () =>
    Effect.gen(function* () {
      const ran = yield* childToolCall((root) => ({
        global: markerHook(root, "GLOBAL"),
        project: markerHook(root, "PROJECT"),
        local: { ...markerHook(root, "LOCAL"), disableAllHooks: true },
      }))
      expect(ran).toEqual(["GLOBAL", "AGENT_USER"])
    }),
  )

  it.instance("a global-layer true turns off every hook whatever the project layers say", () =>
    Effect.gen(function* () {
      const ran = yield* childToolCall((root) => ({
        global: { ...markerHook(root, "GLOBAL"), disableAllHooks: true },
        project: { ...markerHook(root, "PROJECT"), disableAllHooks: false },
        local: { ...markerHook(root, "LOCAL"), disableAllHooks: false },
      }))
      expect(ran).toEqual([])
    }),
  )

  it.instance("without the setting every hook runs", () =>
    Effect.gen(function* () {
      const ran = yield* childToolCall((root) => ({
        global: markerHook(root, "GLOBAL"),
        project: markerHook(root, "PROJECT"),
        local: markerHook(root, "LOCAL"),
      }))
      expect(ran).toEqual(["GLOBAL", "PROJECT", "LOCAL", "AGENT_USER", "AGENT_PROJECT"])
    }),
  )
})
