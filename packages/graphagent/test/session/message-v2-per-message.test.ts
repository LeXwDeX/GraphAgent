// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")
const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
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

function userInfo(id: string, created = 0): SessionV1.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "user",
    model: { providerID, modelID: ModelV2.ID.make("test") },
    tools: {},
    mode: "",
  } as unknown as SessionV1.User
}

function assistantInfo(
  id: string,
  parentID: string,
  input?: {
    created?: number
    summary?: boolean
    finish?: string
    error?: SessionV1.Assistant["error"]
    meta?: { providerID: string; modelID: string }
  },
): SessionV1.Assistant {
  const infoModel = input?.meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: input?.created ?? 0 },
    error: input?.error,
    summary: input?.summary,
    finish: input?.finish,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

function part(messageID: string, id: string, value: Record<string, unknown>): SessionV1.Part {
  return { ...basePart(messageID, id), ...value } as unknown as SessionV1.Part
}

/** Both paths must produce the same model-visible messages, byte for byte. */
async function compare(
  input: SessionV1.WithParts[],
  requestModel: Provider.Model = model,
  options?: MessageV2.ToModelMessagesOptions,
) {
  const batched = await MessageV2.toModelMessages(input, requestModel, options)
  const incremental = await MessageV2.toModelMessagesPerMessage(input, requestModel, options)
  expect(incremental).toEqual(batched)
  return batched
}

const conversation = (): SessionV1.WithParts[] => [
  {
    info: userInfo("m1"),
    parts: [
      part("m1", "p1", { type: "text", text: "hello" }),
      part("m1", "p2", { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "a.png" }),
    ],
  },
  {
    info: assistantInfo("m2", "m1"),
    parts: [
      part("m2", "p3", { type: "step-start" }),
      part("m2", "p4", { type: "reasoning", text: "thinking", metadata: { anthropic: { signature: "sig" } } }),
      part("m2", "p5", {
        type: "tool",
        tool: "read",
        callID: "call_1",
        metadata: { providerExecuted: true },
        state: {
          status: "completed",
          input: { path: "a.ts" },
          output: "contents",
          attachments: [],
          time: { start: 0, end: 1 },
        },
      }),
      part("m2", "p6", { type: "text", text: "done" }),
    ],
  },
  {
    info: userInfo("m3", 2),
    parts: [part("m3", "p7", { type: "text", text: "next" })],
  },
]

describe("MessageV2.toModelMessagesPerMessage", () => {
  test("matches the batched conversion for a mixed conversation", async () => {
    const messages = await compare(conversation())
    expect(messages.length).toBeGreaterThan(0)
  })

  test("matches when a tool result injects a synthetic attachment message", async () => {
    const xai: Provider.Model = { ...model, api: { ...model.api, npm: "@ai-sdk/xai" } }
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo("m1"),
        parts: [part("m1", "p1", { type: "text", text: "look" })],
      },
      {
        info: assistantInfo("m2", "m1"),
        parts: [
          part("m2", "p2", {
            type: "tool",
            tool: "read",
            callID: "call_1",
            state: {
              status: "completed",
              input: {},
              output: "pdf",
              attachments: [
                { mime: "application/pdf", url: "data:application/pdf;base64,BBBB", filename: "b.pdf" },
                { mime: "image/png", url: "data:image/png;base64,CCCC", filename: "c.png" },
              ],
              time: { start: 0, end: 1 },
            },
          }),
        ],
      },
    ]

    const messages = await compare(input, xai)
    expect(messages.some((message) => message.role === "user")).toBe(true)
  })

  test("matches when the assistant used a different model", async () => {
    const input: SessionV1.WithParts[] = [
      { info: userInfo("m1"), parts: [part("m1", "p1", { type: "text", text: "hello" })] },
      {
        info: assistantInfo("m2", "m1", { meta: { providerID: "other", modelID: "other-model" } }),
        parts: [
          part("m2", "p2", { type: "reasoning", text: "opaque", metadata: {} }),
          part("m2", "p3", { type: "text", text: "", providerMetadata: {} }),
        ],
      },
    ]

    await compare(input)
  })

  test("matches around a completed compaction boundary", async () => {
    const input: SessionV1.WithParts[] = [
      { info: userInfo("m1", 0), parts: [part("m1", "p1", { type: "text", text: "old" })] },
      {
        info: assistantInfo("m2", "m1", { created: 1, finish: "stop" }),
        parts: [part("m2", "p2", { type: "reasoning", text: "old thinking", metadata: {} })],
      },
      {
        info: userInfo("m3", 2),
        parts: [part("m3", "p3", { type: "compaction" }), part("m3", "p4", { type: "text", text: "summary" })],
      },
      {
        info: assistantInfo("m4", "m3", { created: 3, summary: true, finish: "stop" }),
        parts: [part("m4", "p5", { type: "text", text: "summary text" })],
      },
      { info: userInfo("m5", 4), parts: [part("m5", "p6", { type: "text", text: "after" })] },
    ]

    await compare(input)
  })

  test("matches under every conversion option", async () => {
    const input = conversation()
    for (const options of [
      { stripMedia: true },
      { toolOutputMaxChars: 3 },
      { reasoningDistillationEnabled: true },
      { stripSignedThinking: true },
      { stripOpaqueReasoning: true },
    ])
      await compare(input, model, options)
  })

  test("matches when tool errors and pending calls need interruption output", async () => {
    const input: SessionV1.WithParts[] = [
      { info: userInfo("m1"), parts: [part("m1", "p1", { type: "text", text: "go" })] },
      {
        info: assistantInfo("m2", "m1"),
        parts: [
          part("m2", "p2", {
            type: "tool",
            tool: "read",
            callID: "call_1",
            state: { status: "error", input: {}, error: "boom", metadata: { interrupted: true, output: "partial" } },
          }),
          part("m2", "p3", {
            type: "tool",
            tool: "bash",
            callID: "call_2",
            state: { status: "running", input: {} },
          }),
        ],
      },
    ]

    await compare(input)
  })
})
