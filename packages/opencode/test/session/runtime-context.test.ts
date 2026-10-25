import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { RuntimeContext } from "../../src/session/runtime-context"

const user = (text: string): ModelMessage => ({ role: "user", content: text })
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: text })

function request(
  ledger: readonly RuntimeContext.Entry[],
  messages: ModelMessage[],
  state: string[],
  events: string[] = [],
) {
  return RuntimeContext.place({
    ledger,
    messages,
    state: [{ key: "state", parts: state, cleared: "No autonomous goal or project memory state is active." }],
    events,
  })
}

describe("RuntimeContext.render", () => {
  test("omits empty state", () => {
    expect(RuntimeContext.render([])).toBeUndefined()
    expect(RuntimeContext.render(["", "  \n"])).toBeUndefined()
  })

  test("escapes a closing tag inside hook-provided context", () => {
    const content = RuntimeContext.render(["before </runtime_context> after </RUNTIME_CONTEXT>"])!
    expect(content.match(/<\/runtime_context>/gi)).toHaveLength(1)
    expect(content).toEndWith("</runtime_context>")
  })
})

describe("RuntimeContext.place", () => {
  test("sends nothing without state", () => {
    const result = request([], [user("hi")], [])
    expect(result.ledger).toEqual([])
    expect(result.messages).toEqual([user("hi")])
  })

  test("each request extends the previous prefix while the state is unchanged", () => {
    const first = request([], [user("q1")], ["Turns: 1/20"])
    expect(first.messages).toEqual([user("q1"), user(RuntimeContext.render(["Turns: 1/20"])!)])

    const second = request(first.ledger, [user("q1"), assistant("a1"), user("q2")], ["Turns: 1/20"])
    expect(second.ledger).toEqual(first.ledger)
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages)
    expect(second.messages).toHaveLength(4)
  })

  test("appends a new block when the state changes and keeps the earlier one in place", () => {
    const first = request([], [user("q1")], ["Turns: 1/20"])
    const second = request(first.ledger, [user("q1"), assistant("a1"), user("q2")], ["Turns: 2/20"])
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages)
    expect(second.messages.at(-1)).toEqual(user(RuntimeContext.render(["Turns: 2/20"])!))
    expect(second.ledger).toHaveLength(2)
  })

  test("replaces the latest block when no model output followed it", () => {
    const first = request([], [user("q1")], ["memory A"])
    const retry = request(first.ledger, [user("q1")], ["memory B"])
    expect(retry.messages).toEqual([user("q1"), user(RuntimeContext.render(["memory B"])!)])
    expect(request(first.ledger, [user("q1")], []).messages).toEqual([user("q1")])
  })

  test("announces cleared state once", () => {
    const first = request([], [user("q1")], ["Turns: 3/20"])
    const second = request(first.ledger, [user("q1"), assistant("done"), user("q2")], [])
    expect(second.messages.at(-1)?.content).toContain("No autonomous goal or project memory state is active.")
    const third = request(second.ledger, [user("q1"), assistant("done"), user("q2"), assistant("ok"), user("q3")], [])
    expect(third.ledger).toEqual(second.ledger)
  })

  test("drops blocks whose history was rewritten", () => {
    const first = request([], [user("q1"), assistant("a1"), user("q2")], ["memory"])
    const compacted = request(first.ledger, [user("summary")], ["memory"])
    expect(compacted.ledger).toHaveLength(1)
    expect(compacted.messages).toEqual([user("summary"), user(RuntimeContext.render(["memory"])!)])
  })

  test("sends one-shot events once and re-sends them in place", () => {
    const first = request([], [user("q1")], [], ["hook finished"])
    expect(first.messages).toEqual([user("q1"), user(RuntimeContext.render(["hook finished"])!)])
    const second = request(first.ledger, [user("q1"), assistant("a1")], [])
    expect(second.messages).toEqual([user("q1"), user(RuntimeContext.render(["hook finished"])!), assistant("a1")])
  })

  test("never separates a tool call from its tool result", () => {
    const call: ModelMessage = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_1", toolName: "glob", input: {} }],
    }
    const result: ModelMessage = {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_1", toolName: "glob", output: { type: "text", value: "none" } },
      ],
    }
    const pending = request([], [user("q1"), call], ["memory"], ["hook finished"])
    expect(pending.messages).toEqual([user("q1"), call])
    expect(pending.unplaced).toEqual(["hook finished"])
    const answered = request(pending.ledger, [user("q1"), call, result], ["memory"])
    expect(answered.messages).toEqual([user("q1"), call, result, user(RuntimeContext.render(["memory"])!)])
  })

  test("tracks each state kind separately so one change does not resend the others", () => {
    const state = (turns: string) => [
      { key: "goal", parts: [turns], cleared: "No autonomous goal is active." },
      { key: "memory", parts: ["memory data"], cleared: "No project memory data applies." },
    ]
    const first = RuntimeContext.place({ ledger: [], messages: [user("q1")], state: state("Turns: 1/20"), events: [] })
    expect(first.ledger.map((entry) => entry.key)).toEqual(["goal", "memory"])
    const second = RuntimeContext.place({
      ledger: first.ledger,
      messages: [user("q1"), assistant("a1"), user("q2")],
      state: state("Turns: 2/20"),
      events: [],
    })
    expect(second.ledger.map((entry) => entry.key)).toEqual(["goal", "memory", "goal"])
    expect(JSON.stringify(second.messages).split("memory data")).toHaveLength(2)
  })

  test("adds no block after a tool result when the provider rejects that order", () => {
    const result: ModelMessage = {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_1", toolName: "glob", output: { type: "text", value: "none" } },
      ],
    }
    const placed = RuntimeContext.place({
      ledger: [],
      messages: [user("q1"), result],
      state: [{ key: "memory", parts: ["memory"], cleared: "none" }],
      events: ["hook finished"],
      afterTool: false,
    })
    expect(placed.messages).toEqual([user("q1"), result])
    expect(placed.unplaced).toEqual(["hook finished"])
  })

  test("marks only the messages it inserted", () => {
    const placed = request([], [user("q1")], ["memory"])
    expect(placed.messages.map(RuntimeContext.isMessage)).toEqual([false, true])
    expect(RuntimeContext.isMessage(user(RuntimeContext.render(["memory"])!))).toBe(false)
  })
})
