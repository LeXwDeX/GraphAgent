import { Effect } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"

// Session history seeders for the H0 compaction scenarios (S2/S3). They write
// through Session.updateMessage/updatePart so seeding exercises the same event
// bus and projectors as production, but always before `reset()` so the seed
// cost is not part of a measurement.

export const modelRef = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

export interface SeedTokens {
  readonly input: number
  readonly output: number
}

export function tokens(input = 0, output = 0): SessionV1.Assistant["tokens"] {
  return { total: input + output, input, output, reasoning: 0, cache: { read: 0, write: 0 } }
}

export interface SeedTurnOptions {
  /** Text of the user message. Defaults to a unique per-turn string. */
  readonly text?: string
  /** Text of the assistant message. Defaults to a unique per-turn string. */
  readonly reply?: string
  /** Token usage reported on the assistant message. */
  readonly tokens?: SeedTokens
  /**
   * `time.created` for the user message; the assistant gets `+1`. History
   * ordering follows this clock, so seeded turns must sit in the past or the
   * measured prompt would sort before them and the loop would see a finished
   * assistant as the newest message.
   */
  readonly createdAt?: number
}

/** Write one user message plus one finished assistant message. */
export const seedTurn = (sessionID: SessionID, turn: number, options: SeedTurnOptions = {}) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const createdAt = options.createdAt ?? Date.now()
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      agent: "build",
      model: modelRef,
      time: { created: createdAt },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID,
      type: "text",
      text: options.text ?? `seed turn ${turn} question`,
    })
    const assistant: SessionV1.Assistant = {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      parentID: user.id,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: tokens(options.tokens?.input, options.tokens?.output),
      modelID: modelRef.modelID,
      providerID: modelRef.providerID,
      time: { created: createdAt + 1 },
      finish: "stop",
    }
    yield* sessions.updateMessage(assistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID,
      type: "text",
      text: options.reply ?? `seed turn ${turn} answer`,
    })
    return { user, assistant }
  })

export interface SeedHistoryOptions {
  readonly turns: number
  /** Token usage for the last assistant message; triggers compaction on the next request. */
  readonly lastTokens?: SeedTokens
}

/** Write `turns` user/assistant pairs (two messages per turn). */
export const seedHistory = (sessionID: SessionID, options: SeedHistoryOptions) =>
  Effect.gen(function* () {
    // Anchor the whole history safely in the past: the measured prompt is
    // admitted after seeding and must sort after every seeded message.
    const base = Date.now() - options.turns * 2 - 1_000
    for (let turn = 0; turn < options.turns; turn += 1) {
      const last = turn === options.turns - 1
      yield* seedTurn(sessionID, turn, {
        createdAt: base + turn * 2,
        ...(last && options.lastTokens ? { tokens: options.lastTokens } : {}),
      })
    }
  })
