import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { SessionTodoHooks } from "@opencode-ai/core/session/todo-hooks"
import { Session } from "@/session/session"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { HookTodo } from "@/hook/todo"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const adapter = HookTodo.layer.pipe(
  Layer.provideMerge(Session.defaultLayer),
  Layer.provide(SettingsHook.layer.pipe(Layer.provide(SessionHooks.defaultLayer))),
  Layer.provide(testInstanceStoreLayer),
)
const it = testEffect(Layer.mergeAll(adapter, SessionTodo.defaultLayer))
for (const veto of ["TaskCreated", "TaskCompleted"] as const) {
  it.instance(`real v2 Todo ${veto} veto uses actual command hooks with restored legacy instance context`, () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const script = path.join(directory, "todo-core-hook.ts")
      const audit = path.join(directory, "todo-core-audit.jsonl")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({event:i.hook_event_name,session:i.session_id,id:i.task_id,readable:await Bun.file(i.transcript_path).exists()})+"\\n");if(i.hook_event_name===${JSON.stringify(veto)}){if(i.hook_event_name==='TaskCreated')process.stdout.write(JSON.stringify({decision:'block',reason:'core creation veto'}));else{process.stderr.write('core completion veto');process.exit(2)}};`,
        )
        const hook = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(directory, ".opencode/hooks.json"),
          JSON.stringify({ TaskCreated: [{ hooks: [hook] }], TaskCompleted: [{ hooks: [hook] }] }),
        )
      })
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const todos = yield* SessionTodo.Service
      const update = {
        sessionID: session.id,
        todos: [{ content: "v2-local-task", status: "completed", priority: "high" }],
      }
      // Reproduce v2's context boundary: no legacy InstanceRef is available to the caller.
      const result = yield* todos.update(update).pipe(Effect.provideService(InstanceRef, undefined), Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(yield* todos.get(session.id)).toEqual([])
      const rows = yield* Effect.promise(async () =>
        (await fs.readFile(audit, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      )
      expect(rows.map((row) => row.event)).toEqual(
        veto === "TaskCreated" ? ["TaskCreated"] : ["TaskCreated", "TaskCompleted"],
      )
      expect(rows.every((row) => row.session === session.id && row.readable)).toBe(true)
      expect(new Set(rows.map((row) => row.id)).size).toBe(1)
      // The stable ID is the same for this v1/v2-compatible bulk task identity.
      expect(rows[0].id).toBe(SessionTodoHooks.identified(session.id, update.todos)[0].id)
      expect((yield* InstanceState.context).directory).toBe(directory)
    }),
  )
}
