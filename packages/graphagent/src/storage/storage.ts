import { LayerNode } from "@graphagent/core/effect/layer-node"
import path from "path"
import { Global } from "@graphagent/core/global"
import { FSUtil } from "@graphagent/core/fs-util"
import { Effect, Layer, Option, RcMap, Schema, Context, TxReentrantLock } from "effect"
import { Git } from "@/git"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  message: Schema.String,
}) {
  static isInstance(input: unknown): input is NotFoundError {
    return input instanceof NotFoundError
  }
}

export type Error = FSUtil.Error | NotFoundError

const RootFile = Schema.Struct({
  path: Schema.optional(
    Schema.Struct({
      root: Schema.optional(Schema.String),
    }),
  ),
})

const SessionFile = Schema.Struct({
  id: Schema.String,
})

const MessageFile = Schema.Struct({
  id: Schema.String,
})

const decodeRoot = Schema.decodeUnknownOption(RootFile)
const decodeSession = Schema.decodeUnknownOption(SessionFile)
const decodeMessage = Schema.decodeUnknownOption(MessageFile)

export interface Interface {
  readonly remove: (key: string[]) => Effect.Effect<void, FSUtil.Error>
  readonly read: <T>(key: string[]) => Effect.Effect<T, Error>
  readonly update: <T>(key: string[], fn: (draft: T) => void) => Effect.Effect<T, Error>
  readonly write: <T>(key: string[], content: T) => Effect.Effect<void, FSUtil.Error>
  readonly list: (prefix: string[]) => Effect.Effect<string[][], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/Storage") {}

function file(dir: string, key: string[]) {
  return path.join(dir, ...key) + ".json"
}

function missing(err: unknown) {
  if (!err || typeof err !== "object") return false
  if ("code" in err && err.code === "ENOENT") return true
  if ("reason" in err && err.reason && typeof err.reason === "object" && "_tag" in err.reason) {
    return err.reason._tag === "NotFound"
  }
  return false
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const locks = yield* RcMap.make({
      lookup: () => TxReentrantLock.make(),
      idleTimeToLive: 0,
    })
    const state = yield* Effect.cached(Effect.succeed({ dir: path.join(Global.Path.data, "storage") }))

    const fail = (target: string): Effect.Effect<never, NotFoundError> =>
      Effect.fail(new NotFoundError({ message: `Resource not found: ${target}` }))

    const wrap = <A>(target: string, body: Effect.Effect<A, FSUtil.Error>) =>
      body.pipe(Effect.catchIf(missing, () => fail(target)))

    const writeJson = Effect.fnUntraced(function* (target: string, content: unknown) {
      yield* fs.writeWithDirs(target, JSON.stringify(content, null, 2))
    })

    const withResolved = <A, E>(
      key: string[],
      fn: (target: string, rw: TxReentrantLock.TxReentrantLock) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | FSUtil.Error> =>
      Effect.scoped(
        Effect.gen(function* () {
          const target = file((yield* state).dir, key)
          return yield* fn(target, yield* RcMap.get(locks, target))
        }),
      )

    const remove: Interface["remove"] = Effect.fn("Storage.remove")(function* (key: string[]) {
      yield* withResolved(key, (target, rw) =>
        TxReentrantLock.withWriteLock(rw, fs.remove(target).pipe(Effect.catchIf(missing, () => Effect.void))),
      )
    })

    const read: Interface["read"] = <T>(key: string[]) =>
      Effect.gen(function* () {
        const value = yield* withResolved(key, (target, rw) =>
          TxReentrantLock.withReadLock(rw, wrap(target, fs.readJson(target))),
        )
        return value as T
      })

    const update: Interface["update"] = <T>(key: string[], fn: (draft: T) => void) =>
      Effect.gen(function* () {
        const value = yield* withResolved(key, (target, rw) =>
          TxReentrantLock.withWriteLock(
            rw,
            Effect.gen(function* () {
              const content = yield* wrap(target, fs.readJson(target))
              fn(content as T)
              yield* writeJson(target, content)
              return content
            }),
          ),
        )
        return value as T
      })

    const write: Interface["write"] = (key: string[], content: unknown) =>
      Effect.gen(function* () {
        yield* withResolved(key, (target, rw) => TxReentrantLock.withWriteLock(rw, writeJson(target, content)))
      })

    const list: Interface["list"] = Effect.fn("Storage.list")(function* (prefix: string[]) {
      const dir = (yield* state).dir
      const cwd = path.join(dir, ...prefix)
      const result = yield* fs
        .glob("**/*", {
          cwd,
          include: "file",
        })
        .pipe(Effect.catch(() => Effect.succeed<string[]>([])))
      return result
        .map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)])
        .toSorted((a, b) => a.join("/").localeCompare(b.join("/")))
    })

    return Service.of({
      remove,
      read,
      update,
      write,
      list,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Git.defaultLayer))

export const node = LayerNode.make(layer, [FSUtil.node, Git.node])

export * as Storage from "./storage"
