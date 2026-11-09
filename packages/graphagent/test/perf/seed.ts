// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"

// Session history seeders for the H0 compaction scenarios (S2/S3). They write
// through Session.updateMessage/updatePart (and writeMessageDiff for turn
// diffs) so seeding exercises the same event bus and projectors as production,
// but always before `reset()` so the seed cost is not part of a measurement.

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
  /**
   * Extra parts appended to the assistant message after its text part. Called
   * with the IDs the message actually received, so fixtures can build image or
   * tool parts without guessing them.
   */
  readonly assistantParts?: (messageID: MessageID, sessionID: SessionID) => ReadonlyArray<SessionV1.Part>
  /**
   * Extra parts appended to the user message after its text part. Model input
   * only carries file parts from user messages, so attachments (images) must
   * be seeded here to reach convert.messages.
   */
  readonly userParts?: (messageID: MessageID, sessionID: SessionID) => ReadonlyArray<SessionV1.Part>
  /**
   * `message_diff` row for the user message. This is where production persists
   * payload-sized turn diffs (`MAX_SUMMARY_DIFF_BYTES` truncates exactly this
   * list), so a 256KiB diff fixture belongs here rather than on tool output.
   */
  readonly userMessageDiff?: NonNullable<SessionV1.User["summary"]>["diffs"]
}

/** A valid 1x1 PNG: real image bytes small enough to repeat every few turns. */
export const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

/** A `file` part carrying an inline image, the same shape attachments use. */
export const imagePart = (input: {
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly base64?: string
}): SessionV1.FilePart => ({
  id: PartID.ascending(),
  sessionID: input.sessionID,
  messageID: input.messageID,
  type: "file",
  mime: "image/png",
  filename: "pixel.png",
  url: `data:image/png;base64,${input.base64 ?? PIXEL_PNG_BASE64}`,
})

/**
 * A completed tool part whose output is a diff. Patch parts only store a
 * snapshot hash, so payload-sized diffs must travel as tool output to be
 * measured by JSON encoding and sha256.
 */
export const diffPart = (input: {
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly callID: string
  readonly output: string
  readonly time: { readonly start: number; readonly end: number }
}): SessionV1.ToolPart => ({
  id: PartID.ascending(),
  sessionID: input.sessionID,
  messageID: input.messageID,
  type: "tool",
  callID: input.callID,
  tool: "bash",
  state: {
    status: "completed",
    input: { command: "git diff" },
    output: input.output,
    title: "git diff",
    metadata: {},
    time: input.time,
  },
})

/** A deterministic unified diff of roughly `bytes` bytes. */
export function makeDiff(bytes: number): string {
  const header = "diff --git a/file.txt b/file.txt\nindex 0000000..1111111 100644\n--- a/file.txt\n+++ b/file.txt\n"
  const body = "+" + "x".repeat(63) + "\n"
  const repeats = Math.max(0, Math.ceil((bytes - header.length) / body.length))
  return header + body.repeat(repeats)
}

export interface SeedCompactedHistoryOptions {
  /** Turns of history; each turn is one user plus one assistant message. */
  readonly turns: number
  /** Write a completed compaction boundary after every N turns. */
  readonly compactionEvery: number
  /**
   * Turns kept visible by the final compaction's tail marker. `filterCompacted`
   * keeps the messages from that marker onward, so this is the retained tail a
   * cold start actually reads.
   */
  readonly tailTurns: number
  /** Every Nth retained-turn user message also carries an inline image. */
  readonly imageEvery?: number
  /** Size of the turn diff stored in `message_diff` for the newest user message. */
  readonly summaryDiffBytes?: number
}

/**
 * A history that has already been compacted `turns / compactionEvery` times.
 * Every boundary is a completed compaction pair, and the final one carries a
 * tail marker near the end of the history. That is the shape of a long,
 * heavily compacted session: the table holds every message, while the
 * reconstructed visible history is only the retained tail plus the last
 * compaction pair.
 */
export const seedCompactedHistory = (sessionID: SessionID, options: SeedCompactedHistoryOptions) =>
  Effect.gen(function* () {
    const base = Date.now() - options.turns * 3 - 1_000
    const tailStartTurn = options.turns - options.tailTurns
    const diff = options.summaryDiffBytes ? makeDiff(options.summaryDiffBytes) : undefined
    let tailStartID: MessageID | undefined
    let compactions = 0
    for (let turn = 0; turn < options.turns; turn += 1) {
      const last = turn === options.turns - 1
      const retained = turn >= tailStartTurn
      const seeded = yield* seedTurn(sessionID, turn, {
        createdAt: base + turn * 3,
        userParts: (messageID, partSessionID) => {
          if (!options.imageEvery || !retained) return []
          return (turn - tailStartTurn) % options.imageEvery === 0
            ? [imagePart({ sessionID: partSessionID, messageID })]
            : []
        },
        ...(last && diff
          ? { userMessageDiff: [{ file: "file.txt", patch: diff, additions: 1, deletions: 0, status: "modified" }] }
          : {}),
      })
      if (turn === tailStartTurn) tailStartID = seeded.user.id
      if ((turn + 1) % options.compactionEvery === 0 && turn + 1 < options.turns) {
        compactions += 1
        yield* seedCompaction(sessionID, compactions, {
          summary: `summary after turn ${turn}`,
          createdAt: base + turn * 3 + 2,
          ...(tailStartID ? { tailStartID } : {}),
        })
      }
    }
    compactions += 1
    yield* seedCompaction(sessionID, compactions, {
      summary: `summary after turn ${options.turns - 1}`,
      createdAt: base + options.turns * 3,
      ...(tailStartID ? { tailStartID } : {}),
    })
    return { compactions }
  })

export interface SeedCompactionOptions {
  /** Text of the summary assistant message. */
  readonly summary: string
  /** `time.created` for the compaction user message; the summary gets `+1`. */
  readonly createdAt?: number
  /**
   * Start of the retained tail. `filterCompacted` rebuilds history around the
   * last compaction that carries this marker, keeping its summary and the
   * messages from the marker onward.
   */
  readonly tailStartID?: MessageID
}

/**
 * Write one completed compaction boundary: the user message that requested
 * compaction and the summary assistant message that finished it
 * (`completedCompactions` recognizes exactly this pair).
 */
export const seedCompaction = (sessionID: SessionID, index: number, options: SeedCompactionOptions) =>
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
      type: "compaction",
      auto: true,
      ...(options.tailStartID ? { tail_start_id: options.tailStartID } : {}),
    })
    const assistant: SessionV1.Assistant = {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      parentID: user.id,
      mode: "compaction",
      agent: "compaction",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: tokens(),
      modelID: modelRef.modelID,
      providerID: modelRef.providerID,
      summary: true,
      time: { created: createdAt + 1 },
      finish: "stop",
    }
    yield* sessions.updateMessage(assistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID,
      type: "text",
      text: options.summary,
    })
    return { user, assistant }
  })

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
    if (options.userMessageDiff)
      yield* sessions.writeMessageDiff({ sessionID, messageID: user.id, diff: options.userMessageDiff })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID,
      type: "text",
      text: options.text ?? `seed turn ${turn} question`,
    })
    for (const part of options.userParts?.(user.id, sessionID) ?? []) {
      yield* sessions.updatePart(part)
    }
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
    for (const part of options.assistantParts?.(assistant.id, sessionID) ?? []) {
      yield* sessions.updatePart(part)
    }
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

export interface SeedRichHistoryOptions extends SeedHistoryOptions {
  /** Every Nth assistant message also carries an image part. */
  readonly imageEvery?: number
  /** Every Nth assistant message also carries a tool part with a diff output. */
  readonly diffEvery?: number
  /** Size of that diff in bytes. Defaults to 256 KiB. */
  readonly diffBytes?: number
}

/**
 * History with media attached: real image bytes and payload-sized diff output
 * make JSON encoding, parsing and sha256 see the shapes production sees, which
 * plain text turns never exercise.
 */
export const seedRichHistory = (sessionID: SessionID, options: SeedRichHistoryOptions) =>
  Effect.gen(function* () {
    const base = Date.now() - options.turns * 2 - 1_000
    const diff = makeDiff(options.diffBytes ?? 256 * 1024)
    for (let turn = 0; turn < options.turns; turn += 1) {
      const last = turn === options.turns - 1
      yield* seedTurn(sessionID, turn, {
        createdAt: base + turn * 2,
        ...(last && options.lastTokens ? { tokens: options.lastTokens } : {}),
        assistantParts: (messageID, partSessionID) => {
          const parts: Array<SessionV1.Part> = []
          if (options.imageEvery && turn % options.imageEvery === 0) {
            parts.push(imagePart({ sessionID: partSessionID, messageID }))
          }
          if (options.diffEvery && turn % options.diffEvery === 0) {
            const createdAt = base + turn * 2
            parts.push(
              diffPart({
                sessionID: partSessionID,
                messageID,
                callID: `call-diff-${turn}`,
                output: diff,
                time: { start: createdAt, end: createdAt + 1 },
              }),
            )
          }
          return parts
        },
      })
    }
  })
