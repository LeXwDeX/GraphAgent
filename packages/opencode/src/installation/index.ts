import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Schema, Context } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { APP_NAME } from "@opencode-ai/core/brand"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export const Event = InstallationEvent

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `${APP_NAME}/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedError<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

export const UPDATES_DISABLED = "Built-in application updates are disabled. Install releases manually."

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: () => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".graphagent", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        return "unknown" as Method
      }),
      // Compatibility accessors never query releases or execute an installer.
      latest: () => Effect.succeed(InstallationVersion),
      upgrade: () => Effect.fail(new UpgradeFailedError({ stderr: UPDATES_DISABLED })),
    }

    return Service.of(result)
  }),
)

export const defaultLayer = layer

const { runPromise } = makeRuntime(Service, defaultLayer)

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export const node = LayerNode.make(layer, [])

export * as Installation from "."
