import { Context, Effect, Fiber, Layer } from "effect"
import { watch, statSync, type FSWatcher } from "node:fs"
import path from "node:path"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

export interface Interface {
  readonly replace: (
    sessionID: string,
    paths: readonly string[] | undefined,
    changed: (file: string, event: "change" | "add" | "unlink") => Effect.Effect<void>,
  ) => Effect.Effect<void>
  /** Current dynamic watch list for the session in this directory instance, if any. */
  readonly paths: (sessionID: string) => Effect.Effect<readonly string[] | undefined>
  readonly refreshStatic: (paths: readonly string[]) => Effect.Effect<void>
  readonly clear: (sessionID: string) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/HookFileWatch") {}
function signature(file: string) {
  try {
    const s = statSync(file)
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
  } catch {
    return "missing"
  }
}
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("HookFileWatch.state")(function* () {
        const sessions = new Map<
          string,
          {
            active: boolean
            watchers: FSWatcher[]
            fibers: Set<Fiber.Fiber<unknown, unknown>>
            paths: readonly string[]
            changed: (file: string, event: "change" | "add" | "unlink") => Effect.Effect<void>
          }
        >()
        const staticPaths: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const s of sessions.values()) {
              s.active = false
              for (const w of s.watchers) w.close()
              for (const f of s.fibers) yield* Fiber.interrupt(f)
            }
            sessions.clear()
          }),
        )
        return { sessions, staticPaths }
      }),
    )
    const clear = Effect.fn("HookFileWatch.clear")(function* (sessionID: string) {
      const { sessions } = yield* InstanceState.get(state)
      const old = sessions.get(sessionID)
      if (!old) return
      old.active = false
      for (const w of old.watchers) w.close()
      for (const f of old.fibers) if (f !== Fiber.getCurrent()) yield* Fiber.interrupt(f)
      sessions.delete(sessionID)
    })
    const paths = Effect.fn("HookFileWatch.paths")(function* (sessionID: string) {
      return (yield* InstanceState.get(state)).sessions.get(sessionID)?.paths
    })
    const replace = Effect.fn("HookFileWatch.replace")(function* (
      sessionID: string,
      files: readonly string[] | undefined,
      changed: (file: string, event: "change" | "add" | "unlink") => Effect.Effect<void>,
    ) {
      const previous = (yield* InstanceState.get(state)).sessions.get(sessionID)
      const paths = files ?? previous?.paths ?? []
      yield* clear(sessionID)
      const directory = yield* InstanceState.directory
      const bridge = yield* EffectBridge.make()
      const data = yield* InstanceState.get(state)
      const entry = {
        active: true,
        watchers: [] as FSWatcher[],
        fibers: new Set<Fiber.Fiber<unknown, unknown>>(),
        paths,
        changed,
      }
      data.sessions.set(sessionID, entry)
      for (const file of new Set([...paths, ...data.staticPaths].map((file) => path.resolve(directory, file)))) {
        let prior = signature(file)
        const watched = yield* Effect.try({
          try: () =>
            watch(path.dirname(file), { persistent: false }, (_event, name) => {
              if (!entry.active || (name !== null && name !== path.basename(file))) return
              const next = signature(file)
              if (next === prior) return
              const event = next === "missing" ? "unlink" : prior === "missing" ? "add" : "change"
              prior = next
              const fiber = bridge.fork(
                Effect.suspend(() => (entry.active ? changed(file, event) : Effect.void)).pipe(
                  Effect.catchCause(() => Effect.void),
                ),
              )
              entry.fibers.add(fiber)
              fiber.addObserver(() => entry.fibers.delete(fiber))
            }),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (watched) {
          watched.on("error", () => watched.close())
          entry.watchers.push(watched)
        }
      }
    })
    const refreshStatic = Effect.fn("HookFileWatch.refreshStatic")(function* (paths: readonly string[]) {
      const data = yield* InstanceState.get(state)
      data.staticPaths.splice(0, data.staticPaths.length, ...paths)
      for (const [id, entry] of Array.from(data.sessions)) yield* replace(id, entry.paths, entry.changed)
    })
    return Service.of({ replace, clear, paths, refreshStatic })
  }),
)
export const defaultLayer = layer
export const node = LayerNode.make(layer, [])
export * as HookFileWatch from "./file-watch"
