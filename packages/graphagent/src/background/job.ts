import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { InstanceState } from "@/effect/instance-state"
import { SessionCancellation } from "@/session/cancellation"
import { Effect, Layer, Scope } from "effect"

export {
  Service,
  type ExtendInput,
  type Info,
  type Interface,
  type StartInput,
  type Status,
  type WaitInput,
  type WaitResult,
} from "@opencode-ai/core/background-job"

const coordinated = new WeakSet<object>()

export const isCoordinated = (identity: object) => coordinated.has(identity)

/** Keeps the legacy service instance-scoped while sharing the core registry engine. */
export const layer = Layer.effect(
  CoreBackgroundJob.Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const jobs = yield* CoreBackgroundJob.make
        const scope = yield* Scope.Scope
        const owners = new Set<() => void>()
        const active = new Map<CoreBackgroundJob.Captured, CoreBackgroundJob.Info>()
        yield* Effect.addFinalizer(() => Effect.sync(() => owners.forEach((unregister) => unregister())))
        return { jobs, scope, owners, active }
      }),
    )
    return CoreBackgroundJob.Service.of({
      list: () => InstanceState.useEffect(state, ({ jobs }) => jobs.list()),
      get: (id) => InstanceState.useEffect(state, ({ jobs }) => jobs.get(id)),
      start: (input) =>
        Effect.suspend(() => {
          const ids = [input.id, input.metadata?.sessionId, input.metadata?.parentSessionId].filter(
            (id): id is string => typeof id === "string",
          )
          const requests = [...new Set(ids)].map((id) => ({ id, request: SessionCancellation.request(id) }))
          return Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const context = yield* Effect.context()
              const generation = yield* InstanceState.currentGeneration
              const directory = yield* InstanceState.directory
              const data = yield* InstanceState.get(state)
              const info = yield* data.jobs.start({
                ...input,
                run: Effect.suspend(() =>
                  requests.every(({ request }) => request.current()) ? restore(input.run) : Effect.interrupt,
                ),
              })
              const captured = yield* data.jobs.capture(info)
              if (!captured) return info
              const matches = new Set(
                [info.id, info.metadata?.sessionId, info.metadata?.parentSessionId].filter(
                  (id): id is string => typeof id === "string",
                ),
              )
              for (const id of matches) {
                if (!requests.some((entry) => entry.id === id))
                  requests.push({ id, request: SessionCancellation.request(id) })
              }
              data.active.set(captured, {
                ...info,
                ...(info.metadata ? { metadata: { ...info.metadata } } : {}),
              })
              const unregister = requests.flatMap(({ id, request }) => {
                if (!matches.has(id)) return []
                const off = request.register(() => {
                  const pending = new Set([id])
                  const selected = new Set<CoreBackgroundJob.Captured>()
                  let changed = true
                  while (changed) {
                    changed = false
                    for (const [job, current] of data.active) {
                      if (selected.has(job)) continue
                      if (
                        !pending.has(current.id) &&
                        !(typeof current.metadata?.sessionId === "string" && pending.has(current.metadata.sessionId)) &&
                        !(
                          typeof current.metadata?.parentSessionId === "string" &&
                          pending.has(current.metadata.parentSessionId)
                        )
                      )
                        continue
                      selected.add(job)
                      pending.add(current.id)
                      if (typeof current.metadata?.sessionId === "string") pending.add(current.metadata.sessionId)
                      changed = true
                    }
                  }
                  return InstanceState.withGeneration(
                    generation,
                    Effect.forEach(selected, (job) => job.cancel, { concurrency: "unbounded", discard: true }),
                  ).pipe(Effect.provide(context))
                }, directory)
                return off ? [off] : []
              })
              if (requests.some(({ id, request }) => matches.has(id) && !request.current())) yield* captured.cancel
              if (unregister.length > 0) {
                coordinated.add(captured.identity)
                const dispose = () => {
                  unregister.forEach((off) => off())
                  data.owners.delete(dispose)
                  data.active.delete(captured)
                }
                data.owners.add(dispose)
                yield* captured.done.pipe(
                  Effect.ensuring(Effect.sync(dispose)),
                  Effect.forkIn(data.scope, { startImmediately: true }),
                )
              } else data.active.delete(captured)
              return info
            }).pipe(Effect.ensuring(Effect.sync(() => requests.forEach(({ request }) => request.release())))),
          )
        }),
      extend: (input) => InstanceState.useEffect(state, ({ jobs }) => jobs.extend(input)),
      wait: (input) => InstanceState.useEffect(state, ({ jobs }) => jobs.wait(input)),
      waitForPromotion: (id) => InstanceState.useEffect(state, ({ jobs }) => jobs.waitForPromotion(id)),
      promote: (id) => InstanceState.useEffect(state, ({ jobs }) => jobs.promote(id)),
      cancel: (id) => InstanceState.useEffect(state, ({ jobs }) => jobs.cancel(id)),
      capture: (info) => InstanceState.useEffect(state, ({ jobs }) => jobs.capture(info)),
    })
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])

export * as BackgroundJob from "./job"
