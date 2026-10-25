import { describe, expect, test } from "bun:test"
import { classifyRequest } from "../../src/plugin/github-copilot/copilot"

const runtime = "<runtime_context>\n\nmemory\n\n</runtime_context>"

describe("Copilot x-initiator classification", () => {
  test("completions: a real user turn is user-initiated, also with a runtime block after it", () => {
    const url = "https://api.githubcopilot.com/chat/completions"
    expect(classifyRequest(url, { messages: [{ role: "user", content: "fix it" }] }).isAgent).toBe(false)
    const withRuntime = {
      messages: [
        { role: "user", content: "fix it" },
        { role: "user", content: runtime },
      ],
    }
    expect(classifyRequest(url, JSON.stringify(withRuntime)).isAgent).toBe(false)
  })

  test("completions: a runtime block after a tool result keeps the agent attribution", () => {
    const url = "https://api.githubcopilot.com/chat/completions"
    const body = {
      messages: [
        { role: "user", content: "fix it" },
        { role: "assistant", tool_calls: [{ id: "call_1" }] },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
        { role: "user", content: runtime },
      ],
    }
    expect(classifyRequest(url, body).isAgent).toBe(true)
  })

  test("responses: a runtime block after a function call output keeps the agent attribution", () => {
    const url = "https://api.githubcopilot.com/responses"
    const body = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "fix it" }] },
        { type: "function_call", call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { role: "user", content: [{ type: "input_text", text: runtime }] },
      ],
    }
    expect(classifyRequest(url, body).isAgent).toBe(true)
  })

  test("messages: a runtime block merged into a tool-result turn keeps the agent attribution", () => {
    const url = "https://api.githubcopilot.com/v1/messages"
    const toolTurn = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "ok" },
            { type: "text", text: runtime },
          ],
        },
      ],
    }
    expect(classifyRequest(url, toolTurn).isAgent).toBe(true)
    const userTurn = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "fix it" },
            { type: "text", text: runtime },
          ],
        },
      ],
    }
    expect(classifyRequest(url, userTurn).isAgent).toBe(false)
  })
})
