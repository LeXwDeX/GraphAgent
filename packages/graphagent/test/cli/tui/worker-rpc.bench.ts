// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end frame transport benchmark for the TUI <-> Worker bridge.
 *
 * The legacy bridge stringified the whole frame and parsed it on the main
 * thread; the new one posts objects and lets the runtime structured-clone
 * them. Both paths include the receiving side's decoding work so the numbers
 * are comparable. Run with:
 *
 *   bun run test/cli/tui/worker-rpc.bench.ts
 */
import { MessageChannel, type MessagePort } from "node:worker_threads"

const EVENTS_PER_FRAME = 100
const FRAMES = 100
const WARMUP = 10

const event = {
  type: "message.part.updated",
  properties: {
    sessionID: "ses_bench",
    part: {
      id: "prt_bench",
      messageID: "msg_bench",
      sessionID: "ses_bench",
      type: "tool",
      tool: "bash",
      callID: "call_bench",
      state: {
        status: "running",
        title: "bash",
        input: { command: "bun run typecheck", description: "Run typecheck" },
        time: { start: 1 },
      },
    },
  },
}
const frame = { t: "evt", name: "events", data: Array.from({ length: EVENTS_PER_FRAME }, () => event) }

async function measure(post: (port: MessagePort) => void, receive: (data: unknown) => void) {
  const { port1, port2 } = new MessageChannel()
  try {
    let received = 0
    let resolve!: () => void
    const done = new Promise<void>((next) => (resolve = next))
    port1.onmessage = (message) => {
      receive(message.data)
      if (++received === FRAMES) resolve()
    }
    const start = performance.now()
    for (let index = 0; index < FRAMES; index++) post(port2)
    await done
    return (performance.now() - start) / FRAMES
  } finally {
    port1.close()
    port2.close()
  }
}

async function warmup() {
  for (let index = 0; index < WARMUP; index++) {
    await measure(
      (port) => port.postMessage(frame),
      () => {},
    )
    await measure(
      (port) => port.postMessage(JSON.stringify(frame)),
      (data) => JSON.parse(data as string),
    )
  }
}

async function run() {
  await warmup()

  const structured = await measure(
    (port) => port.postMessage(frame),
    () => {},
  )
  const legacy = await measure(
    (port) => port.postMessage(JSON.stringify(frame)),
    (data) => JSON.parse(data as string),
  )

  console.log(`${EVENTS_PER_FRAME} events/frame, ${FRAMES} frames per sample`)
  console.log(`legacy json frame:   ${legacy.toFixed(3)} ms/frame`)
  console.log(`structured frame:    ${structured.toFixed(3)} ms/frame`)
  console.log(`structured / legacy: ${(structured / legacy).toFixed(2)}x`)
}

await run()
