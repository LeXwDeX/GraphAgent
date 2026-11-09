// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as ContextFoldingToolSourceLedger from "./tool-source-ledger"

import { Context, Effect, Layer } from "effect"
import { Hash } from "../../util/hash"
import type { CandidateSafety, ToolSourceIdentity, ToolSourceKind } from "./types"

const MAX_IDENTITIES = 4_096

export type Registration = Readonly<{
  toolName: string
  sourceKind: ToolSourceKind
  registrationID: string
  instructions: CandidateSafety["instructions"]
}>

export type SettlementSource = Readonly<{
  sourceKind: ToolSourceKind
  registrationID: string
  registrationGeneration: string
  instructions: CandidateSafety["instructions"]
}>

export type RecordedSource = Readonly<{
  identity: ToolSourceIdentity
  instructions: CandidateSafety["instructions"]
}>

export interface Interface {
  /**
   * Activates the exact effective registration set for one materialized provider turn.
   * A changed set invalidates all identities recorded under the previous generation.
   */
  readonly activate: (registrations: readonly Registration[]) => Effect.Effect<string>
  readonly record: (input: {
    sessionID: string
    assistantMessageID: string
    callID: string
    toolName: string
    source: SettlementSource
  }) => Effect.Effect<void>
  readonly lookup: (input: {
    sessionID: string
    assistantMessageID: string
    callID: string
    toolName: string
  }) => Effect.Effect<RecordedSource | undefined>
  readonly clearSession: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/v2/ContextFoldingToolSourceLedger") {}

type State = {
  readonly nonce: string
  readonly identities: Map<string, RecordedSource>
  revision: number
  signature?: string
  generation?: string
}

const part = (value: string) => `${value.length}:${value}`
const key = (input: Pick<ToolSourceIdentity, "sessionID" | "assistantMessageID" | "callID" | "toolName">) =>
  [input.sessionID, input.assistantMessageID, input.callID, input.toolName].map(part).join("")

const signature = (registrations: readonly Registration[]) =>
  registrations
    .map(
      (item) => `${part(item.toolName)}${part(item.sourceKind)}${part(item.registrationID)}${part(item.instructions)}`,
    )
    .join("")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state: State = {
      nonce: crypto.randomUUID(),
      identities: new Map(),
      revision: 0,
    }

    const activate: Interface["activate"] = Effect.fn("ContextFoldingToolSourceLedger.activate")(
      function* (registrations) {
        const next = signature(registrations)
        if (state.signature !== next || !state.generation) {
          state.identities.clear()
          state.signature = next
          state.revision++
          state.generation = Hash.sha256(`${part(state.nonce)}${part(String(state.revision))}${part(next)}`)
        }
        return state.generation
      },
    )

    const record: Interface["record"] = Effect.fn("ContextFoldingToolSourceLedger.record")(function* (input) {
      if (!state.generation || input.source.registrationGeneration !== state.generation) return
      const identity: ToolSourceIdentity = {
        sessionID: input.sessionID,
        assistantMessageID: input.assistantMessageID,
        callID: input.callID,
        toolName: input.toolName,
        sourceKind: input.source.sourceKind,
        registrationID: input.source.registrationID,
        registrationGeneration: input.source.registrationGeneration,
      }
      const identityKey = key(identity)
      state.identities.delete(identityKey)
      state.identities.set(identityKey, { identity, instructions: input.source.instructions })
      while (state.identities.size > MAX_IDENTITIES) {
        const oldest = state.identities.keys().next().value
        if (oldest === undefined) break
        state.identities.delete(oldest)
      }
    })

    const lookup: Interface["lookup"] = Effect.fn("ContextFoldingToolSourceLedger.lookup")(function* (input) {
      const recorded = state.identities.get(key(input))
      if (!recorded || recorded.identity.registrationGeneration !== state.generation) return undefined
      return {
        identity: { ...recorded.identity },
        instructions: recorded.instructions,
      }
    })

    const clearSession: Interface["clearSession"] = Effect.fn("ContextFoldingToolSourceLedger.clearSession")(
      function* (sessionID) {
        for (const [identityKey, recorded] of state.identities) {
          if (recorded.identity.sessionID === sessionID) state.identities.delete(identityKey)
        }
      },
    )

    return Service.of({ activate, record, lookup, clearSession })
  }),
)

export const defaultLayer = layer
