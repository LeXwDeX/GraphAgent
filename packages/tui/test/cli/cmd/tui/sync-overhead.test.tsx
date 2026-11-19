// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createEffect, createRoot, onCleanup } from "solid-js"
import type { GlobalEvent, SessionOverhead } from "@graphagent/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { spyOverheadReads } from "../../../fixture/overhead-reads"
import { probeStoreWrites } from "../../../fixture/store-write-probe"
import { loggedLines } from "../../../fixture/tui-log"
import { directory, json, mount, wait } from "./sync-fixture"

// The fixed overhead of a session (`GET /session/:id/overhead`, #1461) is held per session and read only for a session
// something watches (`sync.overhead.watch`: the drawer while it is open). Three triggers refresh a watched session: the
// watch itself, that session's own `session.turn.settled` and a reconnect. A session nobody watches costs no read, and
// nothing polls. Unlike the usage of a tree, it belongs to one session: a turn that settles in its parent or its
// child changes nothing in it.
//
// Nothing in this file sleeps. An event is delivered by flushing the frame that carries it (`send`), so the handlers
// have run when it returns and a read they trigger has already been asked for; the SDK call is counted where it is
// made (`reads.asked()`), and `reads.answered()` returns once the sync layer has dealt with every answer. A failure is
// proved by what the failure path leaves behind, a line in the TUI log, and by what it must not touch.

type Row = {
  id: string
  slug: string
  projectID: string
  directory: string
  version: string
  title: string
  parentID?: string
  time: { created: number; updated: number }
} & Record<string, unknown>

function row(id: string, updated: number, parentID?: string): Row {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory,
    version: "test",
    title: id,
    parentID,
    role: parentID ? "task_child" : "root",
    time: { created: 0, updated },
  }
}

/** What the server reports for a session; the figures are the ones the test changes between reads. */
function overhead(sessionID: string, extra: Partial<SessionOverhead> = {}): SessionOverhead {
  return {
    bytes: 4_000,
    tokens: 1_200,
    model: "test/model",
    window: 10_000,
    windowSource: "config",
    ratio: 0.12,
    sources: [
      { source: "tools", bytes: 3_000, tokens: 900, hash: `tools-of-${sessionID}`.slice(0, 16).padEnd(16, "0") },
      { source: "base", bytes: 1_000, tokens: 300, hash: "0123456789abcdef" },
    ],
    ...extra,
  }
}

let sequence = 0
function global(type: string, properties: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_overhead_${++sequence}`, type, properties },
  } as GlobalEvent
}

let ended = 1_000
const settled = (sessionID: string, timeEnded = ++ended) =>
  global("session.turn.settled", {
    sessionID,
    turnID: `turn_${timeEnded}`,
    outcome: { type: "completed" },
    steps: 1,
    timeEnded,
  })

/** A deferred answer: the read waits until the test lets it go. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

interface Server {
  readonly handler: (url: URL) => Response | Promise<Response> | undefined
  /** Session ids, in the order their overhead reached the server. */
  readonly reads: string[]
  /** What each session answers with; change it between reads. Without an entry the session's own `overhead` answers. */
  readonly answers: Record<string, () => SessionOverhead | Promise<SessionOverhead> | Response>
}

function serve(rows: Row[]): Server {
  const reads: string[] = []
  const answers: Server["answers"] = {}
  const byID = new Map(rows.map((item) => [item.id, item]))
  return {
    reads,
    answers,
    handler: (url) => {
      if (url.pathname === "/session") return json(rows)
      const one = url.pathname.match(/^\/session\/([^/]+)\/overhead$/)
      if (one) {
        reads.push(one[1])
        const answer = answers[one[1]]?.() ?? overhead(one[1])
        return Promise.resolve(answer).then((value) => (value instanceof Response ? value : json(value)))
      }
      if (/^\/session\/[^/]+\/(todo|diff)$/.test(url.pathname)) return json([])
      if (/^\/session\/[^/]+\/message$/.test(url.pathname)) return json([])
      const session = url.pathname.match(/^\/session\/([^/]+)$/)
      if (session && byID.has(session[1])) return json(byID.get(session[1]))
      return undefined
    },
  }
}

type Mounted = Awaited<ReturnType<typeof mount>> & {
  server: Server
  /** The reads the sync layer asks for, counted at the SDK call. */
  reads: ReturnType<typeof spyOverheadReads>
  /** Deliver an event now: the frame that carries it is flushed, so its handlers have run when this returns. */
  send: (event: GlobalEvent) => void
}

async function withMount(
  rows: Row[],
  run: (ctx: Mounted) => Promise<void>,
  prepare: (server: Server) => void = () => {},
) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const server = serve(rows)
  prepare(server)
  const ctx = await mount(server.handler, tmp.path)
  const reads = spyOverheadReads(ctx.sdk)
  const send = (event: GlobalEvent) => {
    ctx.emit(event)
    ctx.sdk.frameClock.flushNow()
  }
  try {
    await run({ ...ctx, server, reads, send })
  } finally {
    ctx.app.renderer.destroy()
  }
}

/** Two trees: `ses_a` has a sub-agent and a grandchild (a DAG attempt under it), `ses_b` is a root of its own. */
const TREES = [
  row("ses_a", 100),
  row("ses_a_child", 90, "ses_a"),
  row("ses_a_grandchild", 80, "ses_a_child"),
  row("ses_b", 50),
  row("ses_b_child", 40, "ses_b"),
]

/** Sessions whose reads fail in the tests of a failure; each has a name of its own, so its line in the log is its own. */
const FAILING = [
  row("ses_fail_status", 40),
  row("ses_fail_dropped", 30),
  row("ses_fail_thrown", 20),
  row("ses_fail_first", 10),
]

/** What the failure path writes for a session: the log is one file for the whole process, so a test names its session. */
const failedFor = (sessionID: string) => loggedLines(`Loading the fixed overhead failed { sessionID: '${sessionID}'`)

describe("tui sync overhead: when it is read", () => {
  test("nothing is read until something watches: not the bootstrap, not entering a session, not a settled turn", async () => {
    await withMount(TREES, async ({ reads, send, server, sync }) => {
      await sync.session.activate("ses_a_child")
      send(settled("ses_a_child"))
      send(settled("ses_a"))
      // Both events were delivered: a read they would have triggered was asked for in the handler that has just run.
      expect(sync.data.turn_settled.ses_a_child).toBeDefined()
      expect(sync.data.turn_settled.ses_a).toBeDefined()
      expect(reads.asked()).toEqual([])
      await reads.answered()
      expect(server.reads).toEqual([])
      expect(sync.data.overhead).toEqual({})
    })
  })

  test("a watch reads the session once and takes the answer in, under the session's own id", async () => {
    await withMount(TREES, async ({ reads, server, sync }) => {
      const stop = sync.overhead.watch("ses_a_child")
      // Asked for as the watch is made, for the session itself and not for the root of its tree.
      expect(reads.asked()).toEqual(["ses_a_child"])
      await reads.answered()
      expect(server.reads).toEqual(["ses_a_child"])
      expect(sync.data.overhead.ses_a_child).toEqual(overhead("ses_a_child"))
      expect(sync.data.overhead.ses_a).toBeUndefined()
      stop()
    })
  })

  test("a turn that settles in the watched session reads it again, and the new answer replaces the old", async () => {
    await withMount(TREES, async ({ reads, send, server, sync }) => {
      const stop = sync.overhead.watch("ses_a")
      await reads.answered()

      for (const tokens of [2_000, 3_000, 4_000]) {
        server.answers.ses_a = () => overhead("ses_a", { tokens })
        send(settled("ses_a"))
        // Asked for in the handler of the event.
        await reads.answered()
        expect(sync.data.overhead.ses_a?.tokens).toBe(tokens)
      }
      expect(reads.asked()).toEqual(["ses_a", "ses_a", "ses_a", "ses_a"])
      expect(server.reads).toEqual(["ses_a", "ses_a", "ses_a", "ses_a"])
      stop()
    })
  })

  test("a turn that settles in another session reads nothing, its parent, its child and another tree alike", async () => {
    await withMount(TREES, async ({ reads, send, server, sync }) => {
      const stop = sync.overhead.watch("ses_a_child")
      await reads.answered()
      send(settled("ses_a"))
      send(settled("ses_a_grandchild"))
      send(settled("ses_b"))
      send(settled("ses_b_child"))
      expect(sync.data.turn_settled.ses_b_child).toBeDefined()
      expect(reads.asked()).toEqual(["ses_a_child"])
      await reads.answered()
      expect(server.reads).toEqual(["ses_a_child"])
      stop()
    })
  })

  test("an older settled event still reads: the overhead changed whatever the order the events came in", async () => {
    await withMount(TREES, async ({ reads, send, sync }) => {
      const stop = sync.overhead.watch("ses_a")
      await reads.answered()
      send(settled("ses_a", 5_000))
      expect(reads.asked()).toHaveLength(2)
      await reads.answered()
      send(settled("ses_a", 4_000))
      expect(reads.asked()).toHaveLength(3)
      await reads.answered()
      // The settled-turn slice keeps the newer one, the overhead was read for both.
      expect(sync.data.turn_settled.ses_a?.timeEnded).toBe(5_000)
      stop()
    })
  })

  test("triggers while a read is out cost one more read, not one each", async () => {
    const slow = gate()
    await withMount(
      TREES,
      async ({ reads, send, server, sync }) => {
        const stop = sync.overhead.watch("ses_a")
        // The first read is out, held by the server. A second watch and three settled turns all want it.
        const second = sync.overhead.watch("ses_a")
        send(settled("ses_a"))
        send(settled("ses_a"))
        send(settled("ses_a"))
        expect(reads.asked()).toEqual(["ses_a"])

        slow.open()
        await reads.answered()
        expect(reads.asked()).toEqual(["ses_a", "ses_a"])
        expect(server.reads).toEqual(["ses_a", "ses_a"])
        // The answer of the second read is the one that is held.
        expect(sync.data.overhead.ses_a?.tokens).toBe(9_000)
        second()
        stop()
      },
      (server) => {
        let requests = 0
        server.answers.ses_a = async () => {
          const mine = ++requests
          // Only the first read waits; the one asked for after it answers at once, with a newer figure.
          if (mine === 1) await slow.opened
          return overhead("ses_a", { tokens: mine === 1 ? 1_000 : 9_000 })
        }
      },
    )
  })

  test("each session has its own read: two sessions watched at once are read side by side", async () => {
    const slow = gate()
    await withMount(
      TREES,
      async ({ reads, server, sync }) => {
        const stopA = sync.overhead.watch("ses_a")
        const stopChild = sync.overhead.watch("ses_a_child")
        expect(reads.asked()).toEqual(["ses_a", "ses_a_child"])
        // `ses_a_child` answers while `ses_a` is still out, held by the server until the test lets it go.
        await wait(() => sync.data.overhead.ses_a_child !== undefined)
        expect(sync.data.overhead.ses_a).toBeUndefined()
        slow.open()
        await reads.answered()
        expect(sync.data.overhead.ses_a).toEqual(overhead("ses_a"))
        expect(server.reads.toSorted()).toEqual(["ses_a", "ses_a_child"])
        stopA()
        stopChild()
      },
      (server) => {
        server.answers.ses_a = async () => {
          await slow.opened
          return overhead("ses_a")
        }
      },
    )
  })
})

describe("tui sync overhead: watching and letting go", () => {
  test("a session watched twice is read while either watch is held, and not after both are let go", async () => {
    await withMount(TREES, async ({ reads, send, sync }) => {
      const first = sync.overhead.watch("ses_a")
      await reads.answered()
      const second = sync.overhead.watch("ses_a")
      expect(reads.asked()).toHaveLength(2)
      await reads.answered()

      first()
      send(settled("ses_a"))
      expect(reads.asked()).toHaveLength(3)
      await reads.answered()

      second()
      send(settled("ses_a"))
      expect(reads.asked()).toHaveLength(3)
    })
  })

  test("letting go twice lets go once: the other watch is still held", async () => {
    await withMount(TREES, async ({ reads, send, sync }) => {
      const first = sync.overhead.watch("ses_a")
      const second = sync.overhead.watch("ses_a")
      await reads.answered()
      const before = reads.asked().length

      first()
      first()
      first()
      send(settled("ses_a"))
      expect(reads.asked()).toHaveLength(before + 1)
      await reads.answered()
      second()
    })
  })

  test("after the last watch is let go a settled turn reads nothing, and a new watch reads again", async () => {
    await withMount(TREES, async ({ reads, send, server, sync }) => {
      const stop = sync.overhead.watch("ses_a")
      await reads.answered()
      stop()
      const before = reads.asked().length

      send(settled("ses_a"))
      expect(sync.data.turn_settled.ses_a).toBeDefined()
      expect(reads.asked()).toHaveLength(before)

      // What was held stays for the next watch to show at once; the new watch reads it again.
      expect(sync.data.overhead.ses_a).toEqual(overhead("ses_a"))
      server.answers.ses_a = () => overhead("ses_a", { tokens: 7_000 })
      const again = sync.overhead.watch("ses_a")
      expect(reads.asked()).toHaveLength(before + 1)
      await reads.answered()
      expect(sync.data.overhead.ses_a?.tokens).toBe(7_000)
      again()
    })
  })

  test("an answer that arrives after the last watch was let go is dropped", async () => {
    const slow = gate()
    await withMount(
      TREES,
      async ({ reads, server, sync }) => {
        const stop = sync.overhead.watch("ses_a")
        expect(reads.asked()).toEqual(["ses_a"])
        stop()
        slow.open()
        // The answer came and the sync layer dealt with it: it was not kept.
        await reads.answered()
        expect(server.reads).toEqual(["ses_a"])
        expect(sync.data.overhead.ses_a).toBeUndefined()
      },
      (server) => {
        server.answers.ses_a = async () => {
          await slow.opened
          return overhead("ses_a")
        }
      },
    )
  })

  test("a triggered session that was let go while its read was out is not read once more", async () => {
    const slow = gate()
    await withMount(
      TREES,
      async ({ reads, send, server, sync }) => {
        const stop = sync.overhead.watch("ses_a")
        send(settled("ses_a"))
        expect(reads.asked()).toEqual(["ses_a"])
        stop()
        slow.open()
        await reads.answered()
        expect(reads.asked()).toEqual(["ses_a"])
        expect(server.reads).toEqual(["ses_a"])
      },
      (server) => {
        server.answers.ses_a = async () => {
          await slow.opened
          return overhead("ses_a")
        }
      },
    )
  })

  test("a watch made from an effect reads once and is not read again by a change of workspace", async () => {
    await withMount(TREES, async ({ project, reads, sync }) => {
      let stop = () => {}
      createRoot((dispose) => {
        createEffect(() => {
          onCleanup(sync.overhead.watch("ses_a"))
        })
        stop = dispose
      })
      // The effect has run when the root is made: the read was asked for.
      expect(reads.asked()).toEqual(["ses_a"])
      await reads.answered()

      // The read looks at the workspace; the effect that asked for it must not depend on it. An effect that did
      // would run again as the workspace is set, let go and watch again, and the watch would ask for a read.
      project.workspace.set("ws_other")
      expect(reads.asked()).toEqual(["ses_a"])

      stop()
    })
  })
})

describe("tui sync overhead: a reconnect, a deletion and a failed read", () => {
  test("a reconnect reads every watched session again and takes the answers, and no other", async () => {
    await withMount(TREES, async ({ reads, reconnect, server, sync }) => {
      const stopA = sync.overhead.watch("ses_a")
      const stopB = sync.overhead.watch("ses_b")
      const gone = sync.overhead.watch("ses_a_child")
      await reads.answered()
      gone()
      const before = reads.asked().length

      server.answers.ses_a = () => overhead("ses_a", { tokens: 8_000 })
      server.answers.ses_b = () => overhead("ses_b", { tokens: 9_000 })
      reconnect()
      // The refresh handler ran as the stream reported the reconnect: the two watched sessions were asked for.
      expect(reads.asked().slice(before).toSorted()).toEqual(["ses_a", "ses_b"])
      await reads.answered()
      expect(sync.data.overhead.ses_a?.tokens).toBe(8_000)
      expect(sync.data.overhead.ses_b?.tokens).toBe(9_000)
      stopA()
      stopB()
    })
  })

  test("a reconnect reads nothing when nothing is watched", async () => {
    await withMount(TREES, async ({ reads, reconnect, sync }) => {
      const stop = sync.overhead.watch("ses_a")
      await reads.answered()
      stop()
      const before = reads.asked().length
      reconnect()
      expect(reads.asked()).toHaveLength(before)
    })
  })

  test("deleting the session drops its overhead, and a read still out does not bring it back", async () => {
    const slow = gate()
    await withMount(
      TREES,
      async ({ reads, send, server, sync }) => {
        const stop = sync.overhead.watch("ses_a")
        expect(reads.asked()).toEqual(["ses_a"])
        send(global("session.deleted", { sessionID: "ses_a", info: row("ses_a", 100) }))
        expect(sync.data.session.every((item) => item.id !== "ses_a")).toBe(true)
        slow.open()
        await reads.answered()
        expect(sync.data.overhead.ses_a).toBeUndefined()
        // The drawer's cleanup still runs after the deletion: it must not throw or count the session again.
        stop()
        stop()
        expect(reads.asked()).toEqual(["ses_a"])
        expect(server.reads).toEqual(["ses_a"])
      },
      (server) => {
        server.answers.ses_a = async () => {
          await slow.opened
          return overhead("ses_a")
        }
      },
    )
  })

  test("deleting a held session removes what it held, and no other session's", async () => {
    await withMount(TREES, async ({ reads, send, sync }) => {
      const stopB = sync.overhead.watch("ses_b")
      const stopChild = sync.overhead.watch("ses_b_child")
      await reads.answered()
      expect(sync.data.overhead.ses_b).toBeDefined()
      send(global("session.deleted", { sessionID: "ses_b", info: row("ses_b", 50) }))
      expect(sync.data.overhead.ses_b).toBeUndefined()
      expect(sync.data.overhead.ses_b_child).toBeDefined()
      stopB()
      stopChild()
    })
  })

  test("a read that fails with an error status keeps what the slice held, says so in the log, and the next trigger reads again", async () => {
    await withMount(FAILING, async ({ reads, send, server, sync }) => {
      const stop = sync.overhead.watch("ses_fail_status")
      await reads.answered()
      const held = overhead("ses_fail_status")
      expect(sync.data.overhead.ses_fail_status).toEqual(held)

      const before = failedFor("ses_fail_status").length
      server.answers.ses_fail_status = () => new Response("nope", { status: 500 })
      send(settled("ses_fail_status"))
      expect(reads.asked()).toHaveLength(2)
      // The answer, an error, has been dealt with by the sync layer, and what the slice held is still there ...
      await reads.answered()
      expect(sync.data.overhead.ses_fail_status).toEqual(held)
      // ... and the failure path ran: it wrote its line to the log, with the status the server gave.
      await wait(() => failedFor("ses_fail_status").length > before, 5000)
      expect(failedFor("ses_fail_status").at(-1)).toContain(
        "Loading the fixed overhead failed { sessionID: 'ses_fail_status', status: 500 }",
      )

      server.answers.ses_fail_status = () => overhead("ses_fail_status", { tokens: 4_000 })
      send(settled("ses_fail_status"))
      expect(reads.asked()).toHaveLength(3)
      await reads.answered()
      expect(sync.data.overhead.ses_fail_status?.tokens).toBe(4_000)
      stop()
    })
  })

  test("a read whose connection drops keeps what the slice held and says so in the log, with no status to give", async () => {
    await withMount(FAILING, async ({ reads, send, server, sync }) => {
      const stop = sync.overhead.watch("ses_fail_dropped")
      await reads.answered()
      const held = overhead("ses_fail_dropped")
      expect(sync.data.overhead.ses_fail_dropped).toEqual(held)

      const before = failedFor("ses_fail_dropped").length
      server.answers.ses_fail_dropped = () => {
        throw new Error("connection reset")
      }
      send(settled("ses_fail_dropped"))
      expect(reads.asked()).toHaveLength(2)
      await reads.answered()
      expect(sync.data.overhead.ses_fail_dropped).toEqual(held)
      await wait(() => failedFor("ses_fail_dropped").length > before, 5000)
      expect(failedFor("ses_fail_dropped").at(-1)).toContain(
        "Loading the fixed overhead failed { sessionID: 'ses_fail_dropped', status: undefined }",
      )

      // The next trigger reads again, and the connection is back.
      server.answers.ses_fail_dropped = () => overhead("ses_fail_dropped", { tokens: 5_000 })
      send(settled("ses_fail_dropped"))
      expect(reads.asked()).toHaveLength(3)
      await reads.answered()
      expect(sync.data.overhead.ses_fail_dropped?.tokens).toBe(5_000)
      stop()
    })
  })

  test("a read that throws inside the SDK call keeps what the slice held and says so in the log", async () => {
    await withMount(FAILING, async ({ reads, send, server, sync }) => {
      const stop = sync.overhead.watch("ses_fail_thrown")
      await reads.answered()
      const held = overhead("ses_fail_thrown")
      expect(sync.data.overhead.ses_fail_thrown).toEqual(held)

      const before = failedFor("ses_fail_thrown").length
      reads.rejectNext(new Error("socket closed"))
      send(settled("ses_fail_thrown"))
      expect(reads.asked()).toHaveLength(2)
      await reads.answered()
      expect(sync.data.overhead.ses_fail_thrown).toEqual(held)
      // The read never reached the server, and the failure path logged the error itself.
      await wait(() => failedFor("ses_fail_thrown").length > before, 5000)
      expect(failedFor("ses_fail_thrown").at(-1)).toContain(
        "Loading the fixed overhead failed { sessionID: 'ses_fail_thrown', error: 'Error: socket closed' }",
      )
      expect(server.reads).toEqual(["ses_fail_thrown"])

      // The next trigger reads again.
      server.answers.ses_fail_thrown = () => overhead("ses_fail_thrown", { tokens: 6_000 })
      send(settled("ses_fail_thrown"))
      expect(reads.asked()).toHaveLength(3)
      await reads.answered()
      expect(sync.data.overhead.ses_fail_thrown?.tokens).toBe(6_000)
      stop()
    })
  })

  test("a read that fails at first leaves the slice empty, says so in the log, and the next trigger takes the answer", async () => {
    await withMount(
      FAILING,
      async ({ reads, send, server, sync }) => {
        const before = failedFor("ses_fail_first").length
        const stop = sync.overhead.watch("ses_fail_first")
        await reads.answered()
        await wait(() => failedFor("ses_fail_first").length > before, 5000)
        expect(failedFor("ses_fail_first").at(-1)).toContain("status: 500")
        expect(sync.data.overhead.ses_fail_first).toBeUndefined()

        server.answers.ses_fail_first = () => overhead("ses_fail_first")
        send(settled("ses_fail_first"))
        expect(reads.asked()).toHaveLength(2)
        await reads.answered()
        expect(sync.data.overhead.ses_fail_first).toEqual(overhead("ses_fail_first"))
        stop()
      },
      (server) => {
        server.answers.ses_fail_first = () => new Response("nope", { status: 500 })
      },
    )
  })
})

describe("tui sync overhead: what it writes", () => {
  test("only its own slice: nothing reaches the message or part stores, and an equal answer writes nothing", async () => {
    await withMount(TREES, async ({ reads, send, server, sync }) => {
      const stop = sync.overhead.watch("ses_a")
      await reads.answered()
      const probe = probeStoreWrites(sync.data, ["message", "part", "summary", "usage", "overhead"])
      try {
        // The same answer again: the read happens and is taken in, the store does not change.
        send(settled("ses_a"))
        expect(reads.asked()).toHaveLength(2)
        await reads.answered()
        expect(probe.writes("overhead")).toBe(0)

        // A different one is one write of the slice.
        server.answers.ses_a = () => overhead("ses_a", { tokens: 6_000 })
        send(settled("ses_a"))
        await reads.answered()
        expect(sync.data.overhead.ses_a?.tokens).toBe(6_000)
        expect(probe.writes("overhead")).toBe(1)
        expect(probe.writes("message")).toBe(0)
        expect(probe.writes("part")).toBe(0)
        expect(probe.writes("summary")).toBe(0)
        expect(probe.writes("usage")).toBe(0)
      } finally {
        probe.dispose()
        stop()
      }
    })
  })

  test("a settled turn in a session nobody watches writes nothing but the settled-turn slice", async () => {
    await withMount(TREES, async ({ reads, send, sync }) => {
      const probe = probeStoreWrites(sync.data, ["message", "part", "overhead"])
      try {
        send(settled("ses_b_child"))
        expect(sync.data.turn_settled.ses_b_child).toBeDefined()
        expect(reads.asked()).toEqual([])
        expect(probe.total()).toBe(0)
      } finally {
        probe.dispose()
      }
    })
  })
})
