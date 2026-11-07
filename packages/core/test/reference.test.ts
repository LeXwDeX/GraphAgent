import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer, Scope } from "effect"
import { AbsolutePath } from "@graphagent/core/schema"
import { Global } from "@graphagent/core/global"
import { Reference } from "@graphagent/core/reference"
import { Repository } from "@graphagent/core/repository"
import { RepositoryCache } from "@graphagent/core/repository-cache"
import { EventV2 } from "@graphagent/core/event"
import { it } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const cache = Layer.mock(RepositoryCache.Service, {
  ensure: () => Effect.die("unexpected Git materialization"),
})

describe("Reference", () => {
  it.effect("registers normalized sources for the owning scope", () =>
    Effect.gen(function* () {
      const references = yield* Reference.Service
      const scope = yield* Scope.make()
      const path = AbsolutePath.make("/docs")
      const source = Reference.LocalSource.make({
        type: "local",
        path,
        description: "Use for API documentation",
        hidden: true,
      })
      yield* references.transform((editor) => editor.add("docs", source)).pipe(Scope.provide(scope))

      expect(yield* references.list()).toEqual([
        new Reference.Info({ name: "docs", path, description: "Use for API documentation", hidden: true, source }),
      ])

      yield* Scope.close(scope, Exit.void)
      expect(yield* references.list()).toEqual([])
    }).pipe(
      Effect.provide(Reference.layer),
      Effect.provide(cache),
      Effect.provide(EventV2.defaultLayer),
      Effect.provide(Global.defaultLayer),
    ),
  )

  it.effect("derives Git paths without exposing cache operations", () =>
    Effect.gen(function* () {
      const references = yield* Reference.Service
      const repository = Repository.parseRemote("owner/repo")
      yield* Effect.promise(() => fs.mkdir(Repository.cachePath(Global.Path.repos, repository), { recursive: true }))
      const source = Reference.GitSource.make({ type: "git", repository: "owner/repo", branch: "main" })
      yield* references.transform((editor) => editor.add("sdk", source))

      expect(yield* references.list()).toEqual([
        new Reference.Info({
          name: "sdk",
          path: AbsolutePath.make(Repository.cachePath(Global.Path.repos, repository)),
          source,
        }),
      ])
    }).pipe(
      Effect.scoped,
      Effect.provide(Reference.layer),
      Effect.provide(cache),
      Effect.provide(EventV2.defaultLayer),
      Effect.provide(Global.defaultLayer),
    ),
  )

  it.effect("preserves configured Git descriptions", () =>
    Effect.gen(function* () {
      const references = yield* Reference.Service
      const repository = Repository.parseRemote("owner/repo")
      yield* Effect.promise(() => fs.mkdir(Repository.cachePath(Global.Path.repos, repository), { recursive: true }))
      const source = Reference.GitSource.make({
        type: "git",
        repository: "owner/repo",
        description: "Use for SDK implementation details",
      })
      yield* references.transform((editor) => editor.add("sdk", source))

      expect(yield* references.list()).toEqual([
        new Reference.Info({
          name: "sdk",
          path: AbsolutePath.make(Repository.cachePath(Global.Path.repos, repository)),
          description: "Use for SDK implementation details",
          source,
        }),
      ])
    }).pipe(
      Effect.scoped,
      Effect.provide(Reference.layer),
      Effect.provide(cache),
      Effect.provide(EventV2.defaultLayer),
      Effect.provide(Global.defaultLayer),
    ),
  )

  it.effect("omits uncached Git references while refresh fails", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const references = yield* Reference.Service
          const source = Reference.GitSource.make({ type: "git", repository: "owner/repo", branch: "main" })
          yield* references.transform((editor) => editor.add("sdk", source))

          expect(yield* references.list()).toEqual([])
        }).pipe(
          Effect.scoped,
          Effect.provide(Reference.layer),
          Effect.provide(cache),
          Effect.provide(EventV2.defaultLayer),
          Effect.provide(Global.layerWith({ state: path.join(tmp.path, "state"), repos: path.join(tmp.path, "repos") })),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
