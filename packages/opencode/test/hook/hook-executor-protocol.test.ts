import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SettingsHook, type HookPayload } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect, pollWithTimeout } from "../lib/effect"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const layer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(layer)

describe("hook command executor protocol", () => {
  it.instance("Stop and SubagentStop can repeat the same context on successive turns", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const childID = SessionID.descending()
      for (const event of ["Stop", "SubagentStop"] as const) {
        yield* store.add(sessionID, {
          event,
          hooks: [
            {
              type: "command",
              command: "node",
              args: [
                "-e",
                `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:${JSON.stringify(event)},additionalContext:'continue'}}))`,
              ],
            },
          ],
        })
        const payload: HookPayload =
          event === "Stop" ? { event, stopHookActive: false } : { event, stopHookActive: false, agentID: childID }
        expect((yield* hook.trigger(payload, { sessionID, transcriptPath: "" })).additionalContexts).toEqual([
          "continue",
        ])
        expect((yield* hook.trigger(payload, { sessionID, transcriptPath: "" })).additionalContexts).toEqual([
          "continue",
        ])
      }
    }),
  )

  it.instance("exec form keeps each argument literal and delivers the JSON decision", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const literal = "a'b $HOME *.ts"
      yield* store.add(sessionID, {
        event: "UserPromptSubmit",
        hooks: [
          {
            type: "command",
            command: "node",
            args: [
              "-e",
              "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:process.argv[1]}}))",
              literal,
            ],
          },
        ],
      })
      const result = yield* hook.trigger(
        { event: "UserPromptSubmit", prompt: "hello" },
        { sessionID, transcriptPath: "" },
      )
      expect(result.additionalContexts).toEqual([literal])
    }),
  )

  it.instance("session environment changes are applied and unsets reach the command child", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "UserPromptSubmit",
        hooks: [
          {
            type: "command",
            command: process.execPath,
            args: [
              "-e",
              "process.stdout.write(`${process.env.PATH===undefined?'unset':'present'}:${process.env.HOOK_TEST_DELTA}`)",
            ],
          },
        ],
      })
      const result = yield* hook.trigger(
        { event: "UserPromptSubmit", prompt: "hello" },
        { sessionID, transcriptPath: "", environment: { PATH: undefined, HOOK_TEST_DELTA: "applied" } },
      )
      expect(result.additionalContexts).toEqual(["unset:applied"])
    }),
  )

  for (const fixture of [
    {
      name: "a compact JSON line after logs keeps valid nested context beside a malformed system field",
      stdout: `building...\n${JSON.stringify({ systemMessage: 7, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "nested context" } })}\n`,
      expected: ["nested context"],
    },
    {
      name: "pretty JSON alone keeps a valid system field beside malformed nested context",
      stdout: JSON.stringify(
        {
          systemMessage: "system context",
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: 7 },
        },
        null,
        2,
      ),
      expected: ["system context"],
    },
    {
      name: "nonzero exit still parses a standalone JSON line after logs",
      stdout: `checking...\n${JSON.stringify({ systemMessage: "failed check context", hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: 7 } })}\n`,
      expected: ["failed check context"],
      exitCode: 1,
    },
  ]) {
    for (const asyncFlags of [{ async: true }, { asyncRewake: true }] as const) {
      it.instance(`async output ${JSON.stringify(asyncFlags)}: ${fixture.name}`, () =>
        Effect.gen(function* () {
          const store = yield* SessionHooks.Service
          const hook = yield* SettingsHook.Service
          const sessionID = SessionID.descending()
          yield* store.add(sessionID, {
            event: "UserPromptSubmit",
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: [
                  "-e",
                  `process.stdout.write(${JSON.stringify(fixture.stdout)},()=>process.exit(${fixture.exitCode ?? 0}))`,
                ],
                ...asyncFlags,
              },
            ],
          })
          yield* hook.trigger({ event: "UserPromptSubmit", prompt: "go" }, { sessionID, transcriptPath: "" })
          if (!hook.drainAsync) throw new Error("async hook drain is unavailable")
          const result = yield* pollWithTimeout(
            hook
              .drainAsync(sessionID)
              .pipe(Effect.map((queued) => (queued.additionalContexts.length ? queued : undefined))),
            "async hook output was not delivered",
          )
          expect(result.additionalContexts).toEqual(fixture.expected)
          expect(result.systemMessages).toEqual([])
        }),
      )
    }
  }

  it.instance("a timed-out policy command discards buffered JSON and leaves its once registration", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const marker = path.join(os.tmpdir(), `hook-timeout-${crypto.randomUUID()}`)
      const output = {
        systemMessage: "TIMED_OUT_OUTPUT",
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: "PARTIAL" },
      }
      yield* store.add(sessionID, {
        event: "PreToolUse",
        once: true,
        hooks: [
          {
            type: "command",
            command: process.execPath,
            args: [
              "-e",
              `process.stdout.write(${JSON.stringify(JSON.stringify(output))});require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},2000)`,
            ],
            timeout: 0.3,
            onFailure: "block",
          },
        ],
      })
      const result = yield* hook.trigger(
        { event: "PreToolUse", toolName: "Read", toolInput: {} },
        { sessionID, transcriptPath: "" },
      )
      expect(yield* Effect.promise(() => fs.readFile(marker, "utf8"))).toBe("started")
      expect(result.blocked?.reason).toContain("onFailure")
      expect(result.permissionDecision).toBeUndefined()
      expect(result.additionalContexts).toEqual([])
      expect(result.systemMessages).toEqual([])
      expect(yield* store.list(sessionID, "PreToolUse")).toHaveLength(1)
      yield* Effect.promise(() => fs.rm(marker, { force: true }))
    }),
  )

  it.instance("ordinary async feedback is queued before its once group retires", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "UserPromptSubmit",
        once: true,
        hooks: [
          {
            type: "command",
            command: process.execPath,
            args: [
              "-e",
              `process.stdout.write(${JSON.stringify(JSON.stringify({ systemMessage: "READY", hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "CONTEXT" } }))})`,
            ],
            async: true,
          },
        ],
      })
      yield* hook.trigger({ event: "UserPromptSubmit", prompt: "go" }, { sessionID, transcriptPath: "" })
      yield* pollWithTimeout(
        store
          .list(sessionID, "UserPromptSubmit")
          .pipe(Effect.map((entries) => (entries.length === 0 ? true : undefined))),
        "ordinary async once group did not retire",
      )
      expect((yield* hook.drainAsync!(sessionID)).additionalContexts).toEqual(["READY", "CONTEXT"])
    }),
  )

  it.instance(
    "onFailure blocks a failing policy process, while PermissionRequest exit 2 leaves approval unchanged",
    () =>
      Effect.gen(function* () {
        const store = yield* SessionHooks.Service
        const hook = yield* SettingsHook.Service
        const sessionID = SessionID.descending()
        yield* store.add(sessionID, {
          event: "PreToolUse",
          hooks: [{ type: "command", command: "node", args: ["-e", "process.exit(1)"], onFailure: "block" }],
        })
        const blocked = yield* hook.trigger(
          { event: "PreToolUse", toolName: "Bash", toolInput: { command: "pwd" } },
          { sessionID, transcriptPath: "" },
        )
        expect(blocked.blocked?.reason).toContain("onFailure")

        yield* store.add(sessionID, {
          event: "PermissionRequest",
          hooks: [{ type: "command", command: "node", args: ["-e", "process.stderr.write('no');process.exit(2)"] }],
        })
        const permission = yield* hook.trigger(
          { event: "PermissionRequest", toolName: "Bash", toolInput: { command: "pwd" } },
          { sessionID, transcriptPath: "" },
        )
        expect(permission.blocked).toBeUndefined()
        expect(permission.permissionRequestDecision).toBeUndefined()
      }),
  )

  it.instance("PostToolUse preserves null output replacement by property presence", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "PostToolUse",
        hooks: [
          {
            type: "command",
            command: "node",
            args: [
              "-e",
              "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',updatedToolOutput:null}}))",
            ],
          },
        ],
      })
      const result = yield* hook.trigger(
        { event: "PostToolUse", toolName: "Read", toolInput: {}, toolResponse: "old" },
        { sessionID, transcriptPath: "" },
      )
      expect(Object.hasOwn(result, "updatedToolOutput")).toBe(true)
      expect(result.updatedToolOutput).toBeNull()
    }),
  )

  it.instance("ordinary async output drains on a later turn without rewaking", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "PostToolUse",
        hooks: [
          {
            type: "command",
            command: "node",
            args: [
              "-e",
              "setTimeout(()=>process.stdout.write(JSON.stringify({systemMessage:'later',hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'context'}})),30)",
            ],
            async: true,
          },
        ],
      })
      const immediate = yield* hook.trigger(
        { event: "PostToolUse", toolName: "Read", toolInput: {}, toolResponse: "ok" },
        { sessionID, transcriptPath: "" },
      )
      expect(immediate.additionalContexts).toEqual([])
      expect(immediate.systemMessages).toEqual([])
      const completed = yield* pollWithTimeout(
        hook.drainAsync!(sessionID).pipe(Effect.map((value) => (value.additionalContexts.length ? value : undefined))),
        "async output did not reach the next-turn queue",
      )
      expect(completed.additionalContexts).toEqual(["later", "context"])
      expect(completed.systemMessages).toEqual([])
      expect((yield* hook.drainAsync!(sessionID)).additionalContexts).toEqual([])
    }),
  )

  it.instance("observational events discard decision and context output", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const cases: HookPayload[] = [
        { event: "Setup", trigger: "init" },
        { event: "Notification", message: "hello", notificationType: "idle_prompt" },
        { event: "StopFailure", stopHookActive: false, error: "unknown" },
        { event: "MessageDisplay", turnID: "turn", messageID: "message", delta: "hello", index: 0, final: true },
      ]
      for (const payload of cases) {
        const event = payload.event
        yield* store.add(sessionID, {
          event,
          hooks: [
            {
              type: "command",
              command: "node",
              args: [
                "-e",
                "process.stdout.write(JSON.stringify({decision:'block',reason:'bad',continue:false,systemMessage:'bad',hookSpecificOutput:{hookEventName:process.argv[1],additionalContext:'bad'}}))",
                event,
              ],
            },
          ],
        })
        const result = yield* hook.trigger(payload, { sessionID, transcriptPath: "" })
        expect(result.blocked).toBeUndefined()
        expect(result.preventContinuation).toBeUndefined()
        expect(result.systemMessages).toEqual([])
        expect(result.additionalContexts).toEqual([])
      }
    }),
  )

  it.instance(
    "event-specific decisions do not let PreToolUse top-level block or ElicitationResult control unrelated fields",
    () =>
      Effect.gen(function* () {
        const store = yield* SessionHooks.Service
        const hook = yield* SettingsHook.Service
        const sessionID = SessionID.descending()
        yield* store.add(sessionID, {
          event: "PreToolUse",
          hooks: [
            {
              type: "command",
              command: "node",
              args: ["-e", "process.stdout.write(JSON.stringify({decision:'block',reason:'ignored'}))"],
            },
          ],
        })
        const pre = yield* hook.trigger(
          { event: "PreToolUse", toolName: "Bash", toolInput: { command: "pwd" } },
          { sessionID, transcriptPath: "" },
        )
        expect(pre.blocked).toBeUndefined()

        yield* store.add(sessionID, {
          event: "ElicitationResult",
          hooks: [
            {
              type: "command",
              command: "node",
              args: [
                "-e",
                "process.stdout.write(JSON.stringify({continue:false,systemMessage:'discard',hookSpecificOutput:{hookEventName:'ElicitationResult',action:'accept'}}));process.exit(1)",
              ],
            },
          ],
        })
        const elicitation = yield* hook.trigger(
          { event: "ElicitationResult", action: "decline", serverName: "test" },
          { sessionID, transcriptPath: "" },
        )
        expect(elicitation.preventContinuation).toBeUndefined()
        expect(elicitation.systemMessages).toEqual([])
        expect(elicitation.elicitation).toBeUndefined()
      }),
  )

  it.instance("PreModelSwitch timeout refuses the switch", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "PreModelSwitch",
        hooks: [{ type: "command", command: "node", args: ["-e", "setTimeout(()=>{},300)"], timeout: 0.03 }],
      })
      const result = yield* hook.trigger(
        { event: "PreModelSwitch", fromModel: "old", toModel: "new" },
        { sessionID, transcriptPath: "" },
      )
      expect(result.blocked?.reason).toContain("timed out")
    }),
  )

  it.instance("terminalSequence accepts only the documented OSC and BEL controls", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "Notification",
        hooks: [
          {
            type: "command",
            command: "node",
            args: ["-e", "process.stdout.write(JSON.stringify({terminalSequence:'\\u001b]777;notify;Ready\\u0007'}))"],
          },
        ],
      })
      const allowed = yield* hook.trigger(
        { event: "Notification", message: "Ready" },
        { sessionID, transcriptPath: "" },
      )
      expect(allowed.terminalSequences).toEqual(["\u001b]777;notify;Ready\u0007"])

      yield* store.add(sessionID, {
        event: "Notification",
        hooks: [
          {
            type: "command",
            command: "node",
            args: ["-e", "process.stdout.write(JSON.stringify({terminalSequence:'\\u001b]52;c;secret\\u0007'}))"],
          },
        ],
      })
      const denied = yield* hook.trigger({ event: "Notification", message: "Ready" }, { sessionID, transcriptPath: "" })
      expect(denied.terminalSequences).toEqual(["\u001b]777;notify;Ready\u0007"])
    }),
  )

  it.instance("matching foreground handlers run concurrently", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const first = path.join(os.tmpdir(), `hook-parallel-${crypto.randomUUID()}-a`)
      const second = `${first}-b`
      const script =
        "const fs=require('fs');const [self,other,text]=process.argv.slice(1);fs.writeFileSync(self,'x');const start=Date.now();const timer=setInterval(()=>{if(fs.existsSync(other)){clearInterval(timer);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:text}}))}else if(Date.now()-start>500){clearInterval(timer);process.exit(1)}},5)"
      yield* store.add(sessionID, {
        event: "UserPromptSubmit",
        hooks: [
          { type: "command", command: "node", args: ["-e", script, first, second, "first"] },
          { type: "command", command: "node", args: ["-e", script, second, first, "second"] },
        ],
      })
      const result = yield* hook.trigger(
        { event: "UserPromptSubmit", prompt: "hello" },
        { sessionID, transcriptPath: "" },
      )
      expect(result.additionalContexts).toEqual(["first", "second"])
      yield* Effect.promise(() => Promise.all([fs.rm(first, { force: true }), fs.rm(second, { force: true })]))
    }),
  )

  it.instance("WorktreeCreate uses the last non-empty command line and rejects missing paths", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "hook-worktree-"))),
      (directory) =>
        Effect.gen(function* () {
          const store = yield* SessionHooks.Service
          const hook = yield* SettingsHook.Service
          const sessionID = SessionID.descending()
          yield* store.add(sessionID, {
            event: "WorktreeCreate",
            hooks: [
              {
                type: "command",
                command: "node",
                args: ["-e", "process.stdout.write('banner\\n'+process.argv[1]+'\\n')", directory],
              },
            ],
          })
          const created = yield* hook.trigger(
            { event: "WorktreeCreate", name: "example" },
            { sessionID, transcriptPath: "" },
          )
          expect(created.worktreePath).toBe(directory)
          expect(created.blocked).toBeUndefined()
          yield* store.add(sessionID, {
            event: "WorktreeCreate",
            hooks: [{ type: "command", command: "node", args: ["-e", "process.stdout.write('\\n')"] }],
          })
          const missing = yield* hook.trigger(
            { event: "WorktreeCreate", name: "example" },
            { sessionID, transcriptPath: "" },
          )
          expect(missing.blocked?.reason).toContain("no path")
        }),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    ),
  )

  it.instance("WorktreeRemove fails only when a failed hook leaves the path behind", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "hook-worktree-remove-"))),
      (directory) =>
        Effect.gen(function* () {
          const store = yield* SessionHooks.Service
          const hook = yield* SettingsHook.Service
          const sessionID = SessionID.descending()
          const failedHookID = yield* store.add(sessionID, {
            event: "WorktreeRemove",
            hooks: [{ type: "command", command: "node", args: ["-e", "process.exit(1)"] }],
          })
          const retained = yield* hook.trigger(
            { event: "WorktreeRemove", worktreePath: directory },
            { sessionID, transcriptPath: "" },
          )
          expect(retained.worktreeRemoveFailed).toBe(true)
          expect(retained.blocked?.reason).toContain("failed")

          yield* store.remove(sessionID, failedHookID)
          yield* store.add(sessionID, {
            event: "WorktreeRemove",
            hooks: [
              {
                type: "command",
                command: "node",
                args: [
                  "-e",
                  "require('fs').rmSync(process.argv[1],{recursive:true,force:true});process.exit(1)",
                  directory,
                ],
              },
            ],
          })
          const removed = yield* hook.trigger(
            { event: "WorktreeRemove", worktreePath: directory },
            { sessionID, transcriptPath: "" },
          )
          expect(removed.worktreeRemoveFailed).toBeUndefined()
          expect(removed.blocked).toBeUndefined()
        }),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    ),
  )
})
