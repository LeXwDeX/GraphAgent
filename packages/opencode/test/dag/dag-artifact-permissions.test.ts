// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- narrow session and agent fixtures
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Fiber, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Project } from "@opencode-ai/core/project"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { commitOutputFileRef } from "@/dag/runtime/output-ref"
import { artifactPermissionBase, artifactReadPermissions, makeArtifactSourceAuthorizer } from "@/dag/runtime/artifact-permissions"
import type { ManagedOutputFileRef } from "@/dag/runtime/output-ref"
import { it, pollWithTimeout } from "../lib/effect"

const provenance = {
  workflow_id: "artifact-auth",
  node_id: "producer",
  child_session_id: "ses_producer",
  replan_attempt: 0,
}

test("moves the artifact worktree and boundary to the bound execution directory", () => {
  expect(artifactPermissionBase("/owner", "/owner", "/worktree-b")).toEqual({
    worktree: "/worktree-b",
    boundary: "/worktree-b",
  })
  expect(artifactPermissionBase("/owner", "/owner", "/owner")).toEqual({
    worktree: "/owner",
    boundary: "/owner",
  })
})

test("non-git artifact authorization uses the instance boundary without changing read rule paths", async () => {
  const directory = path.join(os.tmpdir(), "dag-non-git-instance")
  const inside = path.join(directory, "inside.txt")
  const outside = path.join(path.dirname(directory), "dag-outside.txt")
  const secret = path.join(directory, "secret.txt")
  const rules = Permission.fromConfig({
    read: { "*": "allow", [path.relative("/", secret)]: "deny" },
    external_directory: { "*": "deny" },
  })
  const authorize = makeArtifactSourceAuthorizer(
    { get: () => Effect.succeed({ agent: "build", permission: rules } as never) } as never,
    { get: () => Effect.succeed({ permission: [] } as never) } as never,
    "/",
    undefined,
    directory,
  )
  await Effect.runPromise(authorize("ses_producer", inside))
  await expect(Effect.runPromise(authorize("ses_producer", outside))).rejects.toThrow("external_directory denied")
  await expect(Effect.runPromise(authorize("ses_producer", secret))).rejects.toThrow("read denied")
})

test("non-git continuation authorization keeps the instance boundary for outside sources", async () => {
  const directory = path.join(os.tmpdir(), "dag-continuation-non-git")
  const inside = path.join(directory, "inside.txt")
  const outside = path.join(path.dirname(directory), "dag-continuation-outside.txt")
  const sessions = {
    get: () => Effect.succeed({ agent: "build", permission: [] } as never),
  } as never
  const agents = { get: () => Effect.succeed({ permission: [] } as never) } as never
  // Mirror loop.ts for a non-git owner: worktree "/" must not widen the boundary.
  const base = artifactPermissionBase(directory, "/", directory)
  expect(base).toEqual({ worktree: "/", boundary: directory })

  const denyOutside = Permission.fromConfig({
    read: { "*": "allow" },
    external_directory: { "*": "deny" },
  })
  const denyAuthorize = makeArtifactSourceAuthorizer(
    { get: () => Effect.succeed({ agent: "build", permission: denyOutside } as never) } as never,
    agents,
    base.worktree,
    undefined,
    base.boundary,
  )
  await Effect.runPromise(denyAuthorize("ses_producer", inside))
  const denial = await Effect.runPromise(denyAuthorize("ses_producer", outside).pipe(Effect.flip))
  expect(denial.message).toContain("external_directory denied")

  const asked: string[] = []
  const askAuthorize = makeArtifactSourceAuthorizer(
    sessions,
    { get: () => Effect.succeed({ permission: Permission.fromConfig({ read: { "*": "allow" } }) } as never) } as never,
    base.worktree,
    {
      ask: (request: { permission: string }) =>
        Effect.sync(() => {
          asked.push(request.permission)
        }),
    } as never,
    base.boundary,
  )
  await Effect.runPromise(askAuthorize("ses_producer", inside))
  await Effect.runPromise(askAuthorize("ses_producer", outside))
  expect(asked).toEqual(["external_directory"])
})

test.skipIf(process.platform === "win32")(
  "literal wildcard artifact directories fail closed and never override a sibling deny",
  async () => {
    const root = path.join(os.tmpdir(), "dag-artifact-??")
    const sibling = path.join(os.tmpdir(), "dag-artifact-ab", "content.txt")
    const ref = {
      kind: "file_ref",
      content_ref: "managed-v1:test",
      path: path.join(root, "content.txt"),
      size: 0,
      sha256: "0".repeat(64),
      summary: "",
      storage: "managed-v1",
      source_path: path.join(root, "source.txt"),
      provenance,
    } satisfies ManagedOutputFileRef
    const deny = {
      permission: "external_directory",
      pattern: path.join(path.dirname(sibling), "**").replaceAll("\\", "/"),
      action: "deny",
    } as const
    const grants = artifactReadPermissions([ref], os.tmpdir(), [deny])

    expect(Permission.evaluate("external_directory", sibling, [deny], grants).action).toBe("deny")
    expect(grants.filter((rule) => rule.permission === "external_directory" && rule.action === "allow")).toEqual([])

    const authorize = makeArtifactSourceAuthorizer(
      { get: () => Effect.succeed({ agent: "build", permission: [] } as never) } as never,
      { get: () => Effect.succeed({ permission: [] } as never) } as never,
      os.tmpdir(),
    )
    const failure = await Effect.runPromise(
      authorize("ses_producer", path.join(root, "source.txt")).pipe(Effect.flip),
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain("non-literal directory")

    const basenameFailure = await Effect.runPromise(
      authorize("ses_producer", path.join(os.tmpdir(), "dag-artifact-source-??.txt")).pipe(Effect.flip),
    )
    expect(basenameFailure).toBeInstanceOf(Error)
    expect(basenameFailure.message).toContain("non-literal directory")
  },
)

test.skipIf(process.platform === "win32")(
  "specific file external denies fail closed",
  () => {
    const root = path.join(os.tmpdir(), "dag-artifact-specific-deny")
    const target = path.join(root, "content.txt")
    const source = path.join(root, "source.txt")
    const ref = {
      kind: "file_ref",
      content_ref: "managed-v1:test",
      path: target,
      size: 0,
      sha256: "0".repeat(64),
      summary: "",
      storage: "managed-v1",
      source_path: source,
      provenance,
    } satisfies ManagedOutputFileRef

    for (const deniedPath of [target, source]) {
      const deny = {
        permission: "external_directory",
        pattern: deniedPath,
        action: "deny",
      } as const
      const grants = artifactReadPermissions([ref], os.tmpdir(), [deny])
      expect(Permission.evaluate("external_directory", deniedPath, [deny], grants).action).toBe("deny")
      expect(grants.filter((rule) => rule.permission === "external_directory" && rule.action === "allow")).toEqual([])
    }
  },
)

test.skipIf(process.platform === "win32")(
  "literal wildcard target basenames fail closed",
  async () => {
    const directory = path.join(os.tmpdir(), "dag-artifact-basename")
    const target = path.join(directory, "artifact-??.txt")
    const ref = {
      kind: "file_ref",
      content_ref: "managed-v1:test",
      path: target,
      size: 0,
      sha256: "0".repeat(64),
      summary: "",
      storage: "managed-v1",
      source_path: path.join(directory, "source.txt"),
      provenance,
    } satisfies ManagedOutputFileRef
    const grants = artifactReadPermissions([ref], os.tmpdir())
    const sibling = path.join(directory, "artifact-ab.txt")

    expect(Permission.evaluate("read", path.relative(os.tmpdir(), sibling), grants).action).toBe("deny")
    expect(grants.filter((rule) => rule.permission === "read" && rule.action === "allow")).toEqual([])

    let approvals = 0
    const authorize = makeArtifactSourceAuthorizer(
      { get: () => Effect.succeed({ agent: "build", permission: [] } as never) } as never,
      { get: () => Effect.succeed({ permission: [] } as never) } as never,
      os.tmpdir(),
      {
        ask: () =>
          Effect.sync(() => {
            approvals++
          }),
      } as never,
    )
    for (const name of ["artifact-??.txt", "artifact-*.txt"]) {
      const failure = await Effect.runPromise(
        authorize("ses_producer", path.join(directory, name)).pipe(Effect.flip),
      )
      expect(failure).toBeInstanceOf(Error)
      expect(failure.message).toContain("non-literal directory")
    }
    expect(approvals).toBe(0)
  },
)

test.skipIf(process.platform !== "win32")(
  "keeps canonical source deny and managed edit deny after the entire aliased worktree is deleted",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dag-alias-permission-"))
    let objectDirectory: string | undefined
    try {
      const directory = path.join(root, "original")
      const alias = path.join(root, "alias")
      await fs.mkdir(directory)
      await fs.symlink(directory, alias, "junction")
      const source = path.join(alias, "secret.txt")
      await fs.writeFile(source, `alias report ${root}`)
      const canonicalSource = FSUtil.normalizePath(source)
      expect(canonicalSource).not.toBe(source)
      const rules = Permission.fromConfig({
        read: { [path.relative(process.cwd(), canonicalSource)]: "allow" },
        external_directory: { [FSUtil.normalizePathPattern(path.join(directory, "*"))]: "allow" },
      })
      const authorize = makeArtifactSourceAuthorizer(
        { get: () => Effect.succeed({ agent: "build", permission: rules } as never) } as never,
        { get: () => Effect.succeed({ permission: [] } as never) } as never,
        process.cwd(),
      )
      const checked: string[] = []
      const ref = await Effect.runPromise(
        commitOutputFileRef(source, provenance, (value) => {
          checked.push(value)
          return authorize("ses_producer", value)
        }),
      )
      expect(ref).toBeDefined()
      if (!ref) throw new Error("missing committed report")
      expect(checked).toEqual([canonicalSource])
      expect(ref.source_path).toBe(canonicalSource)
      objectDirectory = path.dirname(ref.path)
      const targetPattern = path.relative(process.cwd(), FSUtil.normalizePath(ref.path))
      await fs.rm(root, { recursive: true, force: true })
      await Effect.runPromise(authorize("ses_producer", ref.source_path))
      expect(
        await fs.stat(root).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      const inherited = Permission.fromConfig({
        read: { "*": "allow", [path.relative(process.cwd(), canonicalSource)]: "deny" },
      })
      const grants = artifactReadPermissions([ref], process.cwd(), inherited)
      // ReadTool evaluates the canonical file path, even when submitted with a
      // different Windows spelling; source restrictions must follow that path.
      expect(Permission.evaluate("read", targetPattern, inherited, grants).action).toBe("deny")
      expect(Permission.evaluate("edit", targetPattern, grants).action).toBe("deny")
      expect(await fs.readFile(ref.path, "utf8")).toBe(`alias report ${root}`)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      if (objectDirectory) await fs.rm(objectDirectory, { recursive: true, force: true })
    }
  },
)

for (const permission of ["read", "external_directory"] as const) {
  for (const decision of ["deny", "once", "always", "reject"] as const) {
    it.live(`capture checks ${permission} before reading bytes (${decision})`, () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dag-authorize-"))),
          (value) => Effect.promise(() => fs.rm(value, { recursive: true, force: true })),
        )
        const source = path.join(directory, "secret.txt")
        const body = `private body ${directory}`
        const digest = createHash("sha256").update(body).digest("hex")
        const target = path.join(
          Global.Path.data,
          "workflow-artifacts",
          "objects",
          digest.slice(0, 2),
          digest,
          "content.txt",
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => fs.rm(path.dirname(target), { recursive: true, force: true })),
        )
        yield* Effect.promise(() => fs.writeFile(source, body))
        const pattern =
          permission === "read"
            ? path.relative(process.cwd(), FSUtil.normalizePath(source))
            : FSUtil.normalizePathPattern(path.join(directory, "*"))
        const sessionRules = [{ permission, pattern, action: decision === "deny" ? "deny" : "ask" }] as const
        const program = Effect.gen(function* () {
          const sessions = yield* Session.Service
          const agents = yield* Agent.Service
          const permissions = yield* Permission.Service
          const authorize = makeArtifactSourceAuthorizer(sessions, agents, process.cwd(), permissions)
          const capture = commitOutputFileRef(source, provenance, (value) => authorize("ses_producer", value))
          if (decision === "deny") {
            expect(yield* capture.pipe(Effect.flip)).toBeInstanceOf(Error)
            expect(yield* permissions.list()).toHaveLength(0)
            expect(
              yield* Effect.promise(() =>
                fs.stat(target).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
            return
          }
          const fiber = yield* capture.pipe(Effect.forkScoped)
          const requests = yield* pollWithTimeout(
            permissions.list().pipe(Effect.map((items) => (items.length ? items : undefined))),
            "capture did not request approval",
          )
          expect(requests[0].permission).toBe(permission)
          expect(requests[0].patterns).toEqual([pattern])
          expect(
            yield* Effect.promise(() =>
              fs.stat(target).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
          yield* permissions.reply({ requestID: requests[0].id, reply: decision })
          if (decision === "reject") {
            expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(Error)
            expect(
              yield* Effect.promise(() =>
                fs.stat(target).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
            return
          }
          const ref = yield* Fiber.join(fiber)
          expect(ref?.summary).toBe(body)
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(body)
          if (decision === "always") {
            yield* capture
            expect(yield* permissions.list()).toHaveLength(0)
          }
        })
        yield* program.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Session.Service, {
                get: () => Effect.succeed({ agent: "build", permission: sessionRules } as never),
              }),
              Layer.mock(Agent.Service, {
                get: () =>
                  Effect.succeed({ permission: [{ permission: "*", pattern: "*", action: "allow" }] } as never),
              }),
              Permission.layer.pipe(
                Layer.provide(Layer.mock(EventV2Bridge.Service, { publish: () => Effect.succeed({} as never) })),
              ),
            ),
          ),
          Effect.provideService(InstanceRef, {
            directory,
            worktree: process.cwd(),
            project: { id: Project.ID.global },
          } as never),
        )
      }).pipe(Effect.scoped),
    )
  }
}
