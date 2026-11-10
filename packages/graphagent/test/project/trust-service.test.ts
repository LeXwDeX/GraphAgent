// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the instance context and event payload fixtures are narrowed from their producing APIs

import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Deferred, Effect, Layer } from "effect"
import { PROJECT_DIR } from "@graphagent/core/brand"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import { Global } from "@graphagent/core/global"
import { Hash } from "@graphagent/core/util/hash"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { Git } from "@/git"
import { ProjectTrust } from "@/project/trust"
import { TRUST_VERSION, type TrustFile } from "@/project/trust/store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(FSUtil.defaultLayer, Git.defaultLayer, EventV2Bridge.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOOKS = `{
  "PreToolUse": [
    { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./scripts/guard.sh" }] }
  ],
  "Stop": [
    { "hooks": [{ "type": "command", "command": "bun run .agents/check.ts" }] }
  ]
}`

const STOP_HOOK = `{"Stop":[{"hooks":[{"type":"command","command":"./scripts/stop.sh"}]}]}`
const STOP_HOOK_CHANGED = `{"Stop":[{"hooks":[{"type":"command","command":"./scripts/stop-2.sh"}]}]}`

const SETTINGS = `{
  "formatter": { "custom": { "command": ["bun", "run", ".agents/fmt.ts"] } },
  "lsp": { "custom": { "command": ["node", ".agents/lsp.js"] } }
}`

const MCP = `{"mcpServers":{"remote":{"type":"remote","url":"https://mcp.example.com"}}}`

const STOP_ID = "hooks.json|hook|Stop||1"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stateDir = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "trust-service-"))),
  (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
)

function withProject(stateDirectory: string, root: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R | ProjectTrust.Service>) =>
    effect.pipe(
      Effect.provide(ProjectTrust.makeLayer({ stateDirectory })),
      Effect.provideService(InstanceRef, {
        directory: root,
        worktree: root,
        root,
        project: { id: "global" },
      } as never),
    )
}

const writeLayerFile = (root: string, file: string, content: string) =>
  Effect.promise(async () => {
    const target = path.join(root, PROJECT_DIR, ...file.split("/"))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
    return target
  })

const writeProjectFile = (root: string, file: string, content: string) =>
  Effect.promise(async () => {
    const target = path.join(root, ...file.split("/"))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  })

const readTrustFile = (stateDirectory: string) =>
  Effect.promise(async () => {
    const text = await fs.readFile(path.join(stateDirectory, "trust.json"), "utf8")
    return JSON.parse(text) as TrustFile
  })

const trustFileExists = (stateDirectory: string) =>
  Effect.promise(async () => {
    try {
      await fs.stat(path.join(stateDirectory, "trust.json"))
      return true
    } catch {
      return false
    }
  })

const git = (cwd: string, args: string[]) =>
  Effect.gen(function* () {
    const service = yield* Git.Service
    const result = yield* service.run(args, { cwd })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.text()}`)
    return result.text().trim()
  })

interface UpdatedEvent {
  projectID: string
  entries: string[]
  removed: string[]
}

const listenUpdated = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const updated = yield* Deferred.make<UpdatedEvent>()
  const off = yield* events.listen((event) => {
    if (event.type === "project.trust.updated") {
      Deferred.doneUnsafe(updated, Effect.succeed(event.data as UpdatedEvent))
    }
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  return updated
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("ProjectTrust.list", () => {
  it.live("reports no entries when the project has no project layer", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir

      const entries = yield* withProject(state, root)(ProjectTrust.Service.use((trust) => trust.list()))

      expect(entries).toEqual([])
      expect(yield* trustFileExists(state)).toBe(false)
    }),
  )

  it.live("lists new entries with category, source, display, when and risks", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", HOOKS)
      yield* writeLayerFile(root, "settings.json", SETTINGS)
      yield* writeLayerFile(root, "mcp.json", MCP)

      const entries = yield* withProject(state, root)(ProjectTrust.Service.use((trust) => trust.list()))

      expect(entries.map((entry) => entry.id)).toEqual([
        "hooks.json|hook|PreToolUse|Bash|1",
        STOP_ID,
        "mcp.json|mcp|remote||1",
        "settings.json|formatter|custom||1",
        "settings.json|lsp|custom||1",
      ])
      const preToolUse = entries[0]
      expect(preToolUse).toMatchObject({
        category: "hook",
        state: "pending",
        change: "new",
        when: "PreToolUse",
        command: "./scripts/guard.sh",
        source: { file: "hooks.json", line: 3 },
      })
      expect(preToolUse.fp).toMatch(/^[0-9a-f]{64}$/)
      expect(preToolUse.risks).toEqual([])

      const remoteMcp = entries[2]
      expect(remoteMcp).toMatchObject({ category: "mcp", when: "mcp.start", command: "https://mcp.example.com" })
      expect(remoteMcp.risks.map((risk) => risk.code)).toEqual(["external-url", "remote-mcp"])

      expect(entries[3]).toMatchObject({ category: "formatter", when: "formatter.run" })
      expect(entries[4]).toMatchObject({ category: "lsp", when: "lsp.start" })
    }),
  )

  it.live("keeps a recorded location with a matching fingerprint unchanged", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const service = yield* ProjectTrust.Service
        const [entry] = yield* service.list()
        yield* service.decide([{ id: entry.id, state: "trusted" }])
        const [next] = yield* service.list()
        return { entry: entry, next: next }
      })

      const result = yield* trust(program)

      expect(result.next).toMatchObject({ id: STOP_ID, state: "trusted", fp: result.entry.fp })
      expect(result.next.change).toBeUndefined()
      expect(result.next.previous).toBeUndefined()
    }),
  )

  it.live("returns a trusted entry to pending with the previous command after a change", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const service = yield* ProjectTrust.Service
        const [entry] = yield* service.list()
        yield* service.decide([{ id: entry.id, state: "trusted" }])
        yield* writeLayerFile(root, "hooks.json", STOP_HOOK_CHANGED)
        const [next] = yield* service.list()
        return { entry: entry, next: next }
      })

      const result = yield* trust(program)

      expect(result.next).toMatchObject({
        id: STOP_ID,
        state: "pending",
        change: "modified",
        previous: "./scripts/stop.sh",
        command: "./scripts/stop-2.sh",
      })
      expect(result.next.fp).not.toBe(result.entry.fp)
    }),
  )

  it.live("returns a declined entry to pending after a change", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const service = yield* ProjectTrust.Service
        const [entry] = yield* service.list()
        yield* service.decide([{ id: entry.id, state: "declined" }])
        const [declined] = yield* service.list()
        yield* writeLayerFile(root, "hooks.json", STOP_HOOK_CHANGED)
        const [next] = yield* service.list()
        return { declined: declined, next: next }
      })

      const result = yield* trust(program)

      expect(result.declined.state).toBe("declined")
      expect(result.next).toMatchObject({ state: "pending", change: "modified", previous: "./scripts/stop.sh" })
    }),
  )

  it.live("changes the fingerprint and returns the entry to pending when a referenced script changes", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      yield* writeProjectFile(root, "scripts/stop.sh", "echo one\n")
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const service = yield* ProjectTrust.Service
        const [entry] = yield* service.list()
        yield* service.decide([{ id: entry.id, state: "trusted" }])
        yield* writeProjectFile(root, "scripts/stop.sh", "echo two\n")
        const [next] = yield* service.list()
        return { entry: entry, next: next }
      })

      const result = yield* trust(program)

      expect(result.next.state).toBe("pending")
      expect(result.next.change).toBe("modified")
      expect(result.next.fp).not.toBe(result.entry.fp)
    }),
  )

  it.live("treats an untracked local file as user configuration and a tracked one as project entries", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.local.json", STOP_HOOK)
      const program = Effect.gen(function* () {
        const service = yield* ProjectTrust.Service
        const before = yield* service.list()
        yield* git(root, ["add", `${PROJECT_DIR}/hooks.local.json`])
        const after = yield* service.list()
        return { before, after }
      })

      const result = yield* withProject(state, root)(program)

      expect(result.before).toEqual([])
      expect(result.after.map((entry) => entry.id)).toEqual([`hooks.local.json|hook|Stop||1`])
    }),
  )
})

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

describe("ProjectTrust.check", () => {
  it.live("matches a recorded fingerprint and treats a mismatch or a missing record as pending", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const service = yield* ProjectTrust.Service
        const [entry] = yield* service.list()
        const first = yield* service.check(entry.id, entry.fp)
        yield* service.decide([{ id: entry.id, state: "trusted" }])
        const trusted = yield* service.check(entry.id, entry.fp)
        const mismatch = yield* service.check(entry.id, "0".repeat(64))
        const missing = yield* service.check("missing", entry.fp)
        yield* service.decide([{ id: entry.id, state: "declined" }])
        const declined = yield* service.check(entry.id, entry.fp)
        return { first, trusted, mismatch, missing, declined }
      })

      expect(yield* trust(program)).toEqual({
        first: "pending",
        trusted: "trusted",
        mismatch: "pending",
        missing: "pending",
        declined: "declined",
      })
    }),
  )

  it.live("reports pending for $HOME without reading or writing a project record", () =>
    Effect.gen(function* () {
      const state = yield* stateDir
      const home = Global.Path.home

      const value = yield* withProject(
        state,
        home,
      )(
        Effect.gen(function* () {
          const service = yield* ProjectTrust.Service
          const checked = yield* service.check("hooks.json|hook|Stop||1", "f".repeat(64))
          const entries = yield* service.list()
          return { state: checked, entries }
        }),
      )

      expect(value).toEqual({ state: "pending", entries: [] })
      expect(yield* trustFileExists(state)).toBe(false)
    }),
  )
})

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

describe("ProjectTrust.decide", () => {
  it.live("writes trusted and declined records with the current fingerprint, command and display root", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", HOOKS)
      yield* git(root, ["remote", "add", "origin", "https://example.com/repo.git"])
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const service = yield* ProjectTrust.Service
        const entries = yield* service.list()
        yield* service.decide([
          { id: entries[0].id, state: "trusted" },
          { id: entries[1].id, state: "declined" },
        ])
        return entries
      })

      const entries = yield* trust(program)
      const file = yield* readTrustFile(state)
      const id = Hash.sha256(root)

      expect(file.version).toBe(TRUST_VERSION)
      expect(Object.keys(file.projects)).toEqual([id])
      expect(file.projects[id]).toEqual({
        root,
        remote: "https://example.com/repo.git",
        entries: {
          [entries[0].id]: {
            fp: entries[0].fp,
            decision: "trusted",
            decidedAt: expect.any(Number),
            command: "./scripts/guard.sh",
          },
          [entries[1].id]: {
            fp: entries[1].fp,
            decision: "declined",
            decidedAt: expect.any(Number),
            command: "bun run .agents/check.ts",
          },
        },
      })
    }),
  )

  it.live("publishes project.trust.updated after a write", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const updated = yield* listenUpdated
        const service = yield* ProjectTrust.Service
        const [entry] = yield* service.list()
        yield* service.decide([{ id: entry.id, state: "trusted" }])
        return { id: entry.id, event: yield* Deferred.await(updated) }
      })

      const result = yield* trust(program)

      expect(result.event).toEqual({ projectID: Hash.sha256(root), entries: [result.id], removed: [] })
    }),
  )

  it.live("revokes a record and reports the entry as new again", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const service = yield* ProjectTrust.Service
        const [entry] = yield* service.list()
        yield* service.decide([{ id: entry.id, state: "trusted" }])
        yield* service.decide([{ id: entry.id, state: "revoked" }])
        const [next] = yield* service.list()
        return next
      })

      const next = yield* trust(program)
      const file = yield* readTrustFile(state)

      expect(next).toMatchObject({ state: "pending", change: "new" })
      expect(file.projects[Hash.sha256(root)].entries).toEqual({})
    }),
  )

  it.live("clears records of locations that no longer exist on the next write", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", HOOKS)
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const service = yield* ProjectTrust.Service
        const entries = yield* service.list()
        yield* service.decide(entries.map((entry) => ({ id: entry.id, state: "trusted" as const })))
        yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
        const updated = yield* listenUpdated
        yield* service.decide([{ id: STOP_ID, state: "trusted" }])
        return { entries, event: yield* Deferred.await(updated) }
      })

      const result = yield* trust(program)
      const file = yield* readTrustFile(state)
      const removed = result.entries.filter((entry) => entry.id !== STOP_ID).map((entry) => entry.id)

      expect(Object.keys(file.projects[Hash.sha256(root)].entries)).toEqual([STOP_ID])
      expect(result.event.removed).toEqual(removed)
      expect(result.event.removed).toHaveLength(1)
    }),
  )

  it.live("ignores unknown ids without writing or publishing", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const updated = yield* listenUpdated
        const service = yield* ProjectTrust.Service
        yield* service.decide([{ id: "missing", state: "trusted" }])
        return yield* Deferred.isDone(updated)
      })

      expect(yield* trust(program)).toBe(false)
      expect(yield* trustFileExists(state)).toBe(false)
    }),
  )

  it.live("applies known ids and ignores unknown ones in the same call", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const updated = yield* listenUpdated
        const service = yield* ProjectTrust.Service
        yield* service.decide([
          { id: STOP_ID, state: "trusted" },
          { id: "missing", state: "trusted" },
        ])
        return yield* Deferred.await(updated)
      })

      const event = yield* trust(program)
      const file = yield* readTrustFile(state)

      expect(event.entries).toEqual([STOP_ID])
      expect(Object.keys(file.projects[Hash.sha256(root)].entries)).toEqual([STOP_ID])
    }),
  )

  it.live("writes no project record under $HOME", () =>
    Effect.gen(function* () {
      const state = yield* stateDir
      const home = Global.Path.home
      const trust = withProject(state, home)

      yield* trust(
        Effect.gen(function* () {
          const updated = yield* listenUpdated
          const service = yield* ProjectTrust.Service
          yield* service.decide([{ id: STOP_ID, state: "trusted" }])
          expect(yield* Deferred.isDone(updated)).toBe(false)
        }),
      )

      expect(yield* trustFileExists(state)).toBe(false)
    }),
  )

  it.live("never writes into the project directory", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      const trust = withProject(state, root)

      yield* trust(
        Effect.gen(function* () {
          const service = yield* ProjectTrust.Service
          const [entry] = yield* service.list()
          yield* service.decide([{ id: entry.id, state: "trusted" }])
        }),
      )

      expect(yield* Effect.promise(() => fs.readdir(path.join(root, PROJECT_DIR)))).toEqual(["hooks.json"])
      expect(yield* Effect.promise(() => fs.readdir(root))).not.toContain("trust.json")
    }),
  )
})

// ---------------------------------------------------------------------------
// trustImported
// ---------------------------------------------------------------------------

describe("ProjectTrust.trustImported", () => {
  it.live("records imported entries as trusted with the supplied fingerprint", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const updated = yield* listenUpdated
        const service = yield* ProjectTrust.Service
        const [entry] = yield* service.list()
        yield* service.trustImported([{ id: entry.id, fp: entry.fp, command: "./scripts/stop.sh" }])
        const [next] = yield* service.list()
        const checked = yield* service.check(entry.id, entry.fp)
        return { entry: entry, next: next, checked, event: yield* Deferred.await(updated) }
      })

      const result = yield* trust(program)
      const file = yield* readTrustFile(state)

      expect(result.next).toMatchObject({ id: STOP_ID, state: "trusted" })
      expect(result.checked).toBe("trusted")
      expect(result.event).toEqual({ projectID: Hash.sha256(root), entries: [STOP_ID], removed: [] })
      expect(file.projects[Hash.sha256(root)].entries[STOP_ID]).toEqual({
        fp: result.entry.fp,
        decision: "trusted",
        decidedAt: expect.any(Number),
        command: "./scripts/stop.sh",
      })
    }),
  )

  it.live("records the supplied fingerprint even when it differs from the current entry", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(root, "hooks.json", STOP_HOOK)
      const trust = withProject(state, root)
      const program = Effect.gen(function* () {
        const service = yield* ProjectTrust.Service
        const [entry] = yield* service.list()
        const importedFp = "f".repeat(64)
        yield* service.trustImported([{ id: entry.id, fp: importedFp }])
        const checkedImported = yield* service.check(entry.id, importedFp)
        const [next] = yield* service.list()
        return { checkedImported, next: next }
      })

      const result = yield* trust(program)

      expect(result.checkedImported).toBe("trusted")
      expect(result.next).toMatchObject({ state: "pending", change: "modified" })
    }),
  )

  it.live("writes no project record under $HOME", () =>
    Effect.gen(function* () {
      const state = yield* stateDir
      const home = Global.Path.home

      yield* withProject(
        state,
        home,
      )(ProjectTrust.Service.use((trust) => trust.trustImported([{ id: STOP_ID, fp: "f".repeat(64) }])))

      expect(yield* trustFileExists(state)).toBe(false)
    }),
  )
})

// ---------------------------------------------------------------------------
// Project identity
// ---------------------------------------------------------------------------

describe("project identity", () => {
  it.live("treats two clones of the same repository as independent projects", () =>
    Effect.gen(function* () {
      const first = yield* tmpdirScoped({ git: true })
      const second = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      yield* writeLayerFile(first, "hooks.json", STOP_HOOK)
      yield* writeLayerFile(second, "hooks.json", STOP_HOOK)

      for (const root of [first, second]) {
        yield* withProject(
          state,
          root,
        )(
          Effect.gen(function* () {
            const service = yield* ProjectTrust.Service
            const [entry] = yield* service.list()
            yield* service.decide([{ id: entry.id, state: "trusted" }])
          }),
        )
      }

      const file = yield* readTrustFile(state)
      expect(Object.keys(file.projects).toSorted()).toEqual([Hash.sha256(first), Hash.sha256(second)].toSorted())
      expect(file.projects[Hash.sha256(first)].entries[STOP_ID].decision).toBe("trusted")
      expect(file.projects[Hash.sha256(second)].entries[STOP_ID].decision).toBe("trusted")
    }),
  )

  it.live("keys the record by the real path of the project root", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const state = yield* stateDir
      const link = path.join(state, "linked-checkout")
      yield* Effect.promise(() => fs.symlink(root, link, "dir"))
      yield* writeLayerFile(link, "hooks.json", STOP_HOOK)

      yield* withProject(
        state,
        link,
      )(
        Effect.gen(function* () {
          const service = yield* ProjectTrust.Service
          const [entry] = yield* service.list()
          yield* service.decide([{ id: entry.id, state: "trusted" }])
        }),
      )

      const file = yield* readTrustFile(state)
      const realRoot = yield* Effect.promise(() => fs.realpath(link))
      expect(Object.keys(file.projects)).toEqual([Hash.sha256(realRoot)])
      expect(file.projects[Hash.sha256(realRoot)].root).toBe(link)
    }),
  )
})
