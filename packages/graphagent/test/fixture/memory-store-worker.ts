import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Effect, Layer } from "effect"
import { MemoryHome } from "@/memory/home"
import { MemoryStore } from "@/memory/store"

type Input = {
  root: string
  projectID: string
  ready: string
  go: string
  itemID: string
  content: string
}

const input = JSON.parse(process.argv[2] ?? "") as Input
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
    yield* memory.updateTopics(projectID, (topics) => {
      const current = topics[0]
      if (!current) throw new Error("Missing base topic")
      const items = [...current.items, {
        id: input.itemID,
        kind: "decision",
        content: input.content,
        rationale: "该决定由用户确认并长期适用",
        confirmed_at: "2026-08-11T00:00:00Z",
      } as const]
      const updated = {
        ...current,
        metadata: {
          ...current.metadata,
          item_count: items.length,
          revision: current.metadata.revision + 1,
        },
        items,
      }
      return {
        applied: { topics: [updated], changed: [updated.id], deleted: [] },
        result: undefined,
      }
    })
  }).pipe(Effect.provide(store)),
)
