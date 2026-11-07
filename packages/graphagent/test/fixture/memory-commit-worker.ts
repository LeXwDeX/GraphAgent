import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { MemoryHome } from "@/memory/home"
import { MemoryStore } from "@/memory/store"

const Input = Schema.Struct({
  root: Schema.String,
  projectID: Schema.String,
  ready: Schema.String,
  go: Schema.String,
  expectedRevision: Schema.Number,
  summary: Schema.String,
})

const input = Schema.decodeUnknownSync(Input)(JSON.parse(process.argv[2] ?? "{}"))
const home = Layer.succeed(MemoryHome.Service, MemoryHome.make(input.root))
const store = MemoryStore.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(home),
)

await Effect.runPromise(
  Effect.gen(function* () {
    const memory = yield* MemoryStore.Service
    const projectID = ProjectV2.ID.make(input.projectID)
    yield* Effect.promise(() => Bun.write(input.ready, String(process.pid)))
    while (!(yield* Effect.promise(() => Bun.file(input.go).exists()))) yield* Effect.sleep("5 millis")

    const staleTopic = {
      schema_version: 1,
      id: "project-architecture",
      name: "架构边界",
      summary: input.summary,
      metadata: {
        categories: ["decision"],
        status: "active",
        importance: "core",
        keywords: ["架构"],
        related_topics: [],
        created_at: "2026-08-11T00:00:00Z",
        updated_at: "2026-08-11T00:00:00Z",
        last_matched_at: null,
        match_count: 0,
        revision: 1,
        item_count: 1,
      },
      items: [
        {
          id: "decision-stale",
          kind: "decision",
          content: "已确认决定：这是一次陈旧修订的提交",
          rationale: "该决定由用户确认并长期适用",
          confirmed_at: "2026-08-11T00:00:00Z",
        },
      ],
    } as const

    const exit = yield* Effect.exit(
      memory.commit(projectID, input.expectedRevision, {
        topics: [staleTopic],
        changed: [staleTopic.id],
        deleted: [],
      }),
    )
    // Exit 0 only when the commit failed with the explicit conflict error —
    // anything else (success, other failure) reports a broken protocol.
    if (Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("MemoryStore.CommitConflict")) {
      process.exit(0)
    }
    process.exit(1)
  }).pipe(Effect.provide(store)),
)
