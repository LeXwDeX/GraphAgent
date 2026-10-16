import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { Permission } from "@/permission"
import { SessionTools } from "@/session/tools"
import { ReadTool } from "@/tool/read"
import { WriteTool } from "@/tool/write"
import { ToolRegistry } from "@/tool/registry"
import { Plugin } from "@/plugin"
import { MCP } from "@/mcp"
import { Truncate } from "@/tool/truncate"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionProcessor } from "@/session/processor"
import type { TaskPromptOps } from "@/tool/task"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
const hookLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const toolDependencies = Layer.mergeAll(
  FSUtil.defaultLayer,
  EventV2Bridge.defaultLayer,
  Layer.mock(Instruction.Service, { resolve: () => Effect.succeed([]) }),
  Layer.mock(LSP.Service, { touchFile: () => Effect.void, diagnostics: () => Effect.succeed({}) }),
  Layer.mock(Format.Service, { file: () => Effect.succeed(false) }),
  Layer.mock(Agent.Service, {
    permissionPolicy: () => Effect.succeed({ native: [], rules: [] }),
    get: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} } as Agent.Info),
  }),
  Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false }) }),
)
const layers = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provideMerge(hookLayer)),
  toolDependencies,
  Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
  Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
  Layer.unwrap(
    Effect.gen(function* () {
      const read = yield* ReadTool
      const write = yield* WriteTool
      const definitions = [
        { id: read.id, ...(yield* read.init()) },
        { id: write.id, ...(yield* write.init()) },
      ]
      return Layer.mock(ToolRegistry.Service, {
        tools: () => Effect.succeed(definitions),
        registrations: () =>
          Effect.succeed(
            definitions.map((definition) => ({
              definition,
              sourceKind: "host-builtin" as const,
              registrationID: `test:${definition.id}`,
            })),
          ),
      })
    }),
  ).pipe(Layer.provide(toolDependencies)),
)
const it = testEffect(layers)

describe("Claude-formatted PermissionRequest input rewrite", () => {
  for (const name of ["read", "write"] as const) {
    it.instance(`rewrites the real ${name} tool's filePath before execution`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const sessionID = SessionID.descending()
        const original = path.join(instance.directory, `${name}-original.txt`)
        const replacement = path.join(instance.directory, `${name}-replacement.txt`)
        yield* Effect.promise(() => fs.writeFile(original, "ORIGINAL_CONTENT"))
        yield* Effect.promise(() => fs.writeFile(replacement, "REPLACEMENT_CONTENT"))
        const audit = path.join(instance.directory, `${name}-hook-stdin.json`)
        const decision = {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: "allow",
              updatedInput:
                name === "read"
                  ? { file_path: replacement }
                  : { file_path: replacement, content: "WRITTEN_BY_REWRITE" },
            },
          },
        }
        const command = `cat >> ${quote(audit)}; printf '\n' >> ${quote(audit)}; printf '%s' ${quote(JSON.stringify(decision))}`
        const hooks = yield* SessionHooks.Service
        yield* hooks.add(sessionID, {
          event: "PermissionRequest",
          matcher: name === "read" ? "Read" : "Write",
          hooks: [{ type: "command", command, inputFormat: "claude-code" }],
        })
        // Only the fields used by this direct tool boundary are populated; the real read/write definitions run below.
        const tools = yield* SessionTools.resolve({
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          agent: {
            name: "build",
            permission: [{ permission: name === "read" ? "read" : "edit", pattern: "*", action: "ask" }],
            options: {},
          } as Agent.Info,
          model: ProviderTest.model(),
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          session: { id: sessionID, directory: instance.directory, permission: [] } as unknown as Session.Info,
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          processor: {
            message: { id: MessageID.ascending(), sessionID },
            updateToolCall: () => Effect.succeed(undefined),
            completeToolCall: () => Effect.void,
          } as unknown as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
          bypassAgentCheck: false,
          messages: [],
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          promptOps: {} as TaskPromptOps,
        })
        const execute = tools[name]?.execute
        if (!execute) throw new Error(`missing ${name} tool executor`)
        const output = yield* Effect.promise(() =>
          execute(
            name === "read" ? { filePath: original } : { filePath: original, content: "SHOULD_NOT_WRITE_ORIGINAL" },
            { toolCallId: `rewrite-${name}`, messages: [], abortSignal: new AbortController().signal },
          ),
        )
        const stdin = JSON.parse((yield* Effect.promise(() => fs.readFile(audit, "utf8"))).trim().split("\n")[0])
        expect(stdin.tool_name).toBe(name === "read" ? "Read" : "Write")
        expect(stdin.tool_input.file_path).toBe(original)
        if (name === "read") expect(JSON.stringify(output)).toContain("REPLACEMENT_CONTENT")
        else {
          expect(yield* Effect.promise(() => fs.readFile(replacement, "utf8"))).toBe("WRITTEN_BY_REWRITE")
          expect(yield* Effect.promise(() => fs.readFile(original, "utf8"))).toBe("ORIGINAL_CONTENT")
        }
      }),
    )
  }

  it.instance("truncated JSON blocks a real Write before side effects and retries its once hook", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sessionID = SessionID.descending()
      const target = path.join(instance.directory, "malformed-hook-target.txt")
      const count = path.join(instance.directory, "malformed-hook-count.txt")
      const script = path.join(instance.directory, "malformed-hook.ts")
      yield* Effect.promise(() =>
        fs.writeFile(
          script,
          `import fs from 'node:fs/promises';let n=0;try{n=Number(await fs.readFile(${JSON.stringify(count)},'utf8'))}catch{};n++;await fs.writeFile(${JSON.stringify(count)},String(n));process.stdout.write(n===1?'{"continue":':JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'fixture-deny'}}))`,
        ),
      )
      const hooks = yield* SettingsHook.Service
      yield* hooks.registerScoped!(sessionID, {
        kind: "skill",
        origin: "skill:/malformed-json-once/SKILL.md",
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: process.execPath, args: [script], once: true, onFailure: "block" }] },
          ],
        },
      })
      const store = yield* SessionHooks.Service
      yield* store.add(sessionID, {
        event: "PermissionRequest",
        hooks: [
          {
            type: "command",
            command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })}'`,
          },
        ],
      })
      // This is the same real registry + permission + SessionTools path used by Read/Write above.
      const tools = yield* SessionTools.resolve({
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        agent: {
          name: "build",
          permission: [{ permission: "edit", pattern: "*", action: "allow" }],
          options: {},
        } as Agent.Info,
        model: ProviderTest.model(),
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        session: { id: sessionID, directory: instance.directory, permission: [] } as unknown as Session.Info,
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        processor: {
          message: { id: MessageID.ascending(), sessionID },
          updateToolCall: () => Effect.succeed(undefined),
          completeToolCall: () => Effect.void,
        } as unknown as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
        bypassAgentCheck: false,
        messages: [],
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        promptOps: {} as TaskPromptOps,
      })
      const execute = tools.write?.execute
      if (!execute) throw new Error("missing Write tool executor")
      const write = (index: number) =>
        Effect.promise(() =>
          execute(
            { filePath: target, content: `write-${index}` },
            { toolCallId: `malformed-${index}`, messages: [], abortSignal: new AbortController().signal },
          ),
        )
      const first = yield* write(1)
      expect(JSON.stringify(first)).toContain("hook invalid JSON")
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
      const second = yield* write(2)
      expect(JSON.stringify(second)).toContain("fixture-deny")
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
      yield* write(3)
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("write-3")
      expect(yield* Effect.promise(() => fs.readFile(count, "utf8"))).toBe("2")
    }),
  )
})
