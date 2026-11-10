// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import { HistoryView } from "@/session/history/view"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { historyEffect, makeFixture, withSession } from "./history-fixture"

const it = historyEffect

/** The lazy tail must be byte-identical to the full newest-first walk. */
const sameAsFullRead = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const full = yield* MessageV2.filterCompactedEffect(sessionID)
    const tail = yield* HistoryView.tail(sessionID)
    expect(tail).toEqual(full)
  })

const pair = (f: ReturnType<typeof makeFixture>) =>
  Effect.gen(function* () {
    const user = yield* f.user("prompt")
    yield* f.assistant(user, { finish: "stop" })
  })

describe("MessageV2.filterCompactedTail", () => {
  it.instance("matches the full walk without compaction", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        yield* pair(f)
        yield* pair(f)
        yield* pair(f)
        yield* sameAsFullRead(sessionID)
      }),
    ),
  )

  it.instance("stops at a completed boundary without a retained tail", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        yield* pair(f)
        const marker = yield* f.marker()
        yield* f.assistant(marker, { summary: true, finish: "stop" })
        yield* pair(f)
        yield* sameAsFullRead(sessionID)
      }),
    ),
  )

  it.instance("stops after reaching the retained tail anchor", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const anchor = yield* f.user("anchor")
        yield* f.assistant(anchor, { finish: "stop" })
        yield* pair(f)
        yield* pair(f)
        const marker = yield* f.marker(anchor)
        yield* f.assistant(marker, { summary: true, finish: "stop" })
        yield* pair(f)
        yield* sameAsFullRead(sessionID)
      }),
    ),
  )

  it.instance("walks every page when no boundary completes", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        for (let i = 0; i < 30; i++) yield* pair(f)
        // summary without finish does not complete the boundary
        const marker = yield* f.marker()
        yield* f.assistant(marker, { summary: true })
        for (let i = 0; i < 5; i++) yield* pair(f)
        yield* sameAsFullRead(sessionID)
      }),
    ),
  )

  it.instance("walks every page when the summary errored", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        for (let i = 0; i < 30; i++) yield* pair(f)
        const marker = yield* f.marker()
        yield* f.assistant(marker, {
          summary: true,
          finish: "error",
          error: { name: "MessageAbortedError", data: { message: "boom" } } as never,
        })
        for (let i = 0; i < 5; i++) yield* pair(f)
        yield* sameAsFullRead(sessionID)
      }),
    ),
  )

  it.instance("walks to the end when the retained anchor is missing", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        for (let i = 0; i < 30; i++) yield* pair(f)
        const marker = yield* f.marker(MessageID.make("msg_missing_anchor"))
        yield* f.assistant(marker, { summary: true, finish: "stop" })
        yield* pair(f)
        yield* sameAsFullRead(sessionID)
      }),
    ),
  )

  it.instance("handles several boundaries with the newest completed one", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const anchor = yield* f.user("first")
        yield* f.assistant(anchor, { finish: "stop" })
        yield* pair(f)
        const older = yield* f.marker(anchor)
        yield* f.assistant(older, { summary: true, finish: "stop" })
        yield* pair(f)
        yield* pair(f)
        const newest = yield* f.marker(anchor)
        yield* f.assistant(newest, { summary: true, finish: "stop" })
        yield* pair(f)
        yield* pair(f)
        yield* sameAsFullRead(sessionID)
      }),
    ),
  )

  it.instance("crosses page boundaries before the retained tail anchor", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const anchor = yield* f.user("anchor")
        yield* f.assistant(anchor, { finish: "stop" })
        for (let i = 0; i < 80; i++) yield* pair(f)
        const marker = yield* f.marker(anchor)
        yield* f.assistant(marker, { summary: true, finish: "stop" })
        yield* pair(f)
        yield* sameAsFullRead(sessionID)
      }),
    ),
  )
})

describe("MessageV2.filterCompactedTail generated histories", () => {
  // Deterministic LCG so a failure is reproducible from the history index.
  const lcg = (seed: number) => {
    let state = seed >>> 0
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x1_0000_0000
    }
  }
  const counts = [0, 1, 49, 50, 51, 60, 80, 99, 120, 160, 40, 51]
  for (const [index, count] of counts.entries()) {
    it.instance(`matches the full walk on generated history #${index} (${count} messages)`, () =>
      withSession(({ sessionID, f }) =>
        Effect.gen(function* () {
          const random = lcg(0x9e37_79b9 ^ Math.imul(index, 0x9e37_79b1))
          const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!
          const users: MessageID[] = []
          const failure = () =>
            random() < 0.5 ? ({ name: "MessageAbortedError", data: { message: "boom" } } as never) : undefined
          for (let position = 0; position < count; position++) {
            const roll = random()
            if (users.length === 0 || roll < 0.45) {
              users.push(yield* f.user(`turn ${position}`))
              continue
            }
            if (roll < 0.7) {
              const finish = random() < 0.6 ? "stop" : random() < 0.5 ? undefined : "error"
              yield* f.assistant(pick(users), {
                summary: random() < 0.3,
                finish,
                ...(finish === "error" ? { error: failure() } : {}),
              })
              continue
            }
            if (roll < 0.85) {
              const mode = random()
              if (mode < 0.2) users.push(yield* f.marker())
              else if (mode < 0.4) users.push(yield* f.marker(pick(users)))
              else if (mode < 0.6) users.push(yield* f.marker(MessageID.make(`msg_missing_${index}_${position}`)))
              else {
                const self = MessageID.ascending()
                users.push(yield* f.marker(self, self))
              }
              continue
            }
            const mode = random()
            const marker = yield* f.marker(
              mode < 0.3 ? undefined : mode < 0.6 ? pick(users) : MessageID.make(`msg_missing_${index}_${position}`),
            )
            users.push(marker)
            const finish = random() < 0.75 ? "stop" : undefined
            yield* f.assistant(marker, {
              summary: true,
              finish,
              ...(random() < 0.25 ? { error: failure() } : {}),
            })
          }
          yield* sameAsFullRead(sessionID)
        }),
      ),
    )
  }
})

describe("HistoryView cache", () => {
  it.instance("reads through the process cache and keeps the version across invalidation", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        yield* f.user("prompt")
        const first = yield* HistoryView.get(sessionID)
        expect(first.stable).toBe(true)
        expect(first.history).toHaveLength(1)
        expect(first.version).toBe(HistoryView.version(sessionID))

        const check = yield* HistoryView.checkExternal(sessionID)
        expect(check).toBe("same")

        const second = yield* HistoryView.get(sessionID)
        expect(second.history).toBe(first.history)

        HistoryView.invalidateCache(sessionID)
        const reloaded = yield* HistoryView.get(sessionID)
        expect(reloaded.stable).toBe(true)
        expect(reloaded.version).toBe(first.version)
        expect(reloaded.history).toHaveLength(1)

        HistoryView.invalidateCache(sessionID)
      }),
    ),
  )
})

describe("HistoryView.freeze", () => {
  const id = SessionID.make("ses_freeze")
  const message = (messageID: string, text: string): SessionV1.WithParts =>
    ({
      info: {
        id: MessageID.make(messageID),
        sessionID: id,
        role: "user",
        time: { created: 1 },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
      },
      parts: [
        {
          id: PartID.make(`prt_${messageID}`),
          sessionID: id,
          messageID: MessageID.make(messageID),
          type: "text",
          text,
        },
      ],
    }) as unknown as SessionV1.WithParts

  test("freezes the array, messages, parts and info containers", () => {
    const history = [message("msg_1", "one"), message("msg_2", "two")]
    const frozen = HistoryView.freeze(history)

    expect(Object.isFrozen(frozen)).toBe(true)
    for (const entry of frozen) {
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.isFrozen(entry.info)).toBe(true)
      expect(Object.isFrozen(entry.info.time)).toBe(true)
      expect(Object.isFrozen(entry.parts)).toBe(true)
      expect(Object.isFrozen(entry.parts[0])).toBe(true)
    }
  })

  test("throws on the in-place edits the request path used to make", () => {
    const history = [message("msg_1", "one")]
    const frozen = HistoryView.freeze(history)

    expect(() => frozen.push(message("msg_2", "two"))).toThrow()
    expect(() => frozen[0]!.parts.push(frozen[0]!.parts[0]!)).toThrow()
    expect(() => {
      if (frozen[0]!.info.role === "user") frozen[0]!.info.time.consumed = 1
    }).toThrow()
    expect(() => {
      const part = frozen[0]!.parts[0]!
      if (part.type === "text") part.text = "changed"
    }).toThrow()
  })

  test("handles shared references without recursing forever", () => {
    const shared = message("msg_1", "one").parts
    const history = [
      { ...message("msg_2", "two"), parts: shared },
      { ...message("msg_3", "three"), parts: shared },
    ] as SessionV1.WithParts[]

    const frozen = HistoryView.freeze(history)

    expect(Object.isFrozen(shared)).toBe(true)
    expect(frozen).toHaveLength(2)
  })
})
