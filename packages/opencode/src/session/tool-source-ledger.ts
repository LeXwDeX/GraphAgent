import { Hash } from "@opencode-ai/core/util/hash"
import type { ToolSourceIdentity, ToolSourceKind } from "@opencode-ai/core/session/context-folding"
import { InstanceState } from "@/effect/instance-state"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const MAX_IDENTITIES = 4_096

export type Registration = Readonly<{
  sourceKind: ToolSourceKind
  registrationID: string
}>

export type RecordInput = Omit<ToolSourceIdentity, "registrationGeneration">

export interface Interface {
  /**
   * Activates the exact materialized registration set for the current instance.
   * A changed set invalidates every older identity before the new generation is returned.
   */
  readonly activate: (registrations: readonly Registration[], materialization?: string) => Effect.Effect<string>
  readonly record: (input: RecordInput & { registrationGeneration: string }) => Effect.Effect<void>
  readonly lookup: (input: {
    sessionID: string
    assistantMessageID: string
    callID: string
    toolName: string
  }) => Effect.Effect<ToolSourceIdentity | undefined>
  readonly clearSession: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolSourceLedger") {}

export const unavailable: Interface = {
  activate: () => Effect.succeed("unavailable"),
  record: () => Effect.void,
  lookup: () => Effect.succeed(undefined),
  clearSession: () => Effect.void,
}

type State = {
  readonly nonce: string
  readonly identities: Map<string, ToolSourceIdentity>
  revision: number
  signature?: string
  generation?: string
}

const part = (value: string) => `${value.length}:${value}`
const key = (input: Pick<ToolSourceIdentity, "sessionID" | "assistantMessageID" | "callID" | "toolName">) =>
  [input.sessionID, input.assistantMessageID, input.callID, input.toolName].map(part).join("")

const signature = (registrations: readonly Registration[], materialization: string | undefined) =>
  `${part(materialization ?? "")}${registrations
    .map((item) => `${part(item.sourceKind)}${part(item.registrationID)}`)
    .join("")}`

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolSourceLedger.state")(function* () {
        const value: State = {
          nonce: crypto.randomUUID(),
          identities: new Map(),
          revision: 0,
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            value.identities.clear()
            value.signature = undefined
            value.generation = undefined
          }),
        )
        return value
      }),
    )

    const activate: Interface["activate"] = Effect.fn("ToolSourceLedger.activate")(
      function* (registrations, materialization) {
        const current = yield* InstanceState.get(state)
        const next = signature(registrations, materialization)
        if (current.signature !== next || !current.generation) {
          current.identities.clear()
          current.revision++
          current.signature = next
          current.generation = Hash.sha256(`${part(current.nonce)}${part(String(current.revision))}${part(next)}`)
        }
        return current.generation
      },
    )

    const record: Interface["record"] = Effect.fn("ToolSourceLedger.record")(function* (input) {
      const current = yield* InstanceState.get(state)
      if (!current.generation || input.registrationGeneration !== current.generation) return
      const identity: ToolSourceIdentity = { ...input }
      const identityKey = key(identity)
      current.identities.delete(identityKey)
      current.identities.set(identityKey, identity)
      while (current.identities.size > MAX_IDENTITIES) {
        const oldest = current.identities.keys().next().value
        if (oldest === undefined) break
        current.identities.delete(oldest)
      }
    })

    const lookup: Interface["lookup"] = Effect.fn("ToolSourceLedger.lookup")(function* (input) {
      const current = yield* InstanceState.get(state)
      const identity = current.identities.get(key(input))
      if (!identity || identity.registrationGeneration !== current.generation) return undefined
      return { ...identity }
    })

    const clearSession: Interface["clearSession"] = Effect.fn("ToolSourceLedger.clearSession")(function* (sessionID) {
      const current = yield* InstanceState.get(state)
      for (const [identityKey, identity] of current.identities) {
        if (identity.sessionID === sessionID) current.identities.delete(identityKey)
      }
    })

    return Service.of({ activate, record, lookup, clearSession })
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])

export * as ToolSourceLedger from "./tool-source-ledger"
