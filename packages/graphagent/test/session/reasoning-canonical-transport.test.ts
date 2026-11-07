import { describe, expect, test } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import {
  assessCanonicalReasoning,
  replaceCanonicalReasoning,
} from "@opencode-ai/core/session/reasoning-distillation/canonical"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

describe("canonical reasoning through pinned OpenRouter SDK", () => {
  test("edits the persisted plaintext pair and sends matching text and details without changing shape", async () => {
    const detail = { type: "reasoning.text", text: "ORIGINAL", format: "unknown", index: 0 }
    const bodies: unknown[] = []
    const mockFetch: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
        expect(url).toBe("https://mock.invalid/api/v1/chat/completions")
        if (typeof init?.body !== "string") throw new Error("missing mock request body")
        bodies.push(JSON.parse(init.body))
        return new Response(
          JSON.stringify({
            id: "synthetic",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "answer",
                  reasoning_details: [detail],
                },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
      { preconnect: () => {} },
    )
    const provider = createOpenRouter({
      apiKey: "synthetic-key",
      baseURL: "https://mock.invalid/api/v1",
      fetch: mockFetch,
    })
    const model = provider.chat("synthetic/model")
    const initial = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "synthetic prompt" }] }],
    })
    const part = initial.content.find((item) => item.type === "reasoning")
    expect(part?.type).toBe("reasoning")
    if (!part || part.type !== "reasoning") throw new Error("missing synthetic reasoning")
    const source = { text: part.text, metadata: part.providerMetadata, settled: true, distilled: false }
    expect(assessCanonicalReasoning(source).editable).toBe(true)
    const edited = replaceCanonicalReasoning(source, "DISTILLED")
    expect(edited).toBeDefined()
    if (!edited) throw new Error("canonical edit failed")
    const isProviderOptions = (
      value: Record<string, unknown> | undefined,
    ): value is NonNullable<typeof part.providerMetadata> => value !== undefined && Object.values(value).every(record)
    if (!isProviderOptions(edited.metadata)) throw new Error("missing edited provider options")
    await model.doGenerate({
      prompt: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: edited.text, providerOptions: edited.metadata },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    })
    expect(bodies).toHaveLength(2)
    const wire = bodies[1]
    if (!record(wire) || !Array.isArray(wire.messages)) throw new Error("missing mock messages")
    const assistant = wire.messages.find((message: unknown) => record(message) && message.role === "assistant")
    if (!record(assistant)) throw new Error("missing mock assistant")
    expect(assistant?.reasoning).toBe("DISTILLED")
    expect(assistant?.reasoning_details).toEqual([{ ...detail, text: "DISTILLED" }])
    if (!Array.isArray(assistant.reasoning_details) || !record(assistant.reasoning_details[0]))
      throw new Error("missing mock reasoning detail")
    expect(Object.keys(assistant.reasoning_details[0])).toEqual(Object.keys(detail))
    expect(detail.text).toBe("ORIGINAL")
  })
})
