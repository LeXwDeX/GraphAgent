import { Hash } from "@opencode-ai/core/util/hash"
import type { ToolSourceIdentity, ToolSourceKind } from "@opencode-ai/core/session/context-folding"
import { InstanceState } from "@/effect/instance-state"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const MAX_IDENTITIES = 4_096
const MAX_SESSIONS = 1_024

export type Registration = Readonly<{
  sourceKind: ToolSourceKind
  registrationID: string
}>

export type RecordInput = Omit<ToolSourceIdentity, "registrationGeneration">

export interface Interface {
  /**
   * Activates the exact materialized registration set for one session's provider turn.
   * A changed set invalidates every older identity of that session before the new generation is returned.
   * Other sessions in the same instance (for example subagents with another model or tool set) keep their
   * own generation and evidence.
   */
  readonly activate: (
    sessionID: string,
    registrations: readonly Registration[],
    materialization?: string,
  ) => Effect.Effect<string>
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

type SessionGeneration = {
  readonly signature: string
  readonly generation: string
}

type State = {
  readonly nonce: string
  readonly identities: Map<string, ToolSourceIdentity>
  /** Active generation per session, in least-recently-activated order. */
  readonly sessions: Map<string, SessionGeneration>
  /** Instance-wide and monotonic, so an A-B-A switch in any session never reuses a generation. */
  revision: number
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
          sessions: new Map(),
          revision: 0,
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            value.identities.clear()
            value.sessions.clear()
          }),
        )
        return value
      }),
    )

    const dropSession = (current: State, sessionID: string) => {
      for (const [identityKey, identity] of current.identities) {
        if (identity.sessionID === sessionID) current.identities.delete(identityKey)
      }
      current.sessions.delete(sessionID)
    }

    const activate: Interface["activate"] = Effect.fn("ToolSourceLedger.activate")(
      function* (sessionID, registrations, materialization) {
        const current = yield* InstanceState.get(state)
        const next = signature(registrations, materialization)
        const active = current.sessions.get(sessionID)
        if (active && active.signature === next) {
          // Keep the most recently active sessions when the session bound is reached.
          current.sessions.delete(sessionID)
          current.sessions.set(sessionID, active)
          return active.generation
        }
        dropSession(current, sessionID)
        current.revision++
        const generation = Hash.sha256(
          `${part(current.nonce)}${part(String(current.revision))}${part(sessionID)}${part(next)}`,
        )
        current.sessions.set(sessionID, { signature: next, generation })
        while (current.sessions.size > MAX_SESSIONS) {
          const oldest = current.sessions.keys().next().value
          if (oldest === undefined) break
          dropSession(current, oldest)
        }
        return generation
      },
    )

    const record: Interface["record"] = Effect.fn("ToolSourceLedger.record")(function* (input) {
      const current = yield* InstanceState.get(state)
      const active = current.sessions.get(input.sessionID)
      if (!active || input.registrationGeneration !== active.generation) return
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
      const active = current.sessions.get(input.sessionID)
      if (!identity || !active || identity.registrationGeneration !== active.generation) return undefined
      return { ...identity }
    })

    const clearSession: Interface["clearSession"] = Effect.fn("ToolSourceLedger.clearSession")(function* (sessionID) {
      dropSession(yield* InstanceState.get(state), sessionID)
    })

    return Service.of({ activate, record, lookup, clearSession })
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])

export * as ToolSourceLedger from "./tool-source-ledger"
