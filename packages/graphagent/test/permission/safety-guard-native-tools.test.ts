// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { afterEach, expect } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { Permission } from "@/permission"
import { ChildRegistry } from "@/session/child/registry"
import { Instruction } from "@/session/instruction"
import { MessageID, SessionID } from "@/session/schema"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { EditTool } from "@/tool/edit"
import { GlobTool } from "@/tool/glob"
import { GrepTool } from "@/tool/grep"
import { ReadTool } from "@/tool/read"
import type * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "@/tool/write"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * #1031 M7: the real native file tools behind the production Permission layer
 * and its SafetyGuard, for an unattended child run.
 *
 * write, edit and read send `path.relative(worktree, filepath)` as the
 * permission pattern, which folds `link/..` away, while they go through the
 * absolute path they were given, which the kernel resolves link first. The
 * guard has to judge the second, and these cases prove the file is never
 * written, never opened. grep and glob report the path they search next to
 * their arguments, and apply_patch resolves every path before it asks and
 * before it writes, so its patterns are where the files really land.
 */

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Permission.defaultLayer,
    Database.defaultLayer,
    LSP.defaultLayer,
    FSUtil.defaultLayer,
    EventV2Bridge.defaultLayer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Instruction.defaultLayer,
    Ripgrep.defaultLayer,
    Git.defaultLayer,
  ),
)

const rootSessionID = SessionID.make("ses_safety_native_root")

/** A registered unattended run: every ask it raises is adjudicated, none reaches a user. */
const makeRun = (label: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const childSessionID = SessionID.make(`ses_safety_native_${label}`)
      const owner = { kind: "dag_node" as const, workflowID: "dag_unused", nodeID: "n01", attempt: 0 }
      const entry = ChildRegistry.create({
        id: `crun_safety_native_${label}`,
        childSessionID,
        parentSessionID: rootSessionID,
        ownerKind: owner.kind,
        ownerKey: owner,
        permission: { ask: "auto" },
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)
      return { entry, childSessionID }
    }),
    ({ entry }) =>
      Effect.sync(() => {
        ChildRegistry.end(entry, { type: "completed" })
        ChildRegistry.release(entry)
      }),
  )

/** The tool context a session builds: `ask` is the Permission service asking for the run's session. */
const contextOf = Effect.fn("SafetyGuardNativeTools.context")(function* (label: string) {
  const { childSessionID } = yield* makeRun(label)
  const permission = yield* Permission.Service
  const context: Tool.Context = {
    sessionID: childSessionID,
    messageID: MessageID.make(`msg_safety_native_${label}`),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      permission.ask({ ...request, sessionID: childSessionID, ruleset: [] }).pipe(Effect.orDie, Effect.asVoid),
  }
  return context
})

/** The project directory and a scratch directory beside it, outside the project. */
const withOutside = Effect.gen(function* () {
  const directory = yield* InstanceState.directory
  const outside = yield* Effect.promise(() => fs.realpath(os.tmpdir())).pipe(
    Effect.flatMap((tmp) => Effect.promise(() => fs.mkdtemp(path.join(tmp, "safety-native-")))),
  )
  yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(outside, { recursive: true, force: true })))
  return { directory, outside }
})

/** A project directory with `link` pointing at `<outside>/child`, so `link/..` is `<outside>` on disk. */
const withLink = Effect.gen(function* () {
  const { directory, outside } = yield* withOutside
  yield* Effect.promise(() => fs.mkdir(path.join(outside, "child")))
  yield* Effect.promise(() => fs.symlink(path.join(outside, "child"), path.join(directory, "link"), "dir"))
  yield* Effect.promise(() => fs.mkdir(path.join(directory, "sub")))
  return { directory, outside }
})

/**
 * A project directory beside a credential directory: `link` points at
 * `<outside>/.ssh/child`, so `link/..` is the credential directory on disk,
 * `keys` is a link to it and `elsewhere` one to an ordinary directory. `sub`
 * holds an ordinary file and a key file that both match "needle".
 */
const withCredentials = Effect.gen(function* () {
  const { directory, outside } = yield* withOutside
  const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))
  yield* Effect.promise(() => fs.mkdir(path.join(outside, ".ssh", "child"), { recursive: true }))
  yield* Effect.promise(() => fs.mkdir(path.join(outside, "plain")))
  yield* write(path.join(outside, ".ssh", "config"), "Host secret needle\n")
  yield* Effect.promise(() => fs.symlink(path.join(outside, ".ssh", "child"), path.join(directory, "link"), "dir"))
  yield* Effect.promise(() => fs.symlink(path.join(outside, ".ssh"), path.join(directory, "keys"), "dir"))
  yield* Effect.promise(() => fs.symlink(path.join(outside, "plain"), path.join(directory, "elsewhere"), "dir"))
  yield* Effect.promise(() => fs.mkdir(path.join(directory, "sub")))
  yield* write(path.join(directory, "sub", "note.txt"), "an ordinary needle\n")
  yield* write(path.join(directory, "sub", "server.pem"), "a key needle\n")
  return { directory, outside }
})

const exists = (file: string) =>
  Effect.promise(() =>
    fs.stat(file).then(
      () => true,
      () => false,
    ),
  )

const denied = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* effect.pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    return Exit.isFailure(exit) ? String(exit.cause) : ""
  })

it.instance(
  "the write tool through link/.. is refused before it touches the file outside the project",
  () =>
    Effect.gen(function* () {
      const { directory, outside } = yield* withLink
      const context = yield* contextOf("write")
      const tool = yield* (yield* WriteTool).init()

      // On disk this is `<outside>/victim`; the permission pattern it produces is `victim`.
      const cause = yield* denied(tool.execute({ filePath: `${directory}/link/../victim`, content: "pwned" }, context))
      expect(cause).toContain("dag_safety:SF-1")
      expect(yield* exists(path.join(outside, "victim"))).toBe(false)
      expect(yield* exists(path.join(directory, "victim"))).toBe(false)

      // Without a link in the way the same spelling is an ordinary write.
      yield* tool.execute({ filePath: `${directory}/sub/../ok.txt`, content: "fine" }, context)
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "ok.txt"), "utf-8"))).toBe("fine")
    }),
  { git: true },
)

it.instance(
  "the edit tool through link/.. is refused before it rewrites the file outside the project",
  () =>
    Effect.gen(function* () {
      const { directory, outside } = yield* withLink
      const context = yield* contextOf("edit")
      const tool = yield* (yield* EditTool).init()
      yield* Effect.promise(() => fs.writeFile(path.join(outside, "victim"), "old"))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "ok.txt"), "old"))

      const cause = yield* denied(
        tool.execute({ filePath: `${directory}/link/../victim`, oldString: "old", newString: "new" }, context),
      )
      expect(cause).toContain("dag_safety:SF-1")
      expect(yield* Effect.promise(() => fs.readFile(path.join(outside, "victim"), "utf-8"))).toBe("old")

      yield* tool.execute({ filePath: `${directory}/sub/../ok.txt`, oldString: "old", newString: "new" }, context)
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "ok.txt"), "utf-8"))).toBe("new")
    }),
  { git: true },
)

it.instance(
  "the apply_patch tool resolves link/.. itself, so the path it asks about is the one it writes",
  () =>
    Effect.gen(function* () {
      const { directory, outside } = yield* withLink
      const context = yield* contextOf("patch")
      const tool = yield* (yield* ApplyPatchTool).init()
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "sub", "a.txt"), "a\n"))
      const patch = (...lines: string[]) => ({ patchText: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") })

      // `link/../patched.txt` is `<project>/patched.txt` after the tool's own resolution,
      // never `<outside>/patched.txt`: nothing outside is touched, nothing inside is refused.
      yield* tool.execute(patch("*** Add File: link/../patched.txt", "+hello"), context)
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "patched.txt"), "utf-8"))).toBe("hello\n")
      expect(yield* exists(path.join(outside, "patched.txt"))).toBe(false)

      // Through the link itself the file would land outside: refused, nothing written.
      const direct = yield* denied(tool.execute(patch("*** Add File: link/escape.txt", "+pwned"), context))
      expect(direct).toContain("dag_safety:SF-1")
      expect(yield* exists(path.join(outside, "child", "escape.txt"))).toBe(false)

      // A move destination through the link is refused as well, and the source stays.
      const move = yield* denied(
        tool.execute(patch("*** Update File: sub/a.txt", "*** Move to: link/moved.txt", "@@", "-a", "+b"), context),
      )
      expect(move).toContain("dag_safety:SF-1")
      expect(yield* exists(path.join(outside, "child", "moved.txt"))).toBe(false)
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "sub", "a.txt"), "utf-8"))).toBe("a\n")
    }),
  { git: true },
)

it.instance(
  "a write through a symlink to a file that does not exist yet is refused before the file is created outside",
  () =>
    Effect.gen(function* () {
      const { directory, outside } = yield* withOutside
      const context = yield* contextOf("dangling")
      const write = yield* (yield* WriteTool).init()
      const edit = yield* (yield* EditTool).init()
      const patch = yield* (yield* ApplyPatchTool).init()
      // Neither target exists, so `realpath` calls both links missing; opening
      // one for writing creates the file its target names.
      yield* Effect.promise(() => fs.symlink(path.join(outside, "newfile"), path.join(directory, "dl")))
      yield* Effect.promise(() => fs.symlink(path.join(directory, "new.txt"), path.join(directory, "dl2")))

      const refused = [
        yield* denied(write.execute({ filePath: `${directory}/dl`, content: "pwned" }, context)),
        // A relative path resolves against the project directory to the same link.
        yield* denied(write.execute({ filePath: "dl", content: "pwned" }, context)),
        // The edit tool creates the file when `oldString` is empty.
        yield* denied(edit.execute({ filePath: `${directory}/dl`, oldString: "", newString: "pwned" }, context)),
        yield* denied(
          patch.execute({ patchText: "*** Begin Patch\n*** Add File: dl\n+pwned\n*** End Patch" }, context),
        ),
      ]
      for (const cause of refused) expect(cause).toContain("dag_safety:SF-1")
      expect(yield* exists(path.join(outside, "newfile"))).toBe(false)

      // The same link into the project is an ordinary new file, created through it.
      yield* write.execute({ filePath: `${directory}/dl2`, content: "fine" }, context)
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "new.txt"), "utf-8"))).toBe("fine")
    }),
  { git: true },
)

it.instance(
  "the read tool through link/.. is refused before it opens the credential file the kernel resolves",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* withCredentials
      const context = yield* contextOf("read")
      const tool = yield* (yield* ReadTool).init()

      // On disk this is `<outside>/.ssh/config`; the permission pattern it produces is `config`.
      const cause = yield* denied(tool.execute({ filePath: `${directory}/link/../config` }, context))
      expect(cause).toContain("dag_safety:SF-2")

      // Without a link in the way the same spelling is an ordinary read.
      const read = yield* tool.execute({ filePath: `${directory}/sub/../sub/note.txt` }, context)
      expect(read.output).toContain("an ordinary needle")
    }),
  { git: true },
)

it.instance(
  "the grep tool is refused where its search path reaches a credential directory, and lets ordinary paths and exclusions through",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* withCredentials
      const context = yield* contextOf("grep")
      const tool = yield* (yield* GrepTool).init()
      const search = (params: { path?: string; include?: string }) =>
        tool.execute({ pattern: "needle", ...params }, context)

      // The kernel reads `link/..` as `<outside>/.ssh`.
      expect(yield* denied(search({ path: `${directory}/link/..` }))).toContain("dag_safety:SF-2")
      // The tool folds the path before it searches: this is `<project>/keys`, a link to the credential directory.
      expect(yield* denied(search({ path: `${directory}/elsewhere/../keys` }))).toContain("dag_safety:SF-2")
      // A positive include of key files.
      expect(yield* denied(search({ path: "sub", include: "*.pem" }))).toContain("dag_safety:SF-2")

      // A relative path is folded by the tool: `link/../sub` searches `<project>/sub`.
      expect((yield* search({ path: "link/../sub" })).output).toContain("note.txt")
      // `!` makes the include an exclusion: it leaves the key file out, it does not select it.
      const excluded = yield* search({ path: `${directory}/sub/../sub`, include: "!*.pem" })
      expect(excluded.output).toContain("note.txt")
      expect(excluded.output).not.toContain("server.pem")
    }),
  { git: true },
)

it.instance(
  "the glob tool is refused where its search path reaches a credential directory, and lets ordinary paths through",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* withCredentials
      const context = yield* contextOf("glob")
      const tool = yield* (yield* GlobTool).init()
      const list = (searchPath: string) => tool.execute({ pattern: "*", path: searchPath }, context)

      expect(yield* denied(list(`${directory}/link/..`))).toContain("dag_safety:SF-2")
      expect(yield* denied(list(`${directory}/elsewhere/../keys`))).toContain("dag_safety:SF-2")

      // A relative path is folded by the tool: `link/../sub` lists `<project>/sub`.
      expect((yield* list("link/../sub")).output).toContain("note.txt")
      expect((yield* list(`${directory}/sub/../sub`)).output).toContain("note.txt")
    }),
  { git: true },
)
