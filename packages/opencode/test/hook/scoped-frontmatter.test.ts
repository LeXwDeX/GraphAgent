import { afterAll, describe, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(testLayer)
const trustDir = mkdtempSync(path.join(tmpdir(), "scoped-trust-"))
const trustFile = path.join(trustDir, "trusted-workspaces.json")
const accepted = path.join(trustDir, "accepted")
const rejected = path.join(trustDir, "accepted-neighbor")
writeFileSync(trustFile, JSON.stringify([accepted]))
afterAll(() => rmSync(trustDir, { recursive: true, force: true }))
const trustLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.layerWithTrustFile(trustFile)),
)
const itTrust = testEffect(trustLayer)

describe("scoped frontmatter hooks", () => {
  itTrust.instance("project agent frontmatter requires accepted folder trust; skill remains available", () =>
    Effect.gen(function* () {
      const hook = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const sessionID = SessionID.descending()
      const hooks = { Stop: [{ hooks: [{ type: "command", command: "printf accepted" }] }] }
      yield* hook.registerScoped!(sessionID, {
        kind: "agent",
        origin: `agent:${path.join(rejected, "agent", "unsafe.md")}`,
        hooks,
      })
      expect(yield* store.list(sessionID, "Stop")).toHaveLength(0)
      yield* hook.registerScoped!(sessionID, {
        kind: "agent",
        origin: `agent:${path.join(accepted, "agent", "safe.md")}`,
        hooks,
      })
      expect(yield* store.list(sessionID, "Stop")).toHaveLength(1)
      yield* hook.registerScoped!(sessionID, {
        kind: "skill",
        origin: `skill:${path.join(rejected, "SKILL.md")}`,
        hooks,
      })
      expect(yield* store.list(sessionID, "Stop")).toHaveLength(2)
      yield* hook.registerScoped!(sessionID, {
        kind: "agent",
        source: "plugin",
        origin: `agent:${path.join(rejected, "plugin.md")}`,
        hooks,
      })
      expect(yield* store.list(sessionID, "Stop")).toHaveLength(3)
    }),
  )

  it.instance("registers a skill once per origin but keeps separate skill origins", () =>
    Effect.gen(function* () {
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const dir = mkdtempSync(path.join(tmpdir(), "scoped-hooks-"))
      const output = path.join(dir, "runs")
      try {
        const hooks = {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: `printf x >> '${output}'` }] }],
        }
        yield* hook.registerScoped!(sessionID, { kind: "skill", origin: "skill:/a/SKILL.md", hooks })
        yield* hook.registerScoped!(sessionID, { kind: "skill", origin: "skill:/a/SKILL.md", hooks })
        yield* hook.registerScoped!(sessionID, { kind: "skill", origin: "skill:/b/SKILL.md", hooks })
        yield* hook.trigger({ event: "UserPromptSubmit", prompt: "hello" }, { sessionID, transcriptPath: "" })
        expect(readFileSync(output, "utf8")).toBe("xx")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  it.instance("child agent Stop hooks map to SubagentStop only for that child", () =>
    Effect.gen(function* () {
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const main = { Stop: [{ hooks: [{ type: "command", command: "printf main" }] }] }
      const child = { Stop: [{ hooks: [{ type: "command", command: "printf child" }] }] }
      yield* hook.registerScoped!(sessionID, { kind: "agent", source: "builtin", origin: "agent:main", hooks: main })
      yield* hook.registerScoped!(sessionID, {
        kind: "agent",
        source: "builtin",
        origin: "agent:child",
        child: true,
        hooks: child,
      })
      const store = yield* SessionHooks.Service
      expect((yield* store.list(sessionID, "Stop")).map((entry) => entry.origin)).toEqual(["agent:main"])
      expect((yield* store.list(sessionID, "SubagentStop")).map((entry) => entry.origin)).toEqual(["agent:child"])
      yield* hook.unregisterScoped!(sessionID, "agent:child")
      expect(yield* store.list(sessionID, "SubagentStop")).toHaveLength(0)
      expect(yield* store.list(sessionID, "Stop")).toHaveLength(1)
    }),
  )

  it.instance("parent terminal SubagentStop runs only the matching child's scoped hooks", () =>
    Effect.gen(function* () {
      const hook = yield* SettingsHook.Service
      const parentID = SessionID.descending()
      const childID = SessionID.descending()
      const otherID = SessionID.descending()
      const command = (value: string) =>
        `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStop", additionalContext: value } })}'`
      yield* hook.registerScoped!(childID, {
        kind: "agent",
        source: "builtin",
        origin: "agent:child",
        child: true,
        hooks: { Stop: [{ hooks: [{ type: "command", command: command("matching child") }] }] },
      })
      yield* hook.registerScoped!(otherID, {
        kind: "agent",
        source: "builtin",
        origin: "agent:other",
        child: true,
        hooks: { Stop: [{ hooks: [{ type: "command", command: command("other child") }] }] },
      })
      const result = yield* hook.trigger(
        { event: "SubagentStop", stopHookActive: false, agentID: childID },
        { sessionID: parentID, transcriptPath: "" },
      )
      expect(result.additionalContexts).toEqual(["matching child"])
    }),
  )

  it.instance("a failing once registration remains eligible until a successful run", () =>
    Effect.gen(function* () {
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const dir = mkdtempSync(path.join(tmpdir(), "scoped-once-"))
      const attempts = path.join(dir, "attempts")
      try {
        const hooks = {
          UserPromptSubmit: [
            {
              once: true,
              hooks: [
                {
                  type: "command",
                  command: `if test -e '${attempts}'; then printf success; else touch '${attempts}'; exit 1; fi`,
                },
              ],
            },
          ],
        }
        yield* hook.registerScoped!(sessionID, { kind: "skill", origin: "skill:/once/SKILL.md", hooks })
        const store = yield* SessionHooks.Service
        yield* hook.trigger({ event: "UserPromptSubmit", prompt: "first" }, { sessionID, transcriptPath: "" })
        expect(yield* store.list(sessionID, "UserPromptSubmit")).toHaveLength(1)
        const second = yield* hook.trigger(
          { event: "UserPromptSubmit", prompt: "second" },
          { sessionID, transcriptPath: "" },
        )
        expect(second.additionalContexts).toContain("success")
        expect(yield* store.list(sessionID, "UserPromptSubmit")).toHaveLength(0)
        // Loading the same skill again does not reset once for this session.
        yield* hook.registerScoped!(sessionID, { kind: "skill", origin: "skill:/once/SKILL.md", hooks })
        expect(yield* store.list(sessionID, "UserPromptSubmit")).toHaveLength(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  it.instance("concurrent triggers reserve a once command until it settles", () =>
    Effect.gen(function* () {
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const dir = mkdtempSync(path.join(tmpdir(), "scoped-once-race-"))
      const output = path.join(dir, "runs")
      try {
        yield* hook.registerScoped!(sessionID, {
          kind: "skill",
          origin: "skill:/race/SKILL.md",
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: "command", once: true, command: `sleep 0.1; printf x >> '${output}'` }] },
            ],
          },
        })
        yield* Effect.all(
          ["first", "second"].map((prompt) =>
            hook.trigger({ event: "UserPromptSubmit", prompt }, { sessionID, transcriptPath: "" }),
          ),
          { concurrency: "unbounded" },
        )
        expect(readFileSync(output, "utf8")).toBe("x")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  it.instance("model switch matchers canonicalize known Claude IDs and run all on unknown IDs", () =>
    Effect.gen(function* () {
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const dir = mkdtempSync(path.join(tmpdir(), "model-matcher-"))
      const output = path.join(dir, "runs")
      try {
        yield* hook.registerScoped!(sessionID, {
          kind: "skill",
          origin: "skill:/model/SKILL.md",
          hooks: {
            PreModelSwitch: [
              { matcher: "claude-opus-4-6", hooks: [{ type: "command", command: `printf o >> '${output}'` }] },
              { matcher: "claude-sonnet-4-6", hooks: [{ type: "command", command: `printf s >> '${output}'` }] },
            ],
          },
        })
        yield* hook.trigger(
          { event: "PreModelSwitch", fromModel: "old", toModel: "anthropic/claude-opus-4-6-20260901[1m]" },
          { sessionID, transcriptPath: "" },
        )
        expect(readFileSync(output, "utf8")).toBe("o")
        yield* hook.trigger(
          { event: "PreModelSwitch", fromModel: "old", toModel: "qwen/qwen-custom" },
          { sessionID, transcriptPath: "" },
        )
        expect(readFileSync(output, "utf8").slice(1).split("").sort().join("")).toBe("os")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  it.instance("agent frontmatter ignores once while skill frontmatter honors it", () =>
    Effect.gen(function* () {
      const hook = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const sessionID = SessionID.descending()
      const dir = mkdtempSync(path.join(tmpdir(), "agent-once-"))
      const output = path.join(dir, "runs")
      try {
        yield* hook.registerScoped!(sessionID, {
          kind: "agent",
          source: "builtin",
          origin: "agent:main-once",
          hooks: {
            Stop: [{ once: true, hooks: [{ type: "command", once: true, command: `printf x >> '${output}'` }] }],
          },
        })
        for (let index = 0; index < 2; index++)
          yield* hook.trigger({ event: "Stop", stopHookActive: false }, { sessionID, transcriptPath: "" })
        expect(yield* store.list(sessionID, "Stop")).toHaveLength(1)
        expect(readFileSync(output, "utf8")).toBe("xx")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )
})
