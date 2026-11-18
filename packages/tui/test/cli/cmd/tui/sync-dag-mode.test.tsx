// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { DagWorkflowSummary, GlobalEvent, SessionDagMode } from "@graphagent/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { probeStoreWrites } from "../../../fixture/store-write-probe"
import { directory, json, mount, wait } from "./sync-fixture"

// The session's DAG mode snapshot (`GET /session/:id/dag-mode`): read when the route enters a tree that has DAG mode
// on or a workflow (or becomes such a tree), then kept current by `session.updated` (its budget fields), by the
// workflow summaries (usage) and by a reconnect. A session with neither costs no read, and nothing polls (#1032 7).

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

function row(id: string, updated: number, extra: Record<string, unknown> = {}, parentID?: string): Row {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory,
    version: "test",
    title: id,
    parentID,
    time: { created: 0, updated },
    ...extra,
  }
}

/** Nothing configured, so the values in force are the defaults. */
function limits(extra: Partial<SessionDagMode["limits"]> = {}): SessionDagMode["limits"] {
  return {
    concurrency: 12,
    configuredConcurrency: null,
    maxTotalNodes: 100,
    configuredMaxTotalNodes: null,
    running: 3,
    ...extra,
  }
}

function status(extra: Partial<SessionDagMode> = {}): SessionDagMode {
  return {
    mode: "on",
    defaultMode: "off",
    availability: "available",
    unavailableReason: null,
    budget: { tokens: 1000, used: 100, usedCacheRead: 0, warnRatio: 0.8 },
    limits: limits(),
    quality: null,
    ...extra,
  }
}

function workflow(id = "wf-1"): DagWorkflowSummary {
  return {
    id,
    title: "依赖升级验证",
    status: "running",
    graphRev: 1,
    nodeCount: 2,
    completedNodes: 0,
    runningNodes: 1,
    failedNodes: 0,
    skippedNodes: 0,
    abortedNodes: 0,
    queuedNodes: 1,
    escalatedNodes: 0,
  }
}

let sequence = 0
function global(type: string, properties: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_dagmode_${++sequence}`, type, properties },
  } as GlobalEvent
}

const updated = (info: Row) => global("session.updated", { info })
const summarized = (sessionID: string, summaries: DagWorkflowSummary[]) =>
  global("dag.workflow.summary.updated", { sessionID, summaries })
/** The hot-read notice of a global config write: it names the top-level keys that changed. */
const configUpdated = (keys: string[]) => global("config.updated", { keys })
/** A workflow whose summary says how many DAG slots the whole process is running. */
const reporting = (running: number, id = "wf-1"): DagWorkflowSummary => ({
  ...workflow(id),
  concurrencyRunning: running,
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
  /** Session ids, in the order their mode was asked for. */
  readonly reads: string[]
  /** What each session answers with; change it between reads. */
  readonly answers: Record<string, () => SessionDagMode | Promise<SessionDagMode> | Response>
  /** The workflows each session owns, as `GET /dag/session/:id/summary` answers. */
  readonly summaries: Record<string, DagWorkflowSummary[]>
  /** Session ids, in the order their summaries were asked for. */
  readonly summaryReads: string[]
  /** While set, every summary answer waits for it. */
  summaryHold?: Promise<void>
}

function serve(rows: Row[]): Server {
  const reads: string[] = []
  const summaryReads: string[] = []
  const answers: Server["answers"] = {}
  const summaries: Server["summaries"] = {}
  const byID = new Map(rows.map((item) => [item.id, item]))
  const server: Server = {
    reads,
    answers,
    summaries,
    summaryReads,
    handler: (url) => {
      if (url.pathname === "/session") return json(rows)
      const summary = url.pathname.match(/^\/dag\/session\/([^/]+)\/summary$/)
      if (summary) {
        summaryReads.push(summary[1])
        const answer = () => json(summaries[summary[1]] ?? [])
        return server.summaryHold ? server.summaryHold.then(answer) : answer()
      }
      const mode = url.pathname.match(/^\/session\/([^/]+)\/dag-mode$/)
      if (mode) {
        reads.push(mode[1])
        const answer = answers[mode[1]]?.() ?? status()
        return Promise.resolve(answer).then((value) => (value instanceof Response ? value : json(value)))
      }
      if (/^\/session\/[^/]+\/(todo|diff)$/.test(url.pathname)) return json([])
      if (/^\/session\/[^/]+\/message$/.test(url.pathname)) return json([])
      const one = url.pathname.match(/^\/session\/([^/]+)$/)
      if (one && byID.has(one[1])) return json(byID.get(one[1]))
      return undefined
    },
  }
  return server
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

/** The mode is on in the newest tree; the older one is a plain session. */
const TREE = [
  row("ses_new", 100, { dagMode: "on" }),
  row("ses_new_child", 90, {}, "ses_new"),
  row("ses_old", 50),
  row("ses_old_child", 40, {}, "ses_old"),
]

describe("tui sync dag mode snapshot: when it is read", () => {
  test("a bootstrap alone reads none: the home view costs no request, whatever the sessions hold", async () => {
    await withMount(TREE, async ({ server, sync }) => {
      await Bun.sleep(80)
      expect(server.reads).toEqual([])
      expect(sync.data.dagMode).toEqual({})
    })
  })

  test("entering a tree with the mode on reads its root once, whichever session of the tree is entered", async () => {
    await withMount(TREE, async ({ server, sync }) => {
      // The route does not wait for the read: the snapshot lands when the server answers.
      await sync.session.activate("ses_new_child")
      await wait(() => sync.data.dagMode.ses_new !== undefined)
      expect(server.reads).toEqual(["ses_new"])
      expect(sync.data.dagMode.ses_new).toEqual(status())

      await sync.session.activate("ses_new_child")
      await sync.session.activate("ses_new")
      await Bun.sleep(40)
      expect(server.reads).toEqual(["ses_new"])
    })
  })

  test("a tree with a workflow is read though its mode is off", async () => {
    await withMount(
      TREE,
      async ({ server, sync }) => {
        await sync.session.activate("ses_old_child")
        await wait(() => sync.data.dagMode.ses_old !== undefined)
        expect(server.reads).toEqual(["ses_old"])
      },
      (server) => {
        server.summaries.ses_old = [workflow()]
      },
    )
  })

  test("a workflow owned by a sub-agent session of the tree counts too", async () => {
    await withMount(
      TREE,
      async ({ server, sync }) => {
        await sync.session.activate("ses_old")
        await wait(() => sync.data.dagMode.ses_old !== undefined)
        expect(server.reads).toEqual(["ses_old"])
      },
      (server) => {
        server.summaries.ses_old_child = [workflow()]
      },
    )
  })

  test("a tree with neither the mode nor a workflow is never read", async () => {
    await withMount(TREE, async ({ server, sync }) => {
      await sync.session.activate("ses_old_child")
      await sync.session.activate("ses_old")
      await Bun.sleep(80)
      expect(server.reads).toEqual([])
      expect(sync.data.dagMode.ses_old).toBeUndefined()
    })
  })

  test("the root's mode turning on reads it; another session's update does not", async () => {
    await withMount(TREE, async ({ emit, server, sdk, sync }) => {
      await sync.session.activate("ses_old")
      await Bun.sleep(40)
      expect(server.reads).toEqual([])

      emit(updated(row("ses_new", 101, { dagMode: "on" })))
      sdk.frameClock.flushNow()
      await Bun.sleep(40)
      expect(server.reads).toEqual([])

      emit(updated(row("ses_old", 51, { dagMode: "on" })))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagMode.ses_old !== undefined)
      expect(server.reads).toEqual(["ses_old"])
    })
  })

  test("a workflow summary arriving in the tree reads it, and the next one does not", async () => {
    await withMount(TREE, async ({ emit, server, sdk, sync }) => {
      await sync.session.activate("ses_old")
      await Bun.sleep(40)
      expect(server.reads).toEqual([])

      emit(summarized("ses_old", []))
      sdk.frameClock.flushNow()
      await Bun.sleep(40)
      expect(server.reads).toEqual([])

      emit(summarized("ses_old", [workflow()]))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagMode.ses_old !== undefined)
      emit(summarized("ses_old", [workflow(), workflow("wf-2")]))
      sdk.frameClock.flushNow()
      await Bun.sleep(40)
      expect(server.reads).toEqual(["ses_old"])
    })
  })

  test("a summary for a tree the route is not in reads nothing", async () => {
    await withMount(TREE, async ({ emit, server, sdk, sync }) => {
      await sync.session.activate("ses_old")
      emit(summarized("ses_new", [workflow()]))
      sdk.frameClock.flushNow()
      await Bun.sleep(60)
      expect(server.reads).toEqual([])
    })
  })

  test("leaving the route and coming back to a read tree reads nothing new", async () => {
    await withMount(TREE, async ({ server, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)
      sync.session.deactivate()
      await sync.session.activate("ses_new")
      await Bun.sleep(40)
      expect(server.reads).toEqual(["ses_new"])
    })
  })
})

describe("tui sync dag mode snapshot: what keeps it current", () => {
  test("a session.updated that changes the budget reads the mode again, once", async () => {
    await withMount(TREE, async ({ emit, server, sdk, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)
      server.answers.ses_new = () => status({ budget: { tokens: 2000, used: 100, usedCacheRead: 0, warnRatio: 0.8 } })

      emit(updated(row("ses_new", 101, { dagMode: "on", dagBudgetTokens: 2000 })))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagMode.ses_new?.budget.tokens === 2000)
      expect(server.reads).toEqual(["ses_new", "ses_new"])
    })
  })

  test("so does lifting the budget altogether, and putting it back", async () => {
    await withMount(TREE, async ({ emit, server, sdk, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)

      server.answers.ses_new = () => status({ budget: { tokens: null, used: 100, usedCacheRead: 0, warnRatio: 0.8 } })
      emit(updated(row("ses_new", 101, { dagMode: "on", dagBudgetUnlimited: true })))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagMode.ses_new?.budget.tokens === null)

      server.answers.ses_new = () => status()
      emit(updated(row("ses_new", 102, { dagMode: "on", dagBudgetUnlimited: false })))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagMode.ses_new?.budget.tokens === 1000)
      expect(server.reads).toEqual(["ses_new", "ses_new", "ses_new"])
    })
  })

  test("an update that leaves the budget alone reads nothing: not a new title, not the mode itself", async () => {
    await withMount(TREE, async ({ emit, server, sdk, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)

      emit(updated(row("ses_new", 101, { dagMode: "on", title: "renamed" })))
      // The mode switch itself is the session's own field: it reaches the display through the session.
      emit(updated(row("ses_new", 102, { dagMode: "off" })))
      emit(updated(row("ses_new", 103, { dagMode: "on", cost: 4 })))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.session.find((item) => item.id === "ses_new")?.time.updated === 103)
      await Bun.sleep(40)
      expect(server.reads).toEqual(["ses_new"])
    })
  })

  test("a budget change on a session whose mode was never read reads nothing", async () => {
    await withMount(TREE, async ({ emit, server, sdk, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)

      emit(updated(row("ses_old", 51, { dagBudgetTokens: 10 })))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.session.find((item) => item.id === "ses_old")?.time.updated === 51)
      await Bun.sleep(40)
      expect(server.reads).toEqual(["ses_new"])
    })
  })

  test("a reconnect reads every mode it holds again and takes the answers", async () => {
    await withMount(
      TREE,
      async ({ reconnect, server, sync }) => {
        await sync.session.activate("ses_new")
        await wait(() => sync.data.dagMode.ses_new !== undefined)
        await sync.session.activate("ses_old")
        await wait(() => sync.data.dagMode.ses_old !== undefined)
        server.reads.length = 0

        server.answers.ses_new = () => status({ limits: limits({ concurrency: 8, running: 1 }) })
        server.answers.ses_old = () => status({ mode: "off" })
        reconnect()
        await wait(
          () => sync.data.dagMode.ses_new?.limits.concurrency === 8 && sync.data.dagMode.ses_old?.mode === "off",
        )
        expect(server.reads.toSorted()).toEqual(["ses_new", "ses_old"])
      },
      (server) => {
        server.summaries.ses_old = [workflow()]
      },
    )
  })

  test("a reconnect reads nothing when no snapshot is held", async () => {
    await withMount(TREE, async ({ reconnect, server, sync }) => {
      await sync.session.activate("ses_old")
      reconnect()
      await Bun.sleep(80)
      expect(server.reads).toEqual([])
    })
  })

  test("an answer that was overtaken by a newer read is dropped", async () => {
    const slow = gate()
    await withMount(
      TREE,
      async ({ emit, server, sdk, sync }) => {
        await sync.session.activate("ses_new")
        // The first read is still out.
        await wait(() => server.reads.length === 1)
        server.answers.ses_new = () => status({ budget: { tokens: 3000, used: 100, usedCacheRead: 0, warnRatio: 0.8 } })
        emit(updated(row("ses_new", 101, { dagMode: "on", dagBudgetTokens: 3000 })))
        sdk.frameClock.flushNow()
        await wait(() => sync.data.dagMode.ses_new?.budget.tokens === 3000)

        // Now the old answer arrives, with the budget the session had before.
        slow.open()
        await Bun.sleep(60)
        expect(sync.data.dagMode.ses_new?.budget.tokens).toBe(3000)
      },
      (server) => {
        server.answers.ses_new = async () => {
          await slow.opened
          return status({ budget: { tokens: 1000, used: 100, usedCacheRead: 0, warnRatio: 0.8 } })
        }
      },
    )
  })

  test("a read that fails leaves the slice as it was, and the next entry reads again", async () => {
    await withMount(
      TREE,
      async ({ server, sync }) => {
        await sync.session.activate("ses_new")
        await wait(() => server.reads.length === 1)
        await Bun.sleep(40)
        expect(sync.data.dagMode.ses_new).toBeUndefined()

        server.answers.ses_new = () => status()
        await sync.session.activate("ses_new")
        await wait(() => sync.data.dagMode.ses_new !== undefined)
        expect(server.reads).toEqual(["ses_new", "ses_new"])
      },
      (server) => {
        server.answers.ses_new = () => new Response("nope", { status: 500 })
      },
    )
  })

  test("a session wanted twice while its read is out is asked for once", async () => {
    const slow = gate()
    await withMount(
      TREE,
      async ({ emit, server, sdk, sync }) => {
        await sync.session.activate("ses_new")
        await wait(() => server.reads.length === 1)
        // A second activation, a mode update and a summary all want it while the first read is still out.
        await sync.session.activate("ses_new")
        emit(updated(row("ses_new", 101, { dagMode: "on" })))
        emit(summarized("ses_new", [workflow()]))
        sdk.frameClock.flushNow()
        await Bun.sleep(60)
        expect(server.reads).toEqual(["ses_new"])
        slow.open()
        await wait(() => sync.data.dagMode.ses_new !== undefined)
        expect(server.reads).toEqual(["ses_new"])
      },
      (server) => {
        server.answers.ses_new = async () => {
          await slow.opened
          return status()
        }
      },
    )
  })

  test("deleting the session drops its snapshot", async () => {
    await withMount(TREE, async ({ emit, sdk, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)
      emit(global("session.deleted", { sessionID: "ses_new", info: row("ses_new", 100) }))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagMode.ses_new === undefined)
    })
  })

  test("writes only its own slice: nothing reaches the message or part stores, one write per read", async () => {
    await withMount(TREE, async ({ emit, sdk, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)
      const probe = probeStoreWrites(sync.data, ["message", "part", "dagMode", "summary"])
      try {
        emit(updated(row("ses_new", 101, { dagMode: "on", dagBudgetTokens: 5 })))
        sdk.frameClock.flushNow()
        await wait(() => sync.data.session.find((item) => item.id === "ses_new")?.time.updated === 101)
        await Bun.sleep(80)
        expect(probe.writes("message")).toBe(0)
        expect(probe.writes("part")).toBe(0)
        // The answer is the same as the one held: a write of an equal answer changes nothing.
        expect(probe.writes("dagMode")).toBe(0)
      } finally {
        probe.dispose()
      }
    })
  })
})

// A global write to the `dag` configuration (the default budget, the concurrency, the node cap) reaches the TUI as
// `config.updated` and nothing else: no session changes with it, so the snapshots held are read again on the notice.
describe("tui sync dag mode snapshot: the global dag configuration", () => {
  test("a change to dag reads every snapshot held again and takes the answers", async () => {
    await withMount(
      TREE,
      async ({ emit, server, sdk, sync }) => {
        await sync.session.activate("ses_new")
        await wait(() => sync.data.dagMode.ses_new !== undefined)
        await sync.session.activate("ses_old")
        await wait(() => sync.data.dagMode.ses_old !== undefined)
        server.reads.length = 0

        server.answers.ses_new = () => status({ limits: limits({ concurrency: 8, maxTotalNodes: 50, running: 1 }) })
        server.answers.ses_old = () => status({ budget: { tokens: 4000, used: 100, usedCacheRead: 0, warnRatio: 0.8 } })
        emit(configUpdated(["dag"]))
        sdk.frameClock.flushNow()
        await wait(
          () =>
            sync.data.dagMode.ses_new?.limits.concurrency === 8 && sync.data.dagMode.ses_old?.budget.tokens === 4000,
        )
        expect(server.reads.toSorted()).toEqual(["ses_new", "ses_old"])
      },
      (server) => {
        server.summaries.ses_old = [workflow()]
      },
    )
  })

  test("a write that disposes the instance reads every snapshot held again", async () => {
    await withMount(TREE, async ({ emit, server, sdk, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)
      server.reads.length = 0

      server.answers.ses_new = () => status({ limits: limits({ concurrency: 6, maxTotalNodes: 50, running: 0 }) })
      emit(global("server.instance.disposed", { directory }))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagMode.ses_new?.limits.concurrency === 6)
      expect(server.reads).toEqual(["ses_new"])
    })
  })

  test("a change to any other key reads nothing", async () => {
    await withMount(TREE, async ({ emit, server, sdk, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)
      server.reads.length = 0

      emit(configUpdated(["language"]))
      emit(configUpdated([]))
      sdk.frameClock.flushNow()
      await Bun.sleep(60)
      expect(server.reads).toEqual([])
    })
  })

  test("a snapshot still on its way is read again too, and the answer from before the change is dropped", async () => {
    const slow = gate()
    let calls = 0
    await withMount(
      TREE,
      async ({ emit, server, sdk, sync }) => {
        await sync.session.activate("ses_new")
        // The first read is still out when the configuration changes: nothing is held yet.
        await wait(() => server.reads.length === 1)
        expect(sync.data.dagMode.ses_new).toBeUndefined()
        emit(configUpdated(["dag"]))
        sdk.frameClock.flushNow()
        await wait(() => sync.data.dagMode.ses_new?.budget.tokens === 2000)

        // Now the answer given before the change arrives, with the budget the old configuration made.
        slow.open()
        await Bun.sleep(60)
        expect(sync.data.dagMode.ses_new?.budget.tokens).toBe(2000)
        expect(server.reads).toEqual(["ses_new", "ses_new"])
      },
      (server) => {
        server.answers.ses_new = async () => {
          calls += 1
          if (calls === 1) {
            await slow.opened
            return status({ budget: { tokens: 1000, used: 100, usedCacheRead: 0, warnRatio: 0.8 } })
          }
          return status({ budget: { tokens: 2000, used: 100, usedCacheRead: 0, warnRatio: 0.8 } })
        }
      },
    )
  })

  test("with no snapshot held or on its way a change to dag reads nothing: a plain view costs no request", async () => {
    await withMount(TREE, async ({ emit, server, sdk, sync }) => {
      await sync.session.activate("ses_old")
      emit(configUpdated(["dag"]))
      sdk.frameClock.flushNow()
      await Bun.sleep(60)
      expect(server.reads).toEqual([])
      expect(sync.data.dagMode).toEqual({})
    })
  })
})

// What the reconnect has to bring back: the snapshots held, and also the one the route's tree wants but has not got.
describe("tui sync dag mode snapshot: what a reconnect fills in", () => {
  test("the current root whose first read failed is read again", async () => {
    await withMount(
      TREE,
      async ({ reconnect, server, sync }) => {
        await sync.session.activate("ses_new")
        await wait(() => server.reads.length === 1)
        await Bun.sleep(40)
        // The failed read left nothing held, so there is no snapshot for the reconnect to refresh.
        expect(sync.data.dagMode.ses_new).toBeUndefined()

        server.answers.ses_new = () => status()
        reconnect()
        await wait(() => sync.data.dagMode.ses_new !== undefined)
        expect(server.reads).toEqual(["ses_new", "ses_new"])
      },
      (server) => {
        server.answers.ses_new = () => new Response("nope", { status: 500 })
      },
    )
  })

  test("the current root that gained a workflow while the stream was down is read", async () => {
    await withMount(TREE, async ({ reconnect, server, sync }) => {
      await sync.session.activate("ses_old")
      await Bun.sleep(40)
      expect(server.reads).toEqual([])

      // The summary event went with the stream; the summaries the reconnect reads again are what show the workflow.
      server.summaries.ses_old = [workflow()]
      reconnect()
      await wait(() => sync.data.dagMode.ses_old !== undefined)
      expect(server.reads).toEqual(["ses_old"])
    })
  })

  test("a workflow that appeared in a tree the route is not in reads nothing", async () => {
    await withMount(TREE, async ({ reconnect, server, sync }) => {
      await sync.session.activate("ses_old")
      await Bun.sleep(40)

      server.summaries.ses_new = [workflow()]
      reconnect()
      await wait(() => (sync.data.dag.ses_new?.length ?? 0) > 0)
      await Bun.sleep(40)
      expect(server.reads).toEqual([])
    })
  })

  test("reconnects in a row still ask for the summaries once while the first refresh is out", async () => {
    const hold = gate()
    await withMount(TREE, async ({ reconnect, server, sync }) => {
      await sync.session.activate("ses_old")
      const tracked = Object.keys(sync.data.dag).toSorted()
      server.summaryReads.length = 0

      server.summaryHold = hold.opened
      reconnect()
      reconnect()
      await wait(() => server.summaryReads.length === tracked.length)
      await Bun.sleep(40)
      expect(server.summaryReads.toSorted()).toEqual(tracked)

      // The refresh that ends lets the next reconnect ask again.
      hold.open()
      await Bun.sleep(60)
      server.summaryReads.length = 0
      reconnect()
      await wait(() => server.summaryReads.length === tracked.length)
    })
  })
})

// The slots running in the whole process are one figure, but a summary event carries it only for the session it is
// about: the store keeps the latest report of any source, so a session that is shown does not keep a stale count.
describe("tui sync dag mode snapshot: the slots of the whole process", () => {
  test("nothing is known until a report says, and a plain tree costs none", async () => {
    await withMount(TREE, async ({ server, sync }) => {
      expect(sync.data.dagRunning).toBeUndefined()
      await sync.session.activate("ses_old")
      await Bun.sleep(40)
      expect(server.reads).toEqual([])
      expect(sync.data.dagRunning).toBeUndefined()
    })
  })

  test("another session's summary event brings the count, and the summaries the root holds stay as they are", async () => {
    await withMount(TREE, async ({ emit, sdk, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)
      // The snapshot read counted three slots busy.
      expect(sync.data.dagRunning).toBe(3)

      emit(summarized("ses_old", [reporting(5)]))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagRunning === 5)
      expect(sync.data.dag.ses_new).toEqual([])
    })
  })

  test("a summary without the figure leaves the count alone, and a zero is a report", async () => {
    await withMount(TREE, async ({ emit, sdk, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)
      emit(summarized("ses_old", [reporting(5)]))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagRunning === 5)

      emit(summarized("ses_old", [workflow(), workflow("wf-2")]))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dag.ses_old?.length === 2)
      expect(sync.data.dagRunning).toBe(5)

      emit(summarized("ses_old", []))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dag.ses_old?.length === 0)
      expect(sync.data.dagRunning).toBe(5)

      emit(summarized("ses_old", [reporting(0)]))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagRunning === 0)
    })
  })

  test("the latest report wins: an event after a snapshot, a snapshot after an event", async () => {
    await withMount(TREE, async ({ emit, server, sdk, sync }) => {
      await sync.session.activate("ses_new")
      await wait(() => sync.data.dagMode.ses_new !== undefined)
      expect(sync.data.dagRunning).toBe(3)

      emit(summarized("ses_old", [reporting(5)]))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagRunning === 5)

      // A change to the dag configuration reads the snapshot again, and its count is the newest.
      server.answers.ses_new = () => status({ limits: limits({ running: 1 }) })
      emit(configUpdated(["dag"]))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagRunning === 1)
      expect(sync.data.dagMode.ses_new?.limits.running).toBe(1)

      emit(summarized("ses_old", [reporting(2)]))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagRunning === 2)
    })
  })

  test("entering a tree takes the count from its summaries, and the snapshot asked for after them takes over", async () => {
    const slow = gate()
    await withMount(
      TREE,
      async ({ sync }) => {
        await sync.session.activate("ses_old")
        // The summaries read at entry have said four; the snapshot, asked for after them, is still out.
        expect(sync.data.dagRunning).toBe(4)
        slow.open()
        await wait(() => sync.data.dagRunning === 3)
      },
      (server) => {
        server.summaries.ses_old = [reporting(4)]
        server.answers.ses_old = async () => {
          await slow.opened
          return status()
        }
      },
    )
  })

  test("the summaries a reconnect reads again bring it too", async () => {
    await withMount(TREE, async ({ reconnect, server, sync }) => {
      await sync.session.activate("ses_old")
      await Bun.sleep(40)
      expect(sync.data.dagRunning).toBeUndefined()

      // The bootstrap read the newest tree's summaries; a session of it has a workflow by now.
      server.summaries.ses_new_child = [reporting(6)]
      reconnect()
      await wait(() => sync.data.dagRunning === 6)
      // The route's own tree has none, so nothing else was read.
      expect(server.reads).toEqual([])
    })
  })
})

// #1290: a tree with DAG mode off and no workflow reads no snapshot by itself, but the `/config` panel shows the limits in
// force, which only the server knows, so a surface can ask for the snapshot of the tree it is in.
describe("tui sync dag mode snapshot: asked for by a surface", () => {
  test("a plain tree is read on request, once, at its root, whichever session of the tree is named", async () => {
    await withMount(TREE, async ({ server, sync }) => {
      await sync.session.activate("ses_old_child")
      await Bun.sleep(40)
      expect(server.reads).toEqual([])

      sync.dag.readMode("ses_old_child")
      await wait(() => sync.data.dagMode.ses_old !== undefined)
      expect(server.reads).toEqual(["ses_old"])
      expect(sync.data.dagMode.ses_old).toEqual(status())

      // Held, so asking again for any session of the tree costs no request.
      sync.dag.readMode("ses_old")
      sync.dag.readMode("ses_old_child")
      await Bun.sleep(40)
      expect(server.reads).toEqual(["ses_old"])
    })
  })

  test("a request while the read is out joins it instead of starting another", async () => {
    const slow = gate()
    await withMount(
      TREE,
      async ({ server, sync }) => {
        sync.dag.readMode("ses_old")
        await wait(() => server.reads.length === 1)
        sync.dag.readMode("ses_old_child")
        slow.open()
        await wait(() => sync.data.dagMode.ses_old !== undefined)
        expect(server.reads).toEqual(["ses_old"])
      },
      (server) => {
        server.answers.ses_old = async () => {
          await slow.opened
          return status()
        }
      },
    )
  })

  test("once held, a dag configuration change reads it again with the others", async () => {
    await withMount(TREE, async ({ emit, sdk, server, sync }) => {
      sync.dag.readMode("ses_old")
      await wait(() => sync.data.dagMode.ses_old !== undefined)
      server.reads.length = 0

      server.answers.ses_old = () =>
        status({ limits: limits({ concurrency: 14, configuredConcurrency: 30, running: 0 }) })
      emit(configUpdated(["dag"]))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagMode.ses_old?.limits.concurrency === 14)
      expect(server.reads).toEqual(["ses_old"])
      expect(sync.data.dagMode.ses_old?.limits.configuredConcurrency).toBe(30)
    })
  })
})
