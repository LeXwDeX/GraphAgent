// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// What `graphagent run` takes from a piped stdin (Issue #1546).
//
// With no message on the command line, stdin is the message and is read to EOF. With a message it is only extra
// context, and a writer that sends nothing must not hold the run: a pipe that an agent or a CI step keeps open never
// reaches EOF. Such a run waits a short window for the first chunk, then goes on without stdin and releases it, so
// that the pending read cannot keep the process alive.

/** How long a run that already has a message waits for the first chunk of piped stdin. */
export const PIPED_STDIN_WINDOW_MS = 1000

/** A one-shot timer: `after` calls `fire` once `ms` have passed, and the function it returns drops the timer. */
export type Clock = {
  readonly after: (ms: number, fire: () => void) => () => void
}

const systemClock: Clock = {
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms)
    return () => clearTimeout(timer)
  },
}

/** The command-line message with the piped text after it on a new line; either of them may be missing. */
export function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

/** The first read of `reader`, or `undefined` when `windowMs` passes before it settles; the end of stream settles it. */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, windowMs: number, clock: Clock) {
  let drop = () => {}
  const expired = new Promise<undefined>((resolve) => {
    drop = clock.after(windowMs, () => resolve(undefined))
  })
  try {
    return await Promise.race([reader.read(), expired])
  } finally {
    drop()
  }
}

/**
 * The text piped into stdin, or `undefined` when a run that has a message got no first chunk within the window.
 * `stream` is the stdin of the process and `hasMessage` says whether the command line already carries the message.
 * Once a chunk has arrived the rest is read to EOF, whatever the message.
 */
export async function readPipedInput(input: {
  readonly stream: ReadableStream<Uint8Array>
  readonly hasMessage: boolean
  readonly windowMs?: number
  readonly clock?: Clock
}): Promise<string | undefined> {
  const reader = input.stream.getReader()
  const first = input.hasMessage
    ? await readWithin(reader, input.windowMs ?? PIPED_STDIN_WINDOW_MS, input.clock ?? systemClock)
    : await reader.read()
  if (first === undefined) {
    // Cancelling ends the pending read: an unreleased one keeps the process from exiting until the writer closes.
    await reader.cancel().catch(() => {})
    return undefined
  }
  // A streaming decoder keeps a character that is split across two chunks whole.
  const decoder = new TextDecoder()
  let text = ""
  let chunk = first
  while (!chunk.done) {
    text += decoder.decode(chunk.value, { stream: true })
    chunk = await reader.read()
  }
  return text + decoder.decode()
}
