import { LayerNode } from "@graphagent/core/effect/layer-node"
import path from "path"
import { randomUUID } from "node:crypto"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@graphagent/core/schema"
import { Global } from "@graphagent/core/global"
import { FSUtil } from "@graphagent/core/fs-util"
import { EffectFlock } from "@graphagent/core/util/effect-flock"
import { APP_NAME } from "@graphagent/core/brand"

export const OAUTH_DUMMY_KEY = `${APP_NAME}-oauth-dummy-key`

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flock = yield* EffectFlock.Service
    const file = path.join(global.data, "auth.json")
    const decode = Schema.decodeUnknownOption(Info)

    const read = Effect.fn("Auth.read")(function* (strict = false) {
      if (process.env.GRAPHAGENT_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.GRAPHAGENT_AUTH_CONTENT)
        } catch (err) {}
      }

      const source = fsys.readJson(file)
      const data = (yield* (
        strict
          ? source.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({})))
          : source.pipe(Effect.orElseSucceed(() => ({})))
      ).pipe(Effect.mapError(fail("Failed to read auth data")))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const all = Effect.fn("Auth.all")(() => read())

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const mutate = Effect.fn("Auth.mutate")(function* (update: (data: Record<string, Info>) => void) {
      yield* Effect.gen(function* () {
        const data = yield* read(true)
        update(data)
        yield* fsys.ensureDir(global.data)
        yield* Effect.gen(function* () {
          const temporary = yield* Effect.acquireRelease(
            Effect.sync(() => `${file}.${randomUUID()}.tmp`),
            (temporary) => fsys.remove(temporary).pipe(Effect.ignore),
          )
          yield* fsys.writeFileString(temporary, JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 })
          yield* fsys.rename(temporary, file)
        }).pipe(Effect.scoped)
      }).pipe(
        flock.withLock(`auth:${file}`, path.join(global.data, ".auth-locks")),
        Effect.mapError(fail("Failed to write auth data")),
      )
    })

    const set = Effect.fn("Auth.set")((key: string, info: Info) =>
      mutate((data) => {
        const norm = key.replace(/\/+$/, "")
        if (norm !== key) delete data[key]
        delete data[norm + "/"]
        data[norm] = info
      }),
    )

    const remove = Effect.fn("Auth.remove")((key: string) =>
      mutate((data) => {
        const norm = key.replace(/\/+$/, "")
        delete data[key]
        delete data[norm]
      }),
    )

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
)

export const node = LayerNode.make(layer, [FSUtil.node, Global.node, EffectFlock.node])

export * as Auth from "."
