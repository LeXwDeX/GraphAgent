// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Regression for #1546: `graphagent run "<message>"` hung on a piped stdin whose writer never closes it. With a
// message, stdin is only waited for within a short window; without one it is the message and is read to EOF.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { PIPED_STDIN_WINDOW_MS, readPipedInput, resolveRunInput, type Clock } from "@/cli/cmd/run/piped-input"
import { tmpdir } from "../../fixture/fixture"

const encoder = new TextEncoder()

/** A stdin that the test writes to like the other end of a pipe; `state` says whether the reader released it. */
function pipe() {
  const state = { cancelled: false }
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller
    },
    cancel() {
      state.cancelled = true
    },
  })
  const open = () => {
    if (!sink) throw new Error("the stream did not start")
    return sink
  }
  return {
    stream,
    state,
    write: (data: string | Uint8Array) => open().enqueue(typeof data === "string" ? encoder.encode(data) : data),
    close: () => open().close(),
  }
}

/** A clock that only moves when the test says so. */
function manualClock() {
  const timers = new Map<number, () => void>()
  const waits: number[] = []
  const clock: Clock = {
    after: (ms, fire) => {
      const id = waits.push(ms)
      timers.set(id, fire)
      return () => void timers.delete(id)
    },
  }
  return {
    clock,
    /** The `ms` of every timer ever scheduled. */
    waits,
    /** Timers that neither fired nor were dropped. */
    pending: () => timers.size,
    /** The window passes: every timer still waiting fires. */
    elapse: () => {
      const due = [...timers.values()]
      timers.clear()
      for (const fire of due) fire()
    },
  }
}

describe("readPipedInput with a message on the command line", () => {
  test("goes on without stdin when no chunk comes within the window, and releases stdin", async () => {
    const stdin = pipe()
    const time = manualClock()
    let settled = false
    const read = readPipedInput({ stream: stdin.stream, hasMessage: true, clock: time.clock }).then((text) => {
      settled = true
      return text
    })

    await Bun.sleep(0)
    expect(settled).toBe(false)
    expect(time.waits).toEqual([PIPED_STDIN_WINDOW_MS])
    expect(stdin.state.cancelled).toBe(false)

    time.elapse()
    const piped = await read
    expect(piped).toBeUndefined()
    expect(stdin.state.cancelled).toBe(true)
    expect(time.pending()).toBe(0)
    expect(resolveRunInput("summarize the log", piped)).toBe("summarize the log")
  })

  test("waits on the system clock when no clock is given", async () => {
    const stdin = pipe()
    const started = performance.now()

    expect(await readPipedInput({ stream: stdin.stream, hasMessage: true, windowMs: 30 })).toBeUndefined()

    expect(performance.now() - started).toBeGreaterThanOrEqual(20)
    expect(stdin.state.cancelled).toBe(true)
  })

  test("still goes on when stdin cannot be released cleanly", async () => {
    const time = manualClock()
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("cancel failed")
      },
    })
    const read = readPipedInput({ stream, hasMessage: true, clock: time.clock })

    await Bun.sleep(0)
    time.elapse()
    expect(await read).toBeUndefined()
  })

  test("merges what a writer sends at once before it closes", async () => {
    const stdin = pipe()
    const time = manualClock()
    stdin.write("line 1\nline 2\n")
    stdin.close()

    const piped = await readPipedInput({ stream: stdin.stream, hasMessage: true, clock: time.clock })

    expect(piped).toBe("line 1\nline 2\n")
    expect(resolveRunInput("summarize the log", piped)).toBe("summarize the log\nline 1\nline 2\n")
    expect(time.pending()).toBe(0)
    expect(stdin.state.cancelled).toBe(false)
  })

  test("reads to EOF once the first chunk has come, however late the rest is", async () => {
    const stdin = pipe()
    const time = manualClock()
    stdin.write("first ")
    const read = readPipedInput({ stream: stdin.stream, hasMessage: true, clock: time.clock })

    await Bun.sleep(0)
    expect(time.pending()).toBe(0)
    time.elapse()
    stdin.write("second ")
    await Bun.sleep(0)
    stdin.write("third")
    stdin.close()

    expect(await read).toBe("first second third")
    expect(stdin.state.cancelled).toBe(false)
  })

  test("reads an stdin that is already at EOF as empty text and merges nothing", async () => {
    const stdin = pipe()
    const time = manualClock()
    stdin.close()

    const piped = await readPipedInput({ stream: stdin.stream, hasMessage: true, clock: time.clock })

    expect(piped).toBe("")
    expect(resolveRunInput("summarize the log", piped)).toBe("summarize the log")
    expect(time.pending()).toBe(0)
  })

  test("keeps a character whole when its bytes are split across two chunks", async () => {
    const stdin = pipe()
    const bytes = encoder.encode("你好")
    stdin.write(bytes.slice(0, 2))
    stdin.write(bytes.slice(2))
    stdin.close()

    expect(await readPipedInput({ stream: stdin.stream, hasMessage: true, clock: manualClock().clock })).toBe("你好")
  })
})

describe("readPipedInput without a message", () => {
  test("reads to EOF however long it takes and sets no timer", async () => {
    const stdin = pipe()
    const time = manualClock()
    const read = readPipedInput({ stream: stdin.stream, hasMessage: false, clock: time.clock })

    await Bun.sleep(0)
    time.elapse()
    stdin.write("the whole ")
    await Bun.sleep(0)
    stdin.write("prompt")
    stdin.close()

    expect(await read).toBe("the whole prompt")
    expect(time.waits).toEqual([])
    expect(stdin.state.cancelled).toBe(false)
  })

  test("reads an stdin that is already at EOF as empty text", async () => {
    const stdin = pipe()
    stdin.close()

    expect(await readPipedInput({ stream: stdin.stream, hasMessage: false, clock: manualClock().clock })).toBe("")
  })
})

describe("resolveRunInput", () => {
  test("puts the piped text on a new line after the message, and either one alone", () => {
    expect(resolveRunInput("message", "piped")).toBe("message\npiped")
    expect(resolveRunInput("message", undefined)).toBe("message")
    expect(resolveRunInput("message", "")).toBe("message")
    expect(resolveRunInput("", "piped")).toBe("piped")
    expect(resolveRunInput(undefined, "piped")).toBe("piped")
    expect(resolveRunInput("", undefined)).toBeUndefined()
  })
})

// The unit cases above cannot tell whether a released stdin lets the process exit: a read that stays pending on a real
// pipe keeps it alive until the writer closes. These run the function over the real stdin of a child process that
// never calls process.exit, with the test holding the write end open.
describe("readPipedInput on the real stdin of a process", () => {
  const modulePath = path.resolve(import.meta.dir, "../../../src/cli/cmd/run/piped-input.ts")
  const HUNG_AFTER_MS = 8_000
  type Writer = { write: (data: string) => unknown; end: () => unknown }

  async function readInChild(hasMessage: boolean, drive: (stdin: Writer) => void | Promise<void>) {
    // A neutral directory keeps the package's bunfig preload out of the child.
    await using cwd = await tmpdir()
    const script = [
      `import { readPipedInput } from ${JSON.stringify(modulePath)}`,
      `const text = await readPipedInput({ stream: Bun.stdin.stream(), hasMessage: ${hasMessage}, windowMs: 50 })`,
      "console.log(JSON.stringify(text ?? null))",
    ].join("\n")
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: cwd.path,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      await drive(child.stdin)
      const exit = await Promise.race([child.exited, Bun.sleep(HUNG_AFTER_MS).then(() => "hung" as const)])
      if (exit === "hung") return { exit, text: undefined, stderr: "" }
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const text: unknown = JSON.parse(stdout)
      return { exit, text, stderr }
    } finally {
      child.kill()
    }
  }

  test("a pipe that never closes: goes on after the window and the process exits by itself", async () => {
    const result = await readInChild(true, () => {})

    expect(result).toEqual({ exit: 0, text: null, stderr: "" })
  }, 20_000)

  test("a pipe written to at once and closed: reads what was written", async () => {
    const result = await readInChild(true, (stdin) => {
      stdin.write("piped ")
      stdin.write("text")
      stdin.end()
    })

    expect(result).toEqual({ exit: 0, text: "piped text", stderr: "" })
  }, 20_000)

  test("without a message a writer that is late past the window is still read to EOF", async () => {
    const result = await readInChild(false, async (stdin) => {
      await Bun.sleep(300)
      stdin.write("late prompt")
      stdin.end()
    })

    expect(result).toEqual({ exit: 0, text: "late prompt", stderr: "" })
  }, 20_000)
})
