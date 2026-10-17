import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@/session/session"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { HookLifecycle } from "@/hook/lifecycle"
import { HookFileWatch } from "@/hook/file-watch"
import { HookConfigChange } from "@/hook/config-change"
import { HookCwd } from "@/hook/cwd"
import { InstanceRef } from "@/effect/instance-ref"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const adapter = HookCwd.layer.pipe(
  Layer.provideMerge(Session.defaultLayer),
  Layer.provideMerge(SettingsHook.layer.pipe(Layer.provideMerge(SessionHooks.defaultLayer))),
  Layer.provide(testInstanceStoreLayer),
  Layer.provide(HookLifecycle.defaultLayer),
  Layer.provide(HookFileWatch.defaultLayer),
  Layer.provide(HookConfigChange.defaultLayer),
)
const it = testEffect(
  Layer.mergeAll(adapter, MoveSession.defaultLayer, SessionProjector.defaultLayer, HookFileWatch.defaultLayer),
)
it.instance(
  "real persisted session move executes CwdChanged with new cwd and readable transcript",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const destination = path.join(directory, "nested")
      const audit = path.join(directory, "cwd-audit.jsonl")
      const script = path.join(directory, "cwd-hook.ts")
      yield* Effect.promise(async () => {
        await fs.mkdir(destination)
        await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({...i,actual_cwd:process.cwd(),readable:await Bun.file(i.transcript_path).exists()})+'\\n');`,
        )
        await fs.writeFile(
          path.join(directory, ".opencode/hooks.json"),
          JSON.stringify({ CwdChanged: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }] }),
        )
      })
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      yield* (yield* MoveSession.Service)
        .moveSession({ sessionID: session.id, destination: { directory: AbsolutePath.make(destination) } })
        .pipe(Effect.provideService(InstanceRef, undefined))
      expect((yield* sessions.get(session.id)).directory).toBe(destination)
      const rows = yield* Effect.promise(async () =>
        (await fs.readFile(audit, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        hook_event_name: "CwdChanged",
        session_id: session.id,
        old_cwd: directory,
        new_cwd: destination,
        cwd: destination,
        actual_cwd: destination,
        readable: true,
      })
    }),
  { git: true },
)

function moveWithWatch(input: { cwdOutput?: unknown; seed?: string[] }) {
  return Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const destination = path.join(directory, "nested")
    const audit = path.join(directory, "watch-audit.jsonl")
    const script = path.join(directory, "watch-hook.ts")
    yield* Effect.promise(async () => {
      await fs.mkdir(destination)
      await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
      await fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({event:i.hook_event_name,path:i.file_path})+'\\n');if(i.hook_event_name==='CwdChanged'&&${JSON.stringify(input.cwdOutput !== undefined)})process.stdout.write(${JSON.stringify(JSON.stringify(input.cwdOutput ?? {}))});`,
      )
      const hook = { type: "command", command: process.execPath, args: [script] }
      await fs.writeFile(
        path.join(directory, ".opencode/hooks.json"),
        JSON.stringify({ CwdChanged: [{ hooks: [hook] }], FileChanged: [{ matcher: "watched.*", hooks: [hook] }] }),
      )
    })
    const sessions = yield* Session.Service
    const session = yield* sessions.create({})
    yield* (yield* HookFileWatch.Service).replace(session.id, input.seed ?? ["watched.txt"], () => Effect.void)
    yield* (yield* MoveSession.Service)
      .moveSession({ sessionID: session.id, destination: { directory: AbsolutePath.make(destination) } })
      .pipe(Effect.provideService(InstanceRef, undefined))
    yield* Effect.promise(() => fs.writeFile(path.join(destination, "watched.txt"), "changed"))
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1500)))
    const rows: { event: string; path?: string }[] = yield* Effect.promise(async () =>
      (await fs.readFile(audit, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    )
    return { rows, destination }
  })
}

it.instance(
  "CwdChanged without watchPaths keeps the dynamic watch list and rebinds it to the new directory",
  () =>
    Effect.gen(function* () {
      const { rows, destination } = yield* moveWithWatch({})
      expect(rows.map((row) => row.event)).toEqual(["CwdChanged", "FileChanged"])
      expect(rows[1]?.path).toBe(path.join(destination, "watched.txt"))
    }),
  { git: true },
)

it.instance(
  "CwdChanged with an empty watchPaths array clears the dynamic watch list",
  () =>
    Effect.gen(function* () {
      const { rows } = yield* moveWithWatch({
        cwdOutput: { hookSpecificOutput: { hookEventName: "CwdChanged", watchPaths: [] } },
      })
      expect(rows.map((row) => row.event)).toEqual(["CwdChanged"])
    }),
  { git: true },
)

import { $ } from "bun"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"
cliIt.live("real HTTP move migrates dynamic FileChanged ownership past old directory disposal", ({ home, opencode }) =>
  Effect.gen(function* () {
    const destination = path.join(home, "moved")
    const watched = path.join(destination, "external.txt")
    const audit = path.join(home, "move-http-audit.jsonl")
    const script = path.join(home, "move-http-hook.ts")
    yield* Effect.promise(async () => {
      await $`git init`.cwd(home).quiet()
      await $`git config commit.gpgsign false`.cwd(home).quiet()
      await $`git -c user.name=Test -c user.email=test@example.test commit --allow-empty -m fixture`.cwd(home).quiet()
      await fs.mkdir(destination)
      await fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({event:i.hook_event_name,session:i.session_id,cwd:i.cwd,path:i.file_path,old:i.old_cwd,new:i.new_cwd,old_env:process.env.HOOK_OLD_DIRECTORY_VALUE,readable:await Bun.file(i.transcript_path).exists()})+'\\n');if(i.hook_event_name==='SessionStart')await fs.appendFile(process.env.CLAUDE_ENV_FILE,'export HOOK_OLD_DIRECTORY_VALUE=old-directory\\n');if(i.hook_event_name==='CwdChanged')await fs.appendFile(process.env.CLAUDE_ENV_FILE,'export HOOK_NEW_DIRECTORY_VALUE=new-directory\\n');if(i.hook_event_name==='CwdChanged')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'CwdChanged',watchPaths:[${JSON.stringify(watched)}]}}));if(i.hook_event_name==='ConfigChange')process.stdout.write(JSON.stringify({decision:'block',reason:'moved config guard'}));`,
      )
      const hook = { type: "command", command: process.execPath, args: [script] }
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          SessionStart: [{ matcher: "startup", hooks: [hook] }],
          CwdChanged: [{ hooks: [hook] }],
          FileChanged: [{ hooks: [hook] }],
          ConfigChange: [{ hooks: [hook] }],
        }),
      )
    })
    const server = yield* opencode.serve()
    const headers = { "content-type": "application/json", "x-opencode-directory": home }
    const session = yield* Effect.promise(async () => {
      const response = await fetch(server.url + "/session", { method: "POST", headers, body: "{}" })
      expect(response.status).toBe(200)
      return response.json()
    })
    yield* Effect.promise(async () => {
      const response = await fetch(server.url + "/experimental/control-plane/move-session", {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionID: session.id, destination: { directory: destination } }),
      })
      expect(response.status).toBe(204)
      const movedAudit = (await fs.readFile(audit, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(movedAudit.map((row) => row.event)).toEqual(["SessionStart", "CwdChanged"])
      expect(movedAudit.at(-1).old_env).toBe("old-directory")
      const disposed = await fetch(server.url + "/instance/dispose", { method: "POST", headers })
      expect(disposed.status).toBe(200)
      await fs.writeFile(watched, "external write after old scope disposal")
    })
    const rows = yield* pollWithTimeout(
      Effect.promise(async () => {
        const text = await fs.readFile(audit, "utf8").catch(() => "")
        const rows = text.trim()
          ? text
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : []
        return rows.some((row) => row.event === "FileChanged") ? rows : undefined
      }),
      "moved session watcher did not survive old scope disposal",
      "10 seconds",
    )
    yield* Effect.promise(async () => {
      const response = await fetch(server.url + `/session/${session.id}/shell`, {
        method: "POST",
        headers: { ...headers, "x-opencode-directory": destination },
        body: JSON.stringify({
          agent: "build",
          command: 'printf "%s|%s" "${HOOK_OLD_DIRECTORY_VALUE-unset}" "${HOOK_NEW_DIRECTORY_VALUE-unset}"',
        }),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("old-directory|new-directory")
    })
    yield* Effect.promise(async () => {
      const response = await fetch(server.url + "/config", {
        method: "PATCH",
        headers: { ...headers, "x-opencode-directory": destination },
        body: JSON.stringify({ username: "must remain blocked after move" }),
      })
      expect(response.status).toBe(400)
      const records = (await fs.readFile(audit, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(records.filter((row) => row.event === "ConfigChange")).toEqual([
        expect.objectContaining({ session: session.id, readable: true }),
      ])
    })
    const canonicalHome = yield* Effect.promise(() => fs.realpath(home))
    const canonicalDestination = yield* Effect.promise(() => fs.realpath(destination))
    expect(rows.filter((row) => row.event === "CwdChanged")).toEqual([
      expect.objectContaining({
        session: session.id,
        cwd: canonicalDestination,
        old: canonicalHome,
        new: destination,
        readable: true,
      }),
    ])
    expect(rows.filter((row) => row.event === "FileChanged")).toEqual([
      expect.objectContaining({ session: session.id, cwd: canonicalDestination, path: watched, readable: true }),
    ])
  }),
)
