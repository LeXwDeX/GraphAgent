import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { HookRewake } from "@/hook/rewake"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { SessionID } from "@/session/schema"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const original = process.env.OPENCODE_HOOKS_REQUIRE_TRUST
afterEach(() => {
  if (original === undefined) delete process.env.OPENCODE_HOOKS_REQUIRE_TRUST
  else process.env.OPENCODE_HOOKS_REQUIRE_TRUST = original
})
const it = testEffect(
  SettingsHook.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provideMerge(SessionHooks.defaultLayer),
  ),
)

// Global.Path points into the suite's isolated XDG fixture, never the user's data.
const restoreFile = (file: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const previous = await fs.readFile(file).catch(() => undefined)
      await fs.mkdir(path.dirname(file), { recursive: true })
      return previous
    }),
    (previous) =>
      Effect.promise(() => (previous === undefined ? fs.rm(file, { force: true }) : fs.writeFile(file, previous))),
  )
const command = (context: string, extra = {}, exitCode = 0) => ({
  type: "command",
  command: process.execPath,
  args: [
    "-e",
    `console.log(JSON.stringify({hookSpecificOutput:{additionalContext:${JSON.stringify(context)}}}));process.exit(${exitCode})`,
  ],
  ...extra,
})

describe("retired workspace trust compatibility", () => {
  for (const env of [undefined, "0", "1"]) {
    for (const existing of [false, true]) {
      it.instance(
        `legacy env=${env}, existing trust file=${existing}: global and project hooks run without trust`,
        () =>
          Effect.gen(function* () {
            if (env === undefined) delete process.env.OPENCODE_HOOKS_REQUIRE_TRUST
            else process.env.OPENCODE_HOOKS_REQUIRE_TRUST = env
            const instance = yield* TestInstance
            const globalFile = path.join(Global.Path.config, "hooks.json")
            const trustFile = path.join(Global.Path.data, "trusted-workspaces.json")
            yield* restoreFile(globalFile)
            yield* restoreFile(trustFile)
            const oldTrust = '["/old-workspace"]\n'
            yield* Effect.promise(() =>
              existing ? fs.writeFile(trustFile, oldTrust) : fs.rm(trustFile, { force: true }),
            )
            yield* Effect.promise(async () => {
              await fs.writeFile(
                globalFile,
                JSON.stringify({
                  requireTrust: true,
                  allowUntrusted: false,
                  PostToolUse: [{ hooks: [command("GLOBAL_HOOK")] }],
                }),
              )
              await fs.mkdir(path.join(instance.directory, ".opencode"), { recursive: true })
              await fs.writeFile(
                path.join(instance.directory, ".opencode/hooks.json"),
                JSON.stringify({
                  requireTrust: true,
                  allowUntrusted: false,
                  PostToolUse: [
                    {
                      hooks: [
                        command("PROJECT_SYNC"),
                        command("PROJECT_ASYNC", { async: true }),
                        command("PROJECT_REWAKE", { asyncRewake: true }, 2),
                      ],
                    },
                  ],
                }),
              )
            })
            const hooks = yield* SettingsHook.Service
            const sessionID = SessionID.descending()
            const rewakes: string[] = []
            const result = yield* hooks
              .trigger(
                { event: "PostToolUse", toolName: "bash", toolInput: { command: "true" }, toolResponse: {} },
                { sessionID, transcriptPath: "" },
              )
              .pipe(
                Effect.provide(
                  Layer.succeed(
                    HookRewake.Service,
                    HookRewake.Service.of({
                      rewake: (input) =>
                        Effect.sync(() => {
                          rewakes.push(input.text)
                        }),
                    }),
                  ),
                ),
              )
            expect(result.additionalContexts).toEqual(["GLOBAL_HOOK", "PROJECT_SYNC"])
            expect(result.hookErrors).toBeUndefined()
            expect(result.blocked).toBeUndefined()
            yield* pollWithTimeout(
              Effect.sync(() => (rewakes.length ? true : undefined)),
              "project async hook did not rewake",
            )
            expect(rewakes[0]).toContain("PROJECT_REWAKE")
            const contexts: string[] = []
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const result = yield* hooks.drainAsync!(sessionID)
                contexts.push(...result.additionalContexts)
                return contexts.includes("PROJECT_ASYNC") ? true : undefined
              }),
              "project async output was not delivered",
            )
            const persisted = yield* Effect.promise(() => fs.readFile(trustFile, "utf8").catch(() => undefined))
            expect(persisted).toBe(existing ? oldTrust : undefined)
          }),
      )
    }
  }
})
