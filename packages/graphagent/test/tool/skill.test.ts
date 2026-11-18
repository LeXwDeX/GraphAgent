import { PermissionV1 } from "@graphagent/core/v1/permission"
import { SessionV1 } from "@graphagent/core/v1/session"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Hash } from "@graphagent/core/util/hash"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { Cause, Effect, Exit, Layer } from "effect"
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import type { Tool } from "@/tool/tool"
import { alreadyLoaded, SkillTool } from "../../src/tool/skill"
import { MessageV2 } from "../../src/session/message-v2"
import { BUILTIN_SKILLS } from "../../src/skill/builtin"
import { SettingsHook } from "../../src/hook"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, node).pipe(Layer.provide(Ripgrep.defaultLayer)))

const isolateHome = (dir: string) =>
  Effect.gen(function* () {
    const home = process.env.GRAPHAGENT_TEST_HOME
    // Keep the isolated user home distinct from the project root: a root
    // that equals $HOME carries no project layer.
    process.env.GRAPHAGENT_TEST_HOME = path.join(dir, ".home")
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (home === undefined) delete process.env.GRAPHAGENT_TEST_HOME
        else process.env.GRAPHAGENT_TEST_HOME = home
      }),
    )
  })

const skillTool = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
  const tool = (yield* registry.tools({
    providerID: ProviderV2.ID.make("graphagent"),
    modelID: ModelV2.ID.make("gpt-5"),
    agent,
  })).find((tool) => tool.id === SkillTool.id)
  if (!tool) throw new Error("Skill tool not found")
  return tool
})

const SKILL_BODY = "SKILL_BODY_MARKER"

// A history message holding one earlier tool call, shaped like what the
// session persists for a finished skill load (or a receipt for one).
function skillHistory(input: {
  callID: string
  name: string
  hash: unknown
  tool?: string
  status?: "completed" | "running"
  compacted?: number
  receipt?: boolean
  truncated?: boolean
  /** How the assistant message holding the call ended: a provider failure or an abort. */
  error?: "provider" | "aborted"
}): SessionV1.WithParts {
  const sessionID = SessionID.make("ses_test")
  const messageID = MessageID.make(`msg_history_${input.callID}`)
  const metadata = {
    name: input.name,
    dir: "/builtin",
    bytes: 1,
    hash: input.hash,
    ...(input.receipt ? { alreadyLoaded: true } : {}),
    ...(input.truncated ? { truncated: true } : {}),
  }
  const error: SessionV1.Assistant["error"] =
    input.error === "provider"
      ? { name: "APIError", data: { message: "boom", isRetryable: true } }
      : input.error === "aborted"
        ? { name: "MessageAbortedError", data: { message: "aborted" } }
        : undefined
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: 0 },
      ...(error === undefined ? {} : { error }),
      parentID: MessageID.make("msg_history_parent"),
      modelID: ModelV2.ID.make("gpt-5"),
      providerID: ProviderV2.ID.make("graphagent"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: PartID.make(`prt_history_${input.callID}`),
        sessionID,
        messageID,
        type: "tool",
        callID: input.callID,
        tool: input.tool ?? "skill",
        state:
          input.status === "running"
            ? { status: "running", input: { name: input.name }, metadata, time: { start: 0 } }
            : {
                status: "completed",
                input: { name: input.name },
                output: SKILL_BODY,
                title: `Loaded skill: ${input.name}`,
                metadata,
                time: { start: 0, end: 1, ...(input.compacted === undefined ? {} : { compacted: input.compacted }) },
              },
      },
    ],
  }
}

describe("tool.skill", () => {
  it.instance("execute returns skill content block with files", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const skill = path.join(dir, ".agents", "skills", "tool-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skill, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "demo.txt"), "demo"))

      const home = process.env.GRAPHAGENT_TEST_HOME
      // Keep the isolated user home distinct from the project root: a root
      // that equals $HOME carries no project layer.
      process.env.GRAPHAGENT_TEST_HOME = path.join(dir, ".home")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.GRAPHAGENT_TEST_HOME = home
        }),
      )

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "graphagent" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      expect(tool.description).not.toContain("tool-skill")
      expect(tool.description).not.toContain("Skill for tool tests.")

      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: (req) =>
          Effect.sync(() => {
            requests.push(req)
          }),
      }

      const result = yield* tool.execute({ name: "tool-skill" }, ctx)
      const file = path.resolve(skill, "scripts", "demo.txt")

      expect(requests.length).toBe(1)
      expect(requests[0].permission).toBe("skill")
      expect(requests[0].patterns).toContain("tool-skill")
      expect(requests[0].always).toContain("tool-skill")
      expect(result.metadata.dir).toBe(skill)
      expect(result.output).toContain(`<skill_content name="tool-skill">`)
      expect(result.output).toContain(
        `# Skill: tool-skill (${Buffer.byteLength("# Tool Skill\n\nUse this skill.")} bytes)`,
      )
      expect(result.output).toContain(`Base directory for this skill: ${skill}`)
      expect(result.output).toContain(`<file>${file}</file>`)
    }),
  )

  it.instance("execute loads a builtin skill without a filesystem listing", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const home = process.env.GRAPHAGENT_TEST_HOME
      process.env.GRAPHAGENT_TEST_HOME = path.join(dir, ".home")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.GRAPHAGENT_TEST_HOME = home
        }),
      )

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "graphagent" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const result = yield* tool.execute({ name: "git-workflow" }, { ...baseCtx, ask: () => Effect.void })

      expect(result.output).toContain(`<skill_content name="git-workflow">`)
      expect(result.output).not.toContain("Base directory for this skill")
      expect(result.output).not.toContain("<skill_files>")
      expect(result.metadata.dir).toBe("/builtin")
    }),
  )

  it.instance("execute preserves not found message", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const home = process.env.GRAPHAGENT_TEST_HOME
      // Keep the isolated user home distinct from the project root: a root
      // that equals $HOME carries no project layer.
      process.env.GRAPHAGENT_TEST_HOME = path.join(dir, ".home")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.GRAPHAGENT_TEST_HOME = home
        }),
      )

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "graphagent" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const exit = yield* tool
        .execute(
          { name: "missing-skill" },
          {
            ...baseCtx,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error) expect(error.message).toContain('Skill "missing-skill" not found.')
      }
    }),
  )

  it.instance("execute header carries the body size and the metadata carries its hash", () =>
    Effect.gen(function* () {
      yield* isolateHome((yield* TestInstance).directory)
      const tool = yield* skillTool
      const builtin = BUILTIN_SKILLS.find((item) => item.name === "git-workflow")
      if (!builtin) throw new Error("git-workflow builtin missing")
      const bytes = Buffer.byteLength(builtin.content.trim())

      const result = yield* tool.execute({ name: "git-workflow" }, { ...baseCtx, ask: () => Effect.void })

      const lines = result.output.split("\n")
      expect(lines[0]).toBe(`<skill_content name="git-workflow">`)
      expect(lines[1]).toBe(`# Skill: git-workflow (${bytes} bytes)`)
      expect(result.output).toContain(builtin.content.trim())
      expect(result.metadata.bytes).toBe(bytes)
      expect(result.metadata.hash).toBe(Hash.sha256(builtin.content).slice(0, 16))
      expect(result.metadata.alreadyLoaded).toBeUndefined()
    }),
  )

  it.instance("execute returns a short receipt when the same body is still in the conversation", () =>
    Effect.gen(function* () {
      yield* isolateHome((yield* TestInstance).directory)
      const tool = yield* skillTool
      const first = yield* tool.execute(
        { name: "git-workflow" },
        { ...baseCtx, callID: "call-1", ask: () => Effect.void },
      )
      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []

      const second = yield* tool.execute(
        { name: "git-workflow" },
        {
          ...baseCtx,
          callID: "call-2",
          messages: [skillHistory({ callID: "call-1", name: "git-workflow", hash: first.metadata.hash })],
          ask: (req) =>
            Effect.sync(() => {
              requests.push(req)
            }),
        },
      )

      expect(second.output).toBe(
        `Skill "git-workflow" is already loaded in this conversation (${first.metadata.bytes} bytes). Its instructions are earlier in the conversation; do not load it again.`,
      )
      expect(second.title).toBe("Skill already loaded: git-workflow")
      expect(second.metadata).toMatchObject({
        name: "git-workflow",
        dir: "/builtin",
        bytes: first.metadata.bytes,
        hash: first.metadata.hash,
        alreadyLoaded: true,
      })
      // The receipt path still asks for the skill permission.
      expect(requests).toHaveLength(1)
      expect(requests[0].permission).toBe("skill")
      expect(requests[0].patterns).toContain("git-workflow")
    }),
  )

  it.instance("execute returns the full body when the earlier load cannot count", () =>
    Effect.gen(function* () {
      yield* isolateHome((yield* TestInstance).directory)
      const tool = yield* skillTool
      const first = yield* tool.execute(
        { name: "git-workflow" },
        { ...baseCtx, callID: "call-1", ask: () => Effect.void },
      )
      const hash = String(first.metadata.hash)

      const cases: Array<[string, SessionV1.WithParts]> = [
        ["pruned", skillHistory({ callID: "call-1", name: "git-workflow", hash, compacted: 5 })],
        ["different hash", skillHistory({ callID: "call-1", name: "git-workflow", hash: "0000000000000000" })],
        ["same call", skillHistory({ callID: "call-2", name: "git-workflow", hash })],
        ["different skill", skillHistory({ callID: "call-1", name: "dag-auto", hash })],
        ["earlier receipt", skillHistory({ callID: "call-1", name: "git-workflow", hash, receipt: true })],
        ["still running", skillHistory({ callID: "call-1", name: "git-workflow", hash, status: "running" })],
        ["truncated output", skillHistory({ callID: "call-1", name: "git-workflow", hash, truncated: true })],
        // No tool call settled in the message that ended with a provider error, so the model wire drops it whole.
        [
          "unsettled call, provider error ending",
          skillHistory({ callID: "call-1", name: "git-workflow", hash, status: "running", error: "provider" }),
        ],
      ]
      for (const [label, history] of cases) {
        const again = yield* tool.execute(
          { name: "git-workflow" },
          { ...baseCtx, callID: "call-2", messages: [history], ask: () => Effect.void },
        )
        expect([label, again.output]).toEqual([label, first.output])
        expect(again.metadata.alreadyLoaded).toBeUndefined()
      }
    }),
  )

  it.instance("execute returns a receipt for a skill on disk and keeps the hook registration", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const skill = path.join(dir, ".agents", "skills", "hooked-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skill, "SKILL.md"),
          `---
name: hooked-skill
description: Skill with frontmatter hooks.
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: "true"
---

# Hooked Skill

Body.
`,
        ),
      )
      yield* isolateHome(dir)
      const tool = yield* skillTool
      const registered: string[] = []
      const hooks = Layer.mock(SettingsHook.Service, {
        registerScoped: (_session, input) =>
          Effect.sync(() => {
            registered.push(input.origin)
          }),
      })

      const first = yield* tool
        .execute({ name: "hooked-skill" }, { ...baseCtx, callID: "call-1", ask: () => Effect.void })
        .pipe(Effect.provide(hooks))
      const second = yield* tool
        .execute(
          { name: "hooked-skill" },
          {
            ...baseCtx,
            callID: "call-2",
            messages: [skillHistory({ callID: "call-1", name: "hooked-skill", hash: first.metadata.hash })],
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.provide(hooks))

      expect(first.output).toContain("<skill_files>")
      expect(second.metadata.alreadyLoaded).toBe(true)
      expect(second.metadata.dir).toBe(skill)
      expect(second.output).not.toContain("<skill_content")
      // Registration is idempotent by origin; it must run on both paths.
      expect(registered).toHaveLength(2)
      expect(new Set(registered).size).toBe(1)
    }),
  )

  it.instance(
    "execute lists only the skills this agent may load when the name is unknown",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, ".agents", "skills", "secret-skill", "SKILL.md"),
            `---
name: secret-skill
description: Denied for every agent.
---

# Secret Skill
`,
          ),
        )
        yield* isolateHome(dir)
        const tool = yield* skillTool

        const exit = yield* tool
          .execute({ name: "missing-skill" }, { ...baseCtx, ask: () => Effect.void })
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Error)
          if (error instanceof Error) {
            expect(error.message).toContain('Skill "missing-skill" not found. Available skills: ')
            expect(error.message).toContain("git-workflow")
            expect(error.message).not.toContain("secret-skill")
          }
        }
      }),
    { config: { permission: { skill: { "secret-skill": "deny" } } } },
  )
})

describe("tool.skill alreadyLoaded", () => {
  const base = { callID: "call-2", name: "git-workflow", hash: "abcdabcdabcdabcd" }
  const earlier = (input: Partial<Parameters<typeof skillHistory>[0]> = {}) =>
    skillHistory({ callID: "call-1", name: base.name, hash: base.hash, ...input })

  test("accepts a completed, unpruned load of the same body from another call", () => {
    expect(alreadyLoaded([earlier()], base.callID, base.name, base.hash)).toBe(true)
  })

  test("finds the load in any message of the history", () => {
    expect(alreadyLoaded([earlier({ name: "dag-auto" }), earlier()], base.callID, base.name, base.hash)).toBe(true)
  })

  test("rejects an empty history", () => {
    expect(alreadyLoaded([], base.callID, base.name, base.hash)).toBe(false)
  })

  test("rejects loads that no longer put the body in context", () => {
    for (const history of [
      earlier({ compacted: 1 }),
      earlier({ hash: "ffffffffffffffff" }),
      earlier({ name: "dag-auto" }),
      earlier({ callID: base.callID }),
      earlier({ receipt: true }),
      earlier({ status: "running" }),
      earlier({ truncated: true }),
    ]) {
      expect(alreadyLoaded([history], base.callID, base.name, base.hash)).toBe(false)
    }
  })

  test("ignores tool parts of other tools", () => {
    expect(alreadyLoaded([earlier({ tool: "read" })], base.callID, base.name, base.hash)).toBe(false)
  })

  test("accepts a load whose message ended with a provider error, since its settled call is replayed", () => {
    expect(alreadyLoaded([earlier({ error: "provider" })], base.callID, base.name, base.hash)).toBe(true)
  })

  test("rejects a load that was still running when its message ended with a provider error", () => {
    expect(alreadyLoaded([earlier({ error: "provider", status: "running" })], base.callID, base.name, base.hash)).toBe(
      false,
    )
  })

  test("counts a load exactly when its output reaches the model wire", async () => {
    const model = ProviderTest.model()
    const shapes: Array<Partial<Parameters<typeof skillHistory>[0]>> = [
      {},
      { error: "provider" },
      { error: "aborted" },
      // Nothing settled in the message that ended with a provider error, so the wire drops it whole.
      { error: "provider", status: "running" },
      { status: "running" },
      { compacted: 1 },
    ]
    const onWire: boolean[] = []
    const counted: boolean[] = []
    for (const shape of shapes) {
      const message = earlier(shape)
      onWire.push(JSON.stringify(await MessageV2.toModelMessages([message], model)).includes(SKILL_BODY))
      counted.push(alreadyLoaded([message], base.callID, base.name, base.hash))
    }
    expect(counted).toEqual(onWire)
    // Both outcomes occur, so the comparison is not vacuous.
    expect(onWire).toEqual([true, true, true, false, false, false])
  })
})
