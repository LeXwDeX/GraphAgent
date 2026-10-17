import { expect, test } from "bun:test"
import { createSessionAttention, type SessionAttentionUpdate } from "@opencode-ai/sdk/v2"

test("attention has no anonymous updates and ignores work after close", async () => {
  const rows: SessionAttentionUpdate[] = []
  const client = createSessionAttention({
    clientType: "terminal",
    send: async (update) => {
      rows.push(update)
    },
  })
  client.select()
  client.activity()
  client.view(true)
  await client.close()
  client.select("ses_too_late", true)
  client.activity()
  expect(rows).toEqual([])
})

test("attention coalesces activity and orders old close before the next session", async () => {
  const rows: SessionAttentionUpdate[] = []
  const client = createSessionAttention({
    clientType: "terminal",
    send: async (update) => {
      rows.push(update)
    },
  })
  try {
    client.select("ses_attention_first")
    for (let i = 0; i < 5; i++) client.activity()
    client.view(true)
    await Bun.sleep(140)
    expect(rows.at(-1)?.activity).toBe(5)
    expect(rows.at(-1)?.backgroundView).toBe(true)
    expect(rows.length).toBeLessThan(6)
    client.select("ses_attention_second", false)
    await client.close()
    const old = rows.filter((row) => row.sessionID === "ses_attention_first")
    const next = rows.filter((row) => row.sessionID === "ses_attention_second")
    expect(new Set(old.map((row) => row.clientID)).size).toBe(1)
    expect(old.at(-1)?.closed).toBe(true)
    expect(old.at(-1)?.backgroundView).toBe(false)
    expect(next.at(-1)?.closed).toBe(true)
    expect(old[0].clientID).not.toBe(next[0].clientID)
    const lastOld = old.at(-1)
    if (!lastOld) throw new Error("first attention client did not send an update")
    expect(rows.indexOf(lastOld)).toBeLessThan(rows.indexOf(next[0]))
    expect(
      rows.every((row) =>
        Object.keys(row).every((key) =>
          ["sessionID", "clientID", "clientType", "activity", "backgroundView", "closed"].includes(key),
        ),
      ),
    ).toBe(true)
  } finally {
    await client.close()
  }
})

test("attention contains asynchronous and synchronous send failures", async () => {
  for (const synchronous of [false, true]) {
    let calls = 0
    const delivered: SessionAttentionUpdate[] = []
    const client = createSessionAttention({
      clientType: "terminal",
      send: (update) => {
        if (++calls === 1) {
          if (synchronous) throw new Error("synchronous attention transport failure")
          return Promise.reject(new Error("asynchronous attention transport failure"))
        }
        delivered.push(update)
        return Promise.resolve()
      },
    })
    client.select("ses_attention_transport_fault", true)
    await Bun.sleep(0)
    client.select("ses_attention_after_fault", true)
    const closed = await client.close()
    expect(closed).toBeUndefined()
    expect(delivered.some((update) => update.sessionID === "ses_attention_after_fault" && update.closed)).toBe(true)
  }
})

test("an actual open background view renews its lease after fifteen seconds and close clears it", async () => {
  const rows: SessionAttentionUpdate[] = []
  const client = createSessionAttention({
    clientType: "terminal",
    send: async (update) => {
      rows.push(update)
    },
  })
  try {
    client.select("ses_attention_heartbeat", true)
    await Bun.sleep(15_100)
    expect(rows.filter((row) => row.backgroundView === true).length).toBeGreaterThanOrEqual(2)
    expect(new Set(rows.map((row) => row.clientID)).size).toBe(1)
    client.view(false)
    await client.close()
    expect(rows.at(-1)?.closed).toBe(true)
    expect(rows.at(-1)?.backgroundView).toBe(false)
  } finally {
    await client.close()
  }
}, 20_000)

test("attention close is bounded even when the sender ignores cancellation", async () => {
  let release: (() => void) | undefined
  let aborted = false
  let calls = 0
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const client = createSessionAttention({
    clientType: "terminal",
    send: async (_update, signal) => {
      calls++
      signal?.addEventListener(
        "abort",
        () => {
          aborted = true
        },
        { once: true },
      )
      await held
    },
  })
  client.select("ses_attention_stalled", true)
  await Bun.sleep(5)
  let closed = false
  const closing = client.close().then(() => {
    closed = true
  })
  try {
    await Bun.sleep(2_150)
    expect(closed).toBe(true)
    expect(aborted).toBe(true)
    expect(calls).toBe(2)
  } finally {
    release?.()
    await closing
  }
})

test("attention times out a real fetch and releases its abort listeners on close", async () => {
  const signals: AbortSignal[] = []
  let entered = false
  let release: ((response: Response) => void) | undefined
  const response = new Promise<Response>((resolve) => {
    release = resolve
  })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: () => {
      entered = true
      return response
    },
  })
  const client = createSessionAttention({
    clientType: "terminal",
    send: (_update, signal) => {
      signals.push(signal)
      return fetch(server.url, { signal })
    },
  })
  try {
    client.select("ses_real_stalled_fetch", true)
    for (let count = 0; count < 200; count++) {
      if (entered) break
      await Bun.sleep(5)
    }
    expect(entered).toBe(true)
    const started = performance.now()
    await client.close()
    expect(performance.now() - started).toBeLessThan(2_500)
    expect(signals.length).toBe(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  } finally {
    await client.close()
    release?.(new Response("finished"))
    await server.stop(true)
  }
})

test("timed out attention cannot hold the next session or mutate it with a late rejection", async () => {
  const rows: SessionAttentionUpdate[] = []
  const signals: AbortSignal[] = []
  let rejectLate: ((error: Error) => void) | undefined
  const late = new Promise<void>((_resolve, reject) => {
    rejectLate = reject
  })
  const client = createSessionAttention({
    clientType: "terminal",
    send: (update, signal) => {
      rows.push(update)
      signals.push(signal)
      return rows.length === 1 ? late : Promise.resolve()
    },
  })
  try {
    client.select("ses_timeout_old")
    await Bun.sleep(5)
    client.select("ses_timeout_new")
    await Bun.sleep(2_150)
    expect(signals[0]?.aborted).toBe(true)
    expect(rows.some((row) => row.sessionID === "ses_timeout_old" && row.closed)).toBe(true)
    expect(rows.at(-1)?.sessionID).toBe("ses_timeout_new")
    const snapshot = rows.slice()
    rejectLate?.(new Error("late ignored attention failure"))
    await Bun.sleep(0)
    expect(rows).toEqual(snapshot)
    await client.close()
    expect(rows.at(-1)).toMatchObject({ sessionID: "ses_timeout_new", closed: true })
  } finally {
    rejectLate?.(new Error("fixture cleanup"))
    await client.close()
  }
})

test("close retains queued old-session closes while aborting stale activity", async () => {
  const rows: SessionAttentionUpdate[] = []
  const client = createSessionAttention({
    clientType: "terminal",
    send: (update) => {
      rows.push(update)
      return rows.length === 1 ? new Promise<void>(() => {}) : Promise.resolve()
    },
  })
  client.select("ses_close_old")
  await Bun.sleep(5)
  client.select("ses_close_new")
  await client.close()
  expect(rows.filter((row) => row.closed).map((row) => row.sessionID)).toEqual(["ses_close_old", "ses_close_new"])
  expect(rows.every((row) => row.sessionID !== "ses_close_new" || row.closed)).toBe(true)
})
