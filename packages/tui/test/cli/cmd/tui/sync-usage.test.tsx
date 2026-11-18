// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createEffect, createRoot, onCleanup } from "solid-js"
import type { GlobalEvent, SessionUsage } from "@graphagent/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { probeStoreWrites } from "../../../fixture/store-write-probe"
import { directory, json, mount, wait } from "./sync-fixture"

// The usage of a whole task tree (`GET /session/:id/usage`, #1475) is held per root session and read only for a root
// something watches (`sync.usage.watch`: the drawer while it is open). Three triggers refresh a watched root: the
// watch itself, a `session.turn.settled` anywhere in its tree, and a reconnect. A root nobody watches costs no read,
// and nothing polls.

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

/** What the server sums for a tree; the figures are the ones the test changes between reads. */
function usage(rootID: string, extra: Partial<SessionUsage> = {}): SessionUsage {
  return {
    rootID,
    sessions: 3,
    cost: 1.5,
    costUnknown: false,
    tokens: { input: 1000, output: 200, reasoning: 30, cache: { read: 4000, write: 500 } },
    ...extra,
  }
}

let sequence = 0
function global(type: string, properties: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_usage_${++sequence}`, type, properties },
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
  /** Session ids, in the order their usage was asked for. */
  readonly reads: string[]
  /** What each session answers with; change it between reads. Without an entry the root's `usage` answers. */
  readonly answers: Record<string, () => SessionUsage | Promise<SessionUsage> | Response>
}

function serve(rows: Row[]): Server {
  const reads: string[] = []
  const answers: Server["answers"] = {}
  const byID = new Map(rows.map((item) => [item.id, item]))
  const rootOf = (id: string) => {
    let current = id
    while (byID.get(current)?.parentID) current = byID.get(current)!.parentID!
    return current
  }
  return {
    reads,
    answers,
    handler: (url) => {
      if (url.pathname === "/session") return json(rows)
      const one = url.pathname.match(/^\/session\/([^/]+)\/usage$/)
      if (one) {
        reads.push(one[1])
        // The real endpoint answers for any session of a tree with its root's total.
        const answer = answers[one[1]]?.() ?? usage(rootOf(one[1]))
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

async function withMount(
  rows: Row[],
  run: (ctx: Awaited<ReturnType<typeof mount>> & { server: Server }) => Promise<void>,
  prepare: (server: Server) => void = () => {},
) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const server = serve(rows)
  prepare(server)
  const ctx = await mount(server.handler, tmp.path)
  try {
    await run({ ...ctx, server })
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

describe("tui sync usage: when it is read", () => {
  test("nothing is read until something watches: not the bootstrap, not entering a tree, not a settled turn", async () => {
    await withMount(TREES, async ({ emit, sdk, server, sync }) => {
      await sync.session.activate("ses_a_child")
      emit(settled("ses_a_child"))
      emit(settled("ses_a"))
      sdk.frameClock.flushNow()
      await Bun.sleep(80)
      expect(server.reads).toEqual([])
      expect(sync.data.usage).toEqual({})
    })
  })

  test("a watch reads the root once and takes the answer in", async () => {
    await withMount(TREES, async ({ server, sync }) => {
      const stop = sync.usage.watch("ses_a")
      await wait(() => sync.data.usage.ses_a !== undefined)
      expect(server.reads).toEqual(["ses_a"])
      expect(sync.data.usage.ses_a).toEqual(usage("ses_a"))
      stop()
    })
  })

  test("a root that is not watched is not read: another tree's settled turn reads nothing", async () => {
    await withMount(TREES, async ({ emit, sdk, server, sync }) => {
      const stop = sync.usage.watch("ses_a")
      await wait(() => sync.data.usage.ses_a !== undefined)
      emit(settled("ses_b"))
      emit(settled("ses_b_child"))
      sdk.frameClock.flushNow()
      await Bun.sleep(80)
      expect(server.reads).toEqual(["ses_a"])
      expect(sync.data.usage.ses_b).toBeUndefined()
      stop()
    })
  })

  test("a turn that settles anywhere in the watched tree reads its root again, and the new answer replaces the old", async () => {
    await withMount(TREES, async ({ emit, sdk, server, sync }) => {
      const stop = sync.usage.watch("ses_a")
      await wait(() => sync.data.usage.ses_a !== undefined)

      for (const [index, settledID] of ["ses_a", "ses_a_child", "ses_a_grandchild"].entries()) {
        const cost = 2 + index
        server.answers.ses_a = () => usage("ses_a", { cost })
        emit(settled(settledID))
        sdk.frameClock.flushNow()
        await wait(() => sync.data.usage.ses_a?.cost === cost)
        expect(server.reads.length).toBe(index + 2)
      }
      // The read is always the root's, whichever session of the tree settled.
      expect(new Set(server.reads)).toEqual(new Set(["ses_a"]))
      stop()
    })
  })

  test("an older settled event still reads: the usage changed whatever the order the events came in", async () => {
    await withMount(TREES, async ({ emit, sdk, server, sync }) => {
      const stop = sync.usage.watch("ses_a")
      await wait(() => sync.data.usage.ses_a !== undefined)
      emit(settled("ses_a", 5_000))
      sdk.frameClock.flushNow()
      await wait(() => server.reads.length === 2)
      emit(settled("ses_a", 4_000))
      sdk.frameClock.flushNow()
      await wait(() => server.reads.length === 3)
      // The settled-turn slice keeps the newer one, the usage was read for both.
      expect(sync.data.turn_settled.ses_a?.timeEnded).toBe(5_000)
      stop()
    })
  })

  test("triggers while a read is out cost one more read, not one each", async () => {
    const slow = gate()
    await withMount(
      TREES,
      async ({ emit, sdk, server, sync }) => {
        const stop = sync.usage.watch("ses_a")
        await wait(() => server.reads.length === 1)
        // The first read is still out: a second watch, three settled turns and a second root's turn all want it.
        const second = sync.usage.watch("ses_a")
        emit(settled("ses_a"))
        emit(settled("ses_a_child"))
        emit(settled("ses_a_grandchild"))
        sdk.frameClock.flushNow()
        await Bun.sleep(60)
        expect(server.reads).toEqual(["ses_a"])

        server.answers.ses_a = () => usage("ses_a", { cost: 9 })
        slow.open()
        await wait(() => server.reads.length === 2)
        await wait(() => sync.data.usage.ses_a?.cost === 9)
        await Bun.sleep(60)
        expect(server.reads).toEqual(["ses_a", "ses_a"])
        second()
        stop()
      },
      (server) => {
        server.answers.ses_a = async () => {
          await slow.opened
          return usage("ses_a", { cost: 1 })
        }
      },
    )
  })

  test("each root has its own read: two trees watched at once are read side by side", async () => {
    const slow = gate()
    await withMount(
      TREES,
      async ({ server, sync }) => {
        const stopA = sync.usage.watch("ses_a")
        const stopB = sync.usage.watch("ses_b")
        await wait(() => sync.data.usage.ses_b !== undefined)
        // `ses_b` answered while `ses_a` was still out.
        expect(server.reads.toSorted()).toEqual(["ses_a", "ses_b"])
        expect(sync.data.usage.ses_a).toBeUndefined()
        slow.open()
        await wait(() => sync.data.usage.ses_a !== undefined)
        stopA()
        stopB()
      },
      (server) => {
        server.answers.ses_a = async () => {
          await slow.opened
          return usage("ses_a")
        }
      },
    )
  })

  test("the slice is keyed by the session watched, whatever root the server answers with", async () => {
    await withMount(TREES, async ({ server, sync }) => {
      const stop = sync.usage.watch("ses_a_child")
      await wait(() => sync.data.usage.ses_a_child !== undefined)
      expect(server.reads).toEqual(["ses_a_child"])
      expect(sync.data.usage.ses_a_child?.rootID).toBe("ses_a")
      stop()
    })
  })
})

describe("tui sync usage: watching and letting go", () => {
  test("a root watched twice is read while either watch is held, and not after both are let go", async () => {
    await withMount(TREES, async ({ emit, sdk, server, sync }) => {
      const first = sync.usage.watch("ses_a")
      await wait(() => sync.data.usage.ses_a !== undefined)
      const second = sync.usage.watch("ses_a")
      await wait(() => server.reads.length === 2)

      first()
      emit(settled("ses_a_child"))
      sdk.frameClock.flushNow()
      await wait(() => server.reads.length === 3)

      second()
      emit(settled("ses_a_child"))
      emit(settled("ses_a"))
      sdk.frameClock.flushNow()
      await Bun.sleep(80)
      expect(server.reads.length).toBe(3)
    })
  })

  test("letting go twice lets go once: the other watch is still held", async () => {
    await withMount(TREES, async ({ emit, sdk, server, sync }) => {
      const first = sync.usage.watch("ses_a")
      const second = sync.usage.watch("ses_a")
      await wait(() => sync.data.usage.ses_a !== undefined)
      server.reads.length = 0

      first()
      first()
      first()
      emit(settled("ses_a"))
      sdk.frameClock.flushNow()
      await wait(() => server.reads.length === 1)
      second()
    })
  })

  test("after the last watch is let go a settled turn reads nothing, and a new watch reads again", async () => {
    await withMount(TREES, async ({ emit, sdk, server, sync }) => {
      const stop = sync.usage.watch("ses_a")
      await wait(() => sync.data.usage.ses_a !== undefined)
      stop()
      server.reads.length = 0

      emit(settled("ses_a"))
      emit(settled("ses_a_child"))
      sdk.frameClock.flushNow()
      await Bun.sleep(80)
      expect(server.reads).toEqual([])

      // What was held stays for the next watch to show at once; the new watch reads it again.
      expect(sync.data.usage.ses_a).toEqual(usage("ses_a"))
      server.answers.ses_a = () => usage("ses_a", { cost: 7 })
      const again = sync.usage.watch("ses_a")
      await wait(() => sync.data.usage.ses_a?.cost === 7)
      expect(server.reads).toEqual(["ses_a"])
      again()
    })
  })

  test("an answer that arrives after the last watch was let go is dropped", async () => {
    const slow = gate()
    await withMount(
      TREES,
      async ({ server, sync }) => {
        const stop = sync.usage.watch("ses_a")
        await wait(() => server.reads.length === 1)
        stop()
        slow.open()
        await Bun.sleep(80)
        expect(sync.data.usage.ses_a).toBeUndefined()
        expect(server.reads).toEqual(["ses_a"])
      },
      (server) => {
        server.answers.ses_a = async () => {
          await slow.opened
          return usage("ses_a")
        }
      },
    )
  })

  test("a triggered root that was let go while its read was out is not read once more", async () => {
    const slow = gate()
    await withMount(
      TREES,
      async ({ emit, sdk, server, sync }) => {
        const stop = sync.usage.watch("ses_a")
        await wait(() => server.reads.length === 1)
        emit(settled("ses_a"))
        sdk.frameClock.flushNow()
        stop()
        slow.open()
        await Bun.sleep(80)
        expect(server.reads).toEqual(["ses_a"])
      },
      (server) => {
        server.answers.ses_a = async () => {
          await slow.opened
          return usage("ses_a")
        }
      },
    )
  })

  test("a watch made from an effect reads once and is not read again by a change of workspace", async () => {
    await withMount(TREES, async ({ project, server, sync }) => {
      let stop = () => {}
      createRoot((dispose) => {
        createEffect(() => {
          onCleanup(sync.usage.watch("ses_a"))
        })
        stop = dispose
      })
      await wait(() => sync.data.usage.ses_a !== undefined)
      expect(server.reads).toEqual(["ses_a"])

      // The read looks at the workspace; the effect that asked for it must not depend on it.
      project.workspace.set("ws_other")
      await Bun.sleep(80)
      expect(server.reads).toEqual(["ses_a"])

      stop()
    })
  })
})

describe("tui sync usage: a reconnect, a deletion and a failed read", () => {
  test("a reconnect reads every watched root again and takes the answers, and no other", async () => {
    await withMount(TREES, async ({ reconnect, server, sync }) => {
      const stopA = sync.usage.watch("ses_a")
      const stopB = sync.usage.watch("ses_b")
      const gone = sync.usage.watch("ses_a_child")
      await wait(() => sync.data.usage.ses_b !== undefined && sync.data.usage.ses_a_child !== undefined)
      gone()
      server.reads.length = 0

      server.answers.ses_a = () => usage("ses_a", { cost: 8 })
      server.answers.ses_b = () => usage("ses_b", { cost: 9 })
      reconnect()
      await wait(() => sync.data.usage.ses_a?.cost === 8 && sync.data.usage.ses_b?.cost === 9)
      expect(server.reads.toSorted()).toEqual(["ses_a", "ses_b"])
      stopA()
      stopB()
    })
  })

  test("a reconnect reads nothing when nothing is watched", async () => {
    await withMount(TREES, async ({ reconnect, server, sync }) => {
      const stop = sync.usage.watch("ses_a")
      await wait(() => sync.data.usage.ses_a !== undefined)
      stop()
      server.reads.length = 0
      reconnect()
      await Bun.sleep(80)
      expect(server.reads).toEqual([])
    })
  })

  test("deleting the session drops its usage, and a read still out does not bring it back", async () => {
    const slow = gate()
    await withMount(
      TREES,
      async ({ emit, sdk, sync, server }) => {
        const stop = sync.usage.watch("ses_a")
        await wait(() => server.reads.length === 1)
        emit(global("session.deleted", { sessionID: "ses_a", info: row("ses_a", 100) }))
        sdk.frameClock.flushNow()
        await wait(() => sync.data.session.every((item) => item.id !== "ses_a"))
        slow.open()
        await Bun.sleep(80)
        expect(sync.data.usage.ses_a).toBeUndefined()
        // The drawer's cleanup still runs after the deletion: it must not throw or count the root again.
        stop()
        stop()
        expect(server.reads).toEqual(["ses_a"])
      },
      (server) => {
        server.answers.ses_a = async () => {
          await slow.opened
          return usage("ses_a")
        }
      },
    )
  })

  test("deleting a held session removes what it held", async () => {
    await withMount(TREES, async ({ emit, sdk, sync }) => {
      const stop = sync.usage.watch("ses_b")
      await wait(() => sync.data.usage.ses_b !== undefined)
      emit(global("session.deleted", { sessionID: "ses_b", info: row("ses_b", 50) }))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.usage.ses_b === undefined)
      stop()
    })
  })

  test("a read that fails keeps what the slice held, and the next trigger reads again", async () => {
    await withMount(TREES, async ({ emit, sdk, server, sync }) => {
      const stop = sync.usage.watch("ses_a")
      await wait(() => sync.data.usage.ses_a !== undefined)

      server.answers.ses_a = () => new Response("nope", { status: 500 })
      emit(settled("ses_a"))
      sdk.frameClock.flushNow()
      await wait(() => server.reads.length === 2)
      await Bun.sleep(40)
      expect(sync.data.usage.ses_a).toEqual(usage("ses_a"))

      server.answers.ses_a = () => usage("ses_a", { cost: 4 })
      emit(settled("ses_a"))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.usage.ses_a?.cost === 4)
      expect(server.reads.length).toBe(3)
      stop()
    })
  })

  test("a read that fails at first leaves the slice empty, and the next trigger takes the answer", async () => {
    await withMount(
      TREES,
      async ({ emit, sdk, server, sync }) => {
        const stop = sync.usage.watch("ses_a")
        await wait(() => server.reads.length === 1)
        await Bun.sleep(40)
        expect(sync.data.usage.ses_a).toBeUndefined()

        server.answers.ses_a = () => usage("ses_a")
        emit(settled("ses_a_child"))
        sdk.frameClock.flushNow()
        await wait(() => sync.data.usage.ses_a !== undefined)
        stop()
      },
      (server) => {
        server.answers.ses_a = () => new Response("nope", { status: 500 })
      },
    )
  })
})

describe("tui sync usage: what it writes", () => {
  test("only its own slice: nothing reaches the message or part stores, and an equal answer writes nothing", async () => {
    await withMount(TREES, async ({ emit, sdk, server, sync }) => {
      const stop = sync.usage.watch("ses_a")
      await wait(() => sync.data.usage.ses_a !== undefined)
      const probe = probeStoreWrites(sync.data, ["message", "part", "summary", "usage"])
      try {
        // The same answer again: the read happens, the store does not change.
        emit(settled("ses_a"))
        sdk.frameClock.flushNow()
        await wait(() => server.reads.length === 2)
        await Bun.sleep(60)
        expect(probe.writes("usage")).toBe(0)

        // A different one is one write of the slice.
        server.answers.ses_a = () => usage("ses_a", { cost: 6 })
        emit(settled("ses_a_child"))
        sdk.frameClock.flushNow()
        await wait(() => sync.data.usage.ses_a?.cost === 6)
        expect(probe.writes("usage")).toBe(1)
        expect(probe.writes("message")).toBe(0)
        expect(probe.writes("part")).toBe(0)
        expect(probe.writes("summary")).toBe(0)
      } finally {
        probe.dispose()
        stop()
      }
    })
  })

  test("a settled turn in a tree nobody watches writes nothing but the settled-turn slice", async () => {
    await withMount(TREES, async ({ emit, sdk, sync }) => {
      const probe = probeStoreWrites(sync.data, ["message", "part", "usage"])
      try {
        emit(settled("ses_b_child"))
        sdk.frameClock.flushNow()
        await wait(() => sync.data.turn_settled.ses_b_child !== undefined)
        await Bun.sleep(40)
        expect(probe.total()).toBe(0)
      } finally {
        probe.dispose()
      }
    })
  })
})
