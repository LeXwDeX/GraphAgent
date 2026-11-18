// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { jsonSchema, tool } from "ai"
import type { ModelMessage } from "ai"
import { ProbeFindings } from "./findings"
import { ProbePlan } from "./plan"
import type { ProbeTransport } from "./transport"

const PROMPT_STREAM = "Reply with the single word: ok"
const PROMPT_TOOL = `Call ${ProbePlan.TOOL_NAME} with text "ping".`
const PROMPT_LENGTH = "Count from 1 to 200, one number per line."
/** What the replay turns say the tool returned. */
const ECHO_TEXT = "ping"

// A tool the model can call but nothing executes: the probe only needs to see the call, and to replay it.
const echo = tool({
  description: "Echo the given text.",
  inputSchema: jsonSchema({ type: "object", properties: { text: { type: "string" } }, required: ["text"] }),
})

const user = (text: string): ModelMessage => ({ role: "user", content: text })

/**
 * The tool turn again, continued with the tool's result: the assistant message carries the call the endpoint made
 * and, in the with-variant, the reasoning it sent under the field it sent it, set the way the engine sets it
 * (`providerOptions.openaiCompatible`). Whether the endpoint takes the turn with and without that reasoning is the
 * replay finding.
 */
function replayMessages(
  call: ProbeFindings.ToolCallResult,
  reasoning: { field: ProbePlan.ReasoningField; text: string } | undefined,
): ModelMessage[] {
  return [
    user(PROMPT_TOOL),
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input }],
      // The reasoning goes back as the joined text even for `reasoning_details`, because that is what the engine
      // replays (`ProviderTransform.message` writes the joined reasoning parts under the field). The probe measures
      // whether the endpoint accepts the engine's replay, not whether it would accept the original objects.
      ...(reasoning === undefined
        ? {}
        : { providerOptions: { openaiCompatible: { [reasoning.field]: reasoning.text } } }),
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: call.id,
          toolName: call.name,
          output: { type: "text", value: ECHO_TEXT },
        },
      ],
    },
  ]
}

/**
 * A transport that stops at a budget: the call after the last one allowed throws, so a mistake in the plan can
 * never turn into more requests than the user was told to expect.
 */
export function limit(
  transport: ProbeTransport.Transport,
  max: number = ProbePlan.MAX_REQUESTS,
): ProbeTransport.Transport {
  let used = 0
  const take = () => {
    used += 1
    if (used > max) throw new Error(`probe request budget of ${max} exceeded`)
  }
  return {
    models: () => {
      take()
      return transport.models()
    },
    chat: (request) => {
      take()
      return transport.chat(request)
    },
  }
}

/**
 * Run the plan against one endpoint: say what will be sent, then send the probes in `PROBES` order, each at most
 * once, and analyze what came back. A probe that fails is a finding and the next one still runs. The replay probes
 * are sent only when the tool probe got a usable call and some reasoning text was seen to replay; `chatOk` says
 * whether any chat request was answered with a 2xx.
 */
export async function run(
  transport: ProbeTransport.Transport,
  ctx: ProbePlan.Context,
  announce: (count: number, tokens: number) => void,
): Promise<{ findings: ProbeFindings.Findings; chatOk: boolean }> {
  announce(ProbePlan.MAX_REQUESTS, ProbePlan.MAX_OUTPUT_TOKENS)
  const guarded = limit(transport)
  const tools = { [ProbePlan.TOOL_NAME]: echo }
  const maxOutputTokens = ProbePlan.MAX_OUTPUT_TOKENS

  let models: ProbeFindings.ModelsAttempt | undefined
  let stream: ProbeFindings.ChatAttempt | undefined
  let toolTurn: ProbeFindings.ChatAttempt | undefined
  let replayWith: ProbeFindings.ChatAttempt | undefined
  let replayWithout: ProbeFindings.ChatAttempt | undefined
  let length: ProbeFindings.ChatAttempt | undefined

  for (const probe of ProbePlan.PROBES) {
    switch (probe) {
      case "models":
        models = await guarded.models()
        break
      case "stream":
        stream = await guarded.chat({ messages: [user(PROMPT_STREAM)], maxOutputTokens })
        break
      case "tool":
        toolTurn = await guarded.chat({ messages: [user(PROMPT_TOOL)], tools, maxOutputTokens })
        break
      case "replay_with":
      case "replay_without": {
        const call = ProbeFindings.echoCall(toolTurn)
        const { field, text } = ProbeFindings.reasoningAcross(stream, toolTurn)
        // No tool turn to continue, or nothing to replay: both replay probes are skipped.
        if (call === undefined || field === undefined || text === "") break
        const reasoning = probe === "replay_with" ? { field, text } : undefined
        const turn = await guarded.chat({ messages: replayMessages(call, reasoning), tools, maxOutputTokens })
        if (probe === "replay_with") replayWith = turn
        else replayWithout = turn
        break
      }
      case "length":
        length = await guarded.chat({
          messages: [user(PROMPT_LENGTH)],
          maxOutputTokens: ProbePlan.LENGTH_PROBE_TOKENS,
        })
        break
    }
  }

  const results: ProbeFindings.Results = { models, stream, tool: toolTurn, replayWith, replayWithout, length }
  const chatOk = [stream, toolTurn, replayWith, replayWithout, length].some(
    (attempt) => attempt !== undefined && ProbeFindings.outcomeOf(attempt) === "ok",
  )
  return { findings: ProbeFindings.analyze(results, ctx.apiID), chatOk }
}

export * as ProbeRun from "./run"
