import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { ModelMessage } from "ai"
import { Effect } from "effect"
import type { Provider } from "@/provider/provider"
import { EngineProcess } from "../../src/session/engine-process"
import { freeze } from "../../src/session/history/freeze"
import {
  bucket,
  contentDigest,
  forgetSession,
  lookup,
  makeModelHistoryState,
  size,
  store,
  trusted,
} from "../../src/session/history/model"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const providerID = ProviderV2.ID.make("test")
const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const sessionID = SessionID.make("ses_model_history")
const messageID = MessageID.make("msg_model_history")
const partID = PartID.make("prt_model_history")

const message = (text: string) =>
  ({
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "user",
      model: { providerID, modelID: model.api.id },
      tools: {},
      mode: "",
    },
    parts: [{ id: partID, sessionID, messageID, type: "text", text }],
  }) as unknown as SessionV1.WithParts

const frozen = (text: string) => {
  const value = message(text)
  freeze([value])
  return value
}

const fragment = (text: string) => [{ role: "user", content: text }] as unknown as ModelMessage[]

describe("ModelHistory cache primitives", () => {
  test("keys the bucket by the conversion model and options only", () => {
    expect(bucket(model)).toBe(bucket(model))
    expect(bucket(model, {})).toBe(bucket(model))
    expect(bucket(model, { cache: "bypass" } as never)).toBe(bucket(model))
    expect(bucket(model, { stripMedia: true })).not.toBe(bucket(model))
    expect(bucket(model, { toolOutputMaxChars: 10 })).not.toBe(bucket(model))
    expect(bucket({ ...model, api: { ...model.api, npm: "@ai-sdk/xai" } })).not.toBe(bucket(model))
    expect(bucket({ ...model, api: { ...model.api, id: "other" } })).not.toBe(bucket(model))
  })

  test("changes the content digest with any wire-visible field", () => {
    expect(contentDigest(frozen("one"))).toBe(contentDigest(frozen("one")))
    expect(contentDigest(frozen("one"))).not.toBe(contentDigest(frozen("two")))
  })

  test("stores only deeply frozen messages", () => {
    const state = makeModelHistoryState()
    store(state, sessionID, "bucket", message("plain"), 0, fragment("plain"))
    expect(state.entries.size).toBe(0)

    const value = frozen("frozen")
    expect(trusted(value)).toBe(true)
    expect(Object.isFrozen(value.parts[0]!)).toBe(true)
    store(state, sessionID, "bucket", value, 0, fragment("cached"))
    expect(state.entries.size).toBe(1)
  })

  test("returns a structural copy and touches the entry", () => {
    const state = makeModelHistoryState()
    const value = frozen("cached")
    store(state, sessionID, "bucket", value, 0, fragment("cached"))

    const first = lookup(state, sessionID, "bucket", value, 0)!
    expect(first).toEqual(fragment("cached"))
    expect(first).not.toBe(lookup(state, sessionID, "bucket", value, 0))
    first[0]!.content = "mutated"

    expect(lookup(state, sessionID, "bucket", value, 0)).toEqual(fragment("cached"))
  })

  test("misses when the boundary effect or content changes", () => {
    const state = makeModelHistoryState()
    const value = frozen("cached")
    store(state, sessionID, "bucket", value, 0, fragment("cached"))

    expect(lookup(state, sessionID, "bucket", value, 1)).toBeUndefined()
    expect(lookup(state, sessionID, "bucket", frozen("other"), 0)).toBeUndefined()
  })

  test("reuses a fragment after the message object is replaced with equal content", () => {
    const state = makeModelHistoryState()
    store(state, sessionID, "bucket", frozen("cached"), 0, fragment("cached"))

    expect(lookup(state, sessionID, "bucket", frozen("cached"), 0)).toEqual(fragment("cached"))
  })

  test("does not cache fragments carrying inline media", () => {
    const state = makeModelHistoryState()
    const value = frozen("cached")
    store(state, sessionID, "bucket", value, 0, [{ role: "user", content: "data:image/png;base64,AAAA" }] as never)
    expect(state.entries.size).toBe(0)
  })

  test("does not cache oversized fragments", () => {
    const state = makeModelHistoryState()
    store(state, sessionID, "bucket", frozen("cached"), 0, fragment("x".repeat(1024 * 1024 + 1)))
    expect(state.entries.size).toBe(0)
  })

  test("evicts the oldest entries over the byte budget and keeps the newest", () => {
    const state = makeModelHistoryState(1)
    store(state, sessionID, "first", frozen("one"), 0, fragment("one"))
    store(state, sessionID, "second", frozen("two"), 0, fragment("two"))

    expect(size(state).entries).toBe(1)
    expect(lookup(state, sessionID, "second", frozen("two"), 0)).toBeDefined()
    expect(lookup(state, sessionID, "first", frozen("one"), 0)).toBeUndefined()
  })

  test("forgets every entry and its bytes for one session", () => {
    const state = makeModelHistoryState()
    const other = SessionID.make("ses_model_history_other")
    store(state, sessionID, "bucket", frozen("one"), 0, fragment("one"))
    const otherMessage = {
      ...message("two"),
      info: { ...message("two").info, sessionID: other },
    } as unknown as SessionV1.WithParts
    freeze([otherMessage])
    store(state, other, "bucket", otherMessage, 0, fragment("two"))
    expect(size(state).entries).toBe(2)

    forgetSession(state, sessionID)
    expect(size(state).entries).toBe(1)
    expect(lookup(state, sessionID, "bucket", frozen("one"), 0)).toBeUndefined()
    expect(lookup(state, other, "bucket", otherMessage, 0)).toBeDefined()
  })
})

describe("MessageV2 conversion cache", () => {
  const run = (input: SessionV1.WithParts[], options?: MessageV2.ToModelMessagesOptions) =>
    MessageV2.toModelMessages(input, model, options)
  const conversions = () => EngineProcess.runtimes.modelHistory.metrics.conversions
  const cacheSession = SessionID.make("ses_model_history_conversion")

  const conversation = () => {
    const user = {
      info: {
        id: MessageID.make("msg_model_history_u1"),
        sessionID: cacheSession,
        role: "user",
        time: { created: 1 },
        agent: "user",
        model: { providerID, modelID: model.api.id },
        tools: {},
        mode: "",
      },
      parts: [
        {
          id: PartID.make("prt_model_history_p1"),
          sessionID: cacheSession,
          messageID: MessageID.make("msg_model_history_u1"),
          type: "text",
          text: "hello",
        },
      ],
    } as unknown as SessionV1.WithParts
    const assistant = {
      info: {
        id: MessageID.make("msg_model_history_a1"),
        sessionID: cacheSession,
        role: "assistant",
        time: { created: 2 },
        parentID: MessageID.make("msg_model_history_u1"),
        modelID: model.api.id,
        providerID: model.providerID,
        mode: "",
        agent: "agent",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: PartID.make("prt_model_history_p2"),
          sessionID: cacheSession,
          messageID: MessageID.make("msg_model_history_a1"),
          type: "text",
          text: "hi",
        },
      ],
    } as unknown as SessionV1.WithParts
    return freeze([user, assistant])
  }

  test("converts once and then serves the frozen view without conversion", async () => {
    const input = conversation()
    const before = conversions()

    expect(await run(input)).toHaveLength(2)
    expect(conversions() - before).toBe(2)

    const warm = conversions()
    expect(await run(input)).toHaveLength(2)
    expect(conversions() - warm).toBe(0)

    forgetSession(EngineProcess.runtimes.modelHistory, cacheSession)
  })

  test("converts only the appended message on the next step", async () => {
    const input = conversation()
    await run(input)
    const before = conversions()

    const next = {
      info: {
        id: MessageID.make("msg_model_history_u2"),
        sessionID: cacheSession,
        role: "user",
        time: { created: 3 },
        agent: "user",
        model: { providerID, modelID: model.api.id },
        tools: {},
        mode: "",
      },
      parts: [
        {
          id: PartID.make("prt_model_history_p3"),
          sessionID: cacheSession,
          messageID: MessageID.make("msg_model_history_u2"),
          type: "text",
          text: "next",
        },
      ],
    } as unknown as SessionV1.WithParts
    freeze([next])

    const view = freeze([...input, next])
    expect(await run(view)).toHaveLength(3)
    expect(conversions() - before).toBe(1)

    forgetSession(EngineProcess.runtimes.modelHistory, cacheSession)
  })

  test("bypass and verify keep the batched path as the oracle", async () => {
    const input = conversation()
    const before = conversions()
    expect(await run(input, { cache: "bypass" })).toHaveLength(2)
    expect(conversions() - before).toBe(2)

    forgetSession(EngineProcess.runtimes.modelHistory, cacheSession)
    const verifying = conversions()
    expect(await run(input, { cache: "verify" })).toHaveLength(2)
    // verify converts once incrementally and once through the batched oracle
    expect(conversions() - verifying).toBe(4)

    forgetSession(EngineProcess.runtimes.modelHistory, cacheSession)
  })

  test("separates cache entries by request model", async () => {
    const input = conversation()
    await run(input)
    const before = conversions()

    const xai: Provider.Model = { ...model, api: { ...model.api, npm: "@ai-sdk/xai" } }
    expect(await MessageV2.toModelMessages(input, xai)).toHaveLength(2)
    expect(conversions() - before).toBe(2)

    forgetSession(EngineProcess.runtimes.modelHistory, cacheSession)
  })
})

describe("ModelHistory lifecycle and boundaries", () => {
  const session = SessionID.make("ses_model_history_lifecycle")
  const conversions = () => EngineProcess.runtimes.modelHistory.metrics.conversions

  const textPart = (messageID: string, id: string, text: string) =>
    ({
      id: PartID.make(id),
      sessionID: session,
      messageID: MessageID.make(messageID),
      type: "text",
      text,
    }) as unknown as SessionV1.Part

  const compactionPart = (messageID: string, id: string) =>
    ({
      id: PartID.make(id),
      sessionID: session,
      messageID: MessageID.make(messageID),
      type: "compaction",
    }) as unknown as SessionV1.Part

  const user = (id: string, created: number, parts: SessionV1.Part[]) =>
    ({
      info: {
        id: MessageID.make(id),
        sessionID: session,
        role: "user",
        time: { created },
        agent: "user",
        model: { providerID, modelID: model.api.id },
        tools: {},
        mode: "",
      },
      parts,
    }) as unknown as SessionV1.WithParts

  const assistant = (
    id: string,
    parentID: string,
    created: number,
    extra: { summary?: boolean; finish?: string },
    parts: SessionV1.Part[],
  ) =>
    ({
      info: {
        id: MessageID.make(id),
        sessionID: session,
        role: "assistant",
        time: { created },
        parentID: MessageID.make(parentID),
        modelID: model.api.id,
        providerID: model.providerID,
        mode: "",
        agent: "agent",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        ...extra,
      },
      parts,
    }) as unknown as SessionV1.WithParts

  const conversation = () =>
    freeze([
      user("msg_life_u1", 1, [textPart("msg_life_u1", "prt_life_p1", "hello")]),
      assistant("msg_life_a1", "msg_life_u1", 2, { finish: "stop" }, [textPart("msg_life_a1", "prt_life_p2", "hi")]),
    ])

  test("drops entries when the session runtime is removed", async () => {
    const input = conversation()
    await MessageV2.toModelMessages(input, model)
    expect(lookup(EngineProcess.runtimes.modelHistory, session, bucket(model), input[0]!, 0)).toBeDefined()

    await Effect.runPromise(EngineProcess.runtimes.remove(session))

    expect(lookup(EngineProcess.runtimes.modelHistory, session, bucket(model), input[0]!, 0)).toBeUndefined()
    expect(size(EngineProcess.runtimes.modelHistory).entries).toBe(0)
  })

  test("drops entries owned by a disposed directory", async () => {
    const input = conversation()
    EngineProcess.runtimes.own(session, "model-history-test-directory")
    await MessageV2.toModelMessages(input, model)
    expect(size(EngineProcess.runtimes.modelHistory).entries).toBeGreaterThan(0)

    await EngineProcess.runtimes.purgeDirectory("model-history-test-directory")

    expect(size(EngineProcess.runtimes.modelHistory).entries).toBe(0)
  })

  test("reuses fragments after the view is rebuilt with equal objects", async () => {
    await MessageV2.toModelMessages(conversation(), model)
    const before = conversions()

    const rebuilt = conversation()
    await MessageV2.toModelMessages(rebuilt, model)
    expect(conversions() - before).toBe(0)

    forgetSession(EngineProcess.runtimes.modelHistory, session)
  })

  test("never caches derived, unfrozen messages", async () => {
    const plain = {
      ...conversation()[0]!,
      info: { ...conversation()[0]!.info },
      parts: [...conversation()[0]!.parts],
    } as SessionV1.WithParts
    const before = conversions()

    await MessageV2.toModelMessages([plain], model)
    await MessageV2.toModelMessages([plain], model)

    expect(conversions() - before).toBe(2)
    expect(size(EngineProcess.runtimes.modelHistory).entries).toBe(0)
    forgetSession(EngineProcess.runtimes.modelHistory, session)
  })

  test("reconverts only the messages whose boundary bit flips", async () => {
    const base = freeze([
      user("msg_life_u1", 1, [textPart("msg_life_u1", "prt_life_p1", "hello")]),
      assistant("msg_life_a1", "msg_life_u1", 2, { finish: "stop" }, [textPart("msg_life_a1", "prt_life_p2", "old")]),
      user("msg_life_u2", 3, [compactionPart("msg_life_u2", "prt_life_p3")]),
      assistant("msg_life_a2", "msg_life_u2", 4, { summary: true, finish: "stop" }, [
        textPart("msg_life_a2", "prt_life_p4", "summary one"),
      ]),
      user("msg_life_u3", 5, [compactionPart("msg_life_u3", "prt_life_p5")]),
    ])
    await MessageV2.toModelMessages(base, model)
    const before = conversions()

    const extended = freeze([
      ...base,
      assistant("msg_life_a3", "msg_life_u3", 6, { summary: true, finish: "stop" }, [
        textPart("msg_life_a3", "prt_life_p6", "summary two"),
      ]),
    ])
    await MessageV2.toModelMessages(extended, model)

    // The new summary plus the assistant whose boundary bit flipped; every
    // other cached message is reused.
    expect(conversions() - before).toBe(2)
    forgetSession(EngineProcess.runtimes.modelHistory, session)
  })

  test("deep-freezes the nested metadata the conversion reads", () => {
    const input = freeze([
      assistant("msg_life_deep", "msg_life_u1", 2, { finish: "stop" }, [
        {
          ...textPart("msg_life_deep", "prt_life_deep", "x"),
          metadata: { anthropic: { signature: "sig" } },
        } as SessionV1.Part,
      ]),
    ])
    const part = input[0]!.parts[0]! as SessionV1.Part & { metadata: { anthropic: { signature: string } } }

    expect(Object.isFrozen(part.metadata)).toBe(true)
    expect(Object.isFrozen(part.metadata.anthropic)).toBe(true)
    expect(() => {
      part.metadata.anthropic.signature = "changed"
    }).toThrow()
  })
})
