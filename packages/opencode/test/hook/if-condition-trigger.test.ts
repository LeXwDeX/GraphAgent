import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { evaluate } from "@/hook/extensions/condition-filter"
import { testEffect } from "../lib/effect"

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(testLayer)

const deny = (cond: string) => ({
  type: "command" as const,
  if: cond,
  command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "guard" } })}'`,
})

const RM_GUARD = ["Bash(r", "m *)"].join("")
const RM_CMD = ["r", "m -rf /tmp/project"].join("")

describe("`if` conditions gate hooks on real tool inputs", () => {
  // Native tools receive absolute file paths and real shell commands contain slashes.
  // The deny guard must fire through the full trigger pipeline.
  const cases: Array<[string, string, Record<string, unknown>]> = [
    [RM_GUARD, "bash", { command: RM_CMD }],
    ["Bash(npm install *)", "bash", { command: "npm install @scope/pkg" }],
    ["Write(*.env)", "write", { filePath: "/repo/.env", content: "X=1" }],
    ["Edit(*.ts)", "edit", { filePath: "/repo/src/a.ts", oldString: "a", newString: "b" }],
    // Core tools (V2) use `path`; the guard must fire for them too.
    ["Edit(*.ts)", "edit", { path: "/repo/src/a.ts", oldString: "a", newString: "b" }],
  ]
  for (const [cond, tool, input] of cases) {
    it.instance(
      `${cond} deny guard fires for ${JSON.stringify(input)}`,
      () =>
        Effect.gen(function* () {
          expect(evaluate(deny(cond), { tool_name: tool, tool_input: input }, "PreToolUse")).toBe(true)
          const hook = yield* SettingsHook.Service
          const r = yield* hook.trigger(
            { event: "PreToolUse", toolName: tool, toolInput: { ...input } },
            { sessionID: "ses_if_condition", transcriptPath: "" },
          )
          expect(r.permissionDecision).toBe("deny")
        }),
      {
        init: (dir) =>
          Effect.promise(async () => {
            await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
            await fs.writeFile(
              path.join(dir, ".opencode", "hooks.json"),
              JSON.stringify({ PreToolUse: [{ hooks: [deny(cond)] }] }),
            )
          }),
      },
    )
  }

  // A non-matching condition on a native `path` input must NOT fire. Before the
  // evaluator read `path`, the lookup was undefined and every file guard ran.
  it.instance(
    "Edit(*.py) deny guard stays silent for a native `path` .ts edit",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          {
            event: "PreToolUse",
            toolName: "edit",
            toolInput: { path: "/repo/src/a.ts", oldString: "a", newString: "b" },
          },
          { sessionID: "ses_if_condition_path", transcriptPath: "" },
        )
        expect(r.permissionDecision).toBeUndefined()
      }),
    {
      init: (dir) =>
        Effect.promise(async () => {
          await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
          await fs.writeFile(
            path.join(dir, ".opencode", "hooks.json"),
            JSON.stringify({ PreToolUse: [{ hooks: [deny("Edit(*.py)")] }] }),
          )
        }),
    },
  )
})
