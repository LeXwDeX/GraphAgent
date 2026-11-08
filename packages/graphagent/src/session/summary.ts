import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@graphagent/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { Session, truncateSummaryDiffs } from "./session"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export interface Interface {
  readonly summarizeTurn: (input: {
    sessionID: SessionID
    userMessageIDs: ReadonlyArray<MessageID>
  }) => Effect.Effect<void>
  readonly read: (messageID: MessageID) => Effect.Effect<ReadonlyArray<Snapshot.FileDiff>>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: SessionV1.WithParts[] }) {
      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        for (const part of item.parts) {
          if (part.type === "step-start" && part.snapshot) {
            from ??= part.snapshot
            to = part.snapshot
          } else if (part.type === "step-finish" && part.snapshot) {
            to = part.snapshot
          }
        }
      }
      if (!from || !to || from === to) return []
      return yield* snapshot.diffFull(from, to)
    })

    const summarizeTurn = Effect.fn("SessionSummary.summarizeTurn")(function* (input: {
      sessionID: SessionID
      userMessageIDs: ReadonlyArray<MessageID>
    }) {
      // One zero summary and one empty diff event per turn; the session-level
      // aggregate is owned by the caller's data layer, not by this table.
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
        },
      })
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: [] })
      if ((yield* config.get()).snapshot === false) return
      if (input.userMessageIDs.length === 0) return
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)

      for (const userMessageID of input.userMessageIDs) {
        const messages = all.filter(
          (m) => m.info.id === userMessageID || (m.info.role === "assistant" && m.info.parentID === userMessageID),
        )
        const target = messages.find((m) => m.info.id === userMessageID)
        if (!target || target.info.role !== "user") continue
        const diffs = truncateSummaryDiffs(yield* computeDiff({ messages })) ?? []
        if (diffs.length === 0) {
          yield* sessions.deleteMessageDiff(userMessageID)
          continue
        }
        yield* sessions.writeMessageDiff({ sessionID: input.sessionID, messageID: userMessageID, diff: diffs })
      }
    })

    const read = Effect.fn("SessionSummary.read")(function* (messageID: MessageID) {
      const diffs = yield* sessions.readMessageDiff(messageID)
      return diffs.map((item) => {
        if (item.file === undefined) return item
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      if (!input.messageID) return []
      return yield* read(input.messageID)
    })

    return Service.of({ summarizeTurn, read, diff, computeDiff })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Config.defaultLayer),
  ),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export const node = LayerNode.make(layer, [Session.node, Snapshot.node, EventV2Bridge.node, Config.node])

export * as SessionSummary from "./summary"
