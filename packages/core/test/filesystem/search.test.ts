import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { AbsolutePath, RelativePath } from "@graphagent/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Ripgrep.defaultLayer)

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )

  it.live("never searches or lists product worktrees", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        const worktree = path.join(cwd, ".agents", "worktree", "wt-01")
        yield* Effect.promise(() => fs.mkdir(path.join(worktree, "src"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(worktree, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const service = yield* Ripgrep.Service

        const grepped = yield* service.grep({ cwd, pattern: "needle", limit: 10 })
        expect(grepped.map((match) => match.entry.path)).toEqual([RelativePath.make("src/match.ts")])

        const globbed = yield* service.glob({ cwd, pattern: "**/*.ts", hidden: true, limit: 10 })
        expect(globbed.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])

        const found = yield* service.find({ cwd, pattern: "*", hidden: true, limit: 10 })
        expect(found.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )
})
