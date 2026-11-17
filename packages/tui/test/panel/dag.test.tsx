// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type {
  DagNode,
  DagWorkflowQuality,
  DagWorkflowSummary,
  GlobalEvent,
  Session,
  SessionDagMode,
} from "@graphagent/sdk"
import { afterEach, describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { Ticker } from "../../src/context/ticker"
import { DEFAULT_THEME } from "../../src/context/theme"
import { formatDagTokens } from "../../src/dag/mode"
import { setLanguage } from "../../src/i18n"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { cellWidth } from "../../src/ui/width"
import { probeStoreWrites } from "../fixture/store-write-probe"
import { directory, json } from "../fixture/tui-sdk"
import { dagModeStatus, sessionFixture, waitFor } from "../routes/dag-mode-harness"
import { createCounters } from "../perf/counters"
import { mountSessionShell } from "../routes/session-shell"

// The /dag panel, mounted for real: the session route with its prompt, the bottom zone with its panel host, and
// the data layer reading the fake server. Everything a user can do in it, the writes it must not make, and how it
// looks at the sizes the design names (#1032 4).

afterEach(() => {
  setLanguage("zh-CN")
})

const ROOT = "ses_dag_root"
const CHILD = "ses_dag_child"
const NODE_SESSION = "ses_dag_node"
const WF = "wf_alpha"
const WF2 = "wf_beta"
const NOW = 1_700_000_000_000

let sequence = 0
const nextID = () => `evt_dag_panel_${++sequence}`

/** A node as the server sends it, `name` and `id` alike unless told otherwise. */
function wire(id: string, status: string, extra: Partial<DagNode> = {}, workflow = WF): DagNode {
  return {
    id,
    workflow_id: workflow,
    name: id,
    worker_type: "task",
    status,
    required: false,
    depends_on: [],
    replan_attempts: 0,
    ...extra,
  }
}

function summaryOf(id: string, title: string, status: string, extra: Partial<DagWorkflowSummary> = {}) {
  return {
    id,
    title,
    status,
    graphRev: 1,
    nodeCount: 5,
    completedNodes: 2,
    runningNodes: 1,
    failedNodes: 1,
    skippedNodes: 0,
    abortedNodes: 0,
    queuedNodes: 1,
    escalatedNodes: 0,
    ...extra,
  } satisfies DagWorkflowSummary
}

/** Four waves: resolve; install; e2e and typecheck; unit. One node each state worth showing. */
function pipeline(workflow = WF): DagNode[] {
  return [
    wire("resolve", "completed", { started_at: NOW - 600_000, completed_at: NOW - 598_000 }, workflow),
    wire(
      "install",
      "completed",
      { depends_on: ["resolve"], started_at: NOW - 598_000, completed_at: NOW - 550_000 },
      workflow,
    ),
    wire(
      "typecheck",
      "running",
      {
        depends_on: ["install"],
        started_at: NOW - 540_000,
        deadline_ms: NOW + 125_000,
        output: { verdict: "pending" },
      },
      workflow,
    ),
    wire(
      "e2e",
      "failed",
      {
        depends_on: ["install"],
        started_at: NOW - 540_000,
        completed_at: NOW - 300_000,
        error_reason: "ripgrep 下载超时（504）",
        child_session_id: NODE_SESSION,
        output: { verdict: "FAIL", detail: "timeout" },
      },
      workflow,
    ),
    wire("unit", "pending", { depends_on: ["typecheck"] }, workflow),
  ]
}

/** The workflow summaries and node tables the fake server answers with, and a record of the table reads. */
function dagServer(input: {
  summaries?: Record<string, DagWorkflowSummary[]>
  tables?: Record<string, DagNode[]>
  /** The mode snapshot the session answers with, or "fail" for a server that cannot; the harness default when unset. */
  mode?: SessionDagMode | "fail"
}) {
  const server = {
    summaries: input.summaries ?? { [ROOT]: [summaryOf(WF, "依赖升级验证", "running")] },
    tables: input.tables ?? { [WF]: pipeline() },
    mode: input.mode,
    reads: [] as string[],
    handler: (url: URL) => {
      const mode = url.pathname.match(/^\/session\/([^/]+)\/dag-mode$/)
      if (mode && server.mode !== undefined) {
        return server.mode === "fail" ? new Response("nope", { status: 500 }) : json(server.mode)
      }
      const summary = url.pathname.match(/^\/dag\/session\/([^/]+)\/summary$/)
      if (summary) return json(server.summaries[summary[1]] ?? [])
      const table = url.pathname.match(/^\/dag\/([^/]+)\/nodes$/)
      if (table) {
        server.reads.push(table[1])
        return json(server.tables[table[1]] ?? [])
      }
      return undefined
    },
  }
  return server
}

/** The one-second clock by hand: it says what time it is, and counts who listens to it. */
function fakeTicker(start = NOW) {
  let current = start
  let seconds = 0
  let frames = 0
  const [second, setSecond] = createSignal(0)
  const ticker: Ticker = {
    frame: () => 0,
    second,
    subscribe: () => {
      frames += 1
      return () => {
        frames -= 1
      }
    },
    subscribeSecond: () => {
      seconds += 1
      return () => {
        seconds -= 1
      }
    },
    at: () => () => {},
    now: () => current,
  }
  return {
    ticker,
    seconds: () => seconds,
    frames: () => frames,
    advance(ms: number) {
      current += ms
      setSecond((value) => value + 1)
    },
  }
}

type Shell = Awaited<ReturnType<typeof mountDag>>

async function mountDag(
  options: {
    server?: ReturnType<typeof dagServer>
    sessionID?: string
    sessions?: readonly Session[]
    width?: number
    height?: number
    language?: "zh-CN" | "en"
    ambiguousWidth?: 1 | 2
  } = {},
) {
  const server = options.server ?? dagServer({})
  const clock = fakeTicker()
  const shell = await mountSessionShell({
    sessionID: options.sessionID ?? ROOT,
    sessions: options.sessions ?? [
      sessionFixture(ROOT),
      sessionFixture(CHILD, { parentID: ROOT }),
      sessionFixture(NODE_SESSION, { parentID: ROOT }),
    ],
    handler: (url) => server.handler(url),
    ticker: clock.ticker,
    width: options.width ?? 100,
    height: options.height ?? 30,
    language: options.language,
    kv: options.ambiguousWidth ? { ambiguous_width: options.ambiguousWidth } : undefined,
  })
  return { ...shell, server, clock }
}

/** Types `/dag` into the prompt and runs it, the way a user does. */
async function openDag(shell: Shell) {
  await shell.app.mockInput.typeText("/dag")
  await shell.settle()
  shell.app.mockInput.pressEnter()
  await waitFor(() => shell.bottomZone().host.top()?.id === "dag", 10_000)
  await shell.settle()
}

async function openLoaded(shell: Shell, workflowID = WF) {
  await openDag(shell)
  await waitFor(() => shell.sync().dag.nodes(workflowID) !== undefined, 10_000)
  await shell.settle()
}

/** One key, the way the keyboard names it: arrows and enter have calls of their own, a letter is typed. */
async function press(shell: Shell, key: string) {
  if (key === "up" || key === "down" || key === "left" || key === "right") shell.app.mockInput.pressArrow(key)
  else if (key === "return") shell.app.mockInput.pressEnter()
  else shell.app.mockInput.pressKey(key)
  await shell.settle()
}

const depth = (shell: Shell) => shell.bottomZone().host.depth()
const topID = (shell: Shell) => shell.bottomZone().host.top()?.id
const rowsOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())
const lineWith = (frame: string, needle: string) => rowsOf(frame).find((line) => line.includes(needle))

function nodesPush(
  push: { seq: number; nodes?: DagNode[]; removed?: string[]; graphRev?: number; resync?: boolean },
  workflowID = WF,
  sessionID = ROOT,
): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: nextID(),
      type: "dag.workflow.nodes.updated",
      properties: {
        sessionID,
        workflowID,
        graphRev: push.graphRev ?? 1,
        seq: push.seq,
        nodes: push.nodes ?? [],
        removed: push.removed ?? [],
        ...(push.resync ? { resync: true } : {}),
      },
    },
  }
}

function summaryPush(summaries: DagWorkflowSummary[], sessionID = ROOT): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: nextID(), type: "dag.workflow.summary.updated", properties: { sessionID, summaries } },
  }
}

describe("the /dag command and the panel's hold on the data", () => {
  test("/dag opens the panel on the session's workflow and reads its node table once", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      expect(depth(shell)).toBe(1)
      const frame = await shell.frame()
      expect(frame).toContain("工作流")
      expect(frame).toContain("[运行中]")
      expect(frame).toContain("依赖升级验证")
      expect(frame).toContain("/dag")
      for (const name of ["resolve", "install", "typecheck", "e2e", "unit"]) expect(frame).toContain(name)
      expect(shell.server.reads).toEqual([WF])
    } finally {
      await shell.dispose()
    }
  })

  test("closing the panel takes the declaration back: the table is dropped and later pushes read nothing", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      expect(shell.sync().dag.nodes(WF)).toBeDefined()

      shell.app.mockInput.pressEscape()
      await waitFor(() => depth(shell) === 0)
      await waitFor(() => shell.sync().dag.nodes(WF) === undefined)

      shell.events.emit(nodesPush({ seq: 1, nodes: [wire("unit", "running", { depends_on: ["typecheck"] })] }))
      await shell.settle()
      expect(shell.sync().dag.nodes(WF)).toBeUndefined()
      expect(shell.server.reads).toEqual([WF])
    } finally {
      await shell.dispose()
    }
  })

  test("a workflow owned by a child session registers that session's interest, and closing gives it back", async () => {
    const server = dagServer({
      summaries: { [CHILD]: [summaryOf(WF, "依赖升级验证", "running")] },
      tables: { [WF]: pipeline() },
    })
    const shell = await mountDag({ server })
    try {
      await waitFor(() => (shell.sync().data.dag[CHILD]?.length ?? 0) === 1, 10_000)
      await openLoaded(shell)
      expect(shell.events.interest.at(-1)).toContain(CHILD)
      expect(shell.events.interest.at(-1)).toContain(ROOT)

      shell.app.mockInput.pressEscape()
      await waitFor(() => depth(shell) === 0)
      await waitFor(() => !shell.events.interest.at(-1)?.includes(CHILD))
      expect(shell.events.interest.at(-1)).toContain(ROOT)
    } finally {
      await shell.dispose()
    }
  })

  test("opening it again is a fresh declaration, so the table is read again", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      shell.app.mockInput.pressEscape()
      await waitFor(() => depth(shell) === 0)
      await waitFor(() => shell.sync().dag.nodes(WF) === undefined)
      await openLoaded(shell)
      expect(shell.server.reads).toEqual([WF, WF])
    } finally {
      await shell.dispose()
    }
  })

  test("a workflow that is not loaded yet shows its counts and says the nodes are coming", async () => {
    const server = dagServer({})
    const hold = Promise.withResolvers<void>()
    const shell = await mountSessionShell({
      sessionID: ROOT,
      sessions: [sessionFixture(ROOT)],
      ticker: fakeTicker().ticker,
      width: 100,
      height: 30,
      handler: async (url) => {
        if (/^\/dag\/[^/]+\/nodes$/.test(url.pathname)) await hold.promise
        return server.handler(url)
      },
    })
    try {
      await shell.app.mockInput.typeText("/dag")
      await shell.settle()
      shell.app.mockInput.pressEnter()
      await waitFor(() => shell.bottomZone().host.top()?.id === "dag", 10_000)
      const frame = await shell.waitForFrame((value) => value.includes("正在加载节点"))
      expect(frame).toContain("2/5 完成")
      expect(frame).not.toContain("typecheck")
      hold.resolve()
      await shell.waitForFrame((value) => value.includes("typecheck"))
    } finally {
      hold.resolve()
      await shell.dispose()
    }
  })

  test("with no workflow in the session tree it says so, and offers nothing to ask for", async () => {
    const shell = await mountDag({ server: dagServer({ summaries: {}, tables: {} }) })
    try {
      await openDag(shell)
      const frame = await shell.waitForFrame((value) => value.includes("没有工作流"))
      expect(frame).toContain("没有工作流。可以让主 agent 规划一个。")
      expect(frame).not.toContain("请主 agent 处理")
      await press(shell, "i")
      expect(depth(shell)).toBe(1)
    } finally {
      await shell.dispose()
    }
  })
})

describe("waves and the nodes outside them", () => {
  test("nodes are grouped by wave: the first row of a wave carries its number, the rest a bar", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(lineWith(frame, "resolve")).toContain("第 1 波")
      expect(lineWith(frame, "install")).toContain("第 2 波")
      // Two nodes share the third wave, sorted by name: e2e first, then typecheck.
      expect(lineWith(frame, "e2e")).toContain("第 3 波")
      expect(lineWith(frame, "typecheck")).not.toContain("第")
      expect(lineWith(frame, "typecheck")).toContain("│")
      expect(lineWith(frame, "unit")).toContain("第 4 波")
      const rows = rowsOf(frame)
      expect(rows.findIndex((line) => line.includes("e2e"))).toBeLessThan(
        rows.findIndex((line) => line.includes("typecheck")),
      )
    } finally {
      await shell.dispose()
    }
  })

  test("a node shows its state as a symbol and its time as a duration", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(lineWith(frame, "resolve")).toContain("✓")
      expect(lineWith(frame, "resolve")).toContain("2s")
      expect(lineWith(frame, "install")).toContain("48s")
      expect(lineWith(frame, "e2e")).toContain("✗")
      expect(lineWith(frame, "e2e")).toContain("4m 0s")
      expect(lineWith(frame, "typecheck")).toContain("●")
      // Still running: counted up to the clock's now.
      expect(lineWith(frame, "typecheck")).toContain("9m 0s")
      expect(lineWith(frame, "unit")).toContain("○")
    } finally {
      await shell.dispose()
    }
  })

  const looped: DagNode[] = [
    wire("start", "completed", { started_at: NOW - 60_000, completed_at: NOW - 30_000 }),
    wire("x", "pending", { depends_on: ["y"] }),
    wire("y", "pending", { depends_on: ["x"] }),
    wire("after", "pending", { depends_on: ["x"] }),
  ]

  test("nodes no wave can take are listed apart and counted, and selecting one says why", async () => {
    const server = dagServer({
      summaries: { [ROOT]: [summaryOf(WF, "有环的工作流", "running", { nodeCount: 4, completedNodes: 1 })] },
      tables: { [WF]: looped },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).toContain("依赖异常 (3)")
      expect(rowsOf(frame).findIndex((line) => line.includes("start"))).toBeLessThan(
        rowsOf(frame).findIndex((line) => line.includes("依赖异常")),
      )
      // The heading is no row to stop on: down from `start` lands on the first node under it, `after`, which
      // waits on a member of the cycle; the next two are the cycle itself.
      await press(shell, "down")
      expect(await shell.frame()).toContain("依赖环成员「x」的下游")
      await press(shell, "down")
      const member = await shell.frame()
      expect(member).toContain("依赖环成员")
      expect(member).not.toContain("下游")
      await press(shell, "down")
      expect(await shell.frame()).not.toContain("下游")
    } finally {
      await shell.dispose()
    }
  })

  test("the bar draws every node, the ones outside the waves behind a mark", async () => {
    const server = dagServer({
      summaries: { [ROOT]: [summaryOf(WF, "有环的工作流", "running", { nodeCount: 4, completedNodes: 1 })] },
      tables: { [WF]: looped },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      const bar = rowsOf(await shell.frame()).find((line) => line.includes("!") && /[━─╌]/.test(line))
      expect(bar).toBeDefined()
      // One wave of one node, then the group outside the waves: its mark and three nodes of five cells each.
      expect(bar).toContain("━━━━━ !")
      expect(bar!.slice(bar!.indexOf("!") + 1).match(/[━─╌]/g)?.length).toBe(15)
    } finally {
      await shell.dispose()
    }
  })
})

describe("what the panel shows follows the data", () => {
  test("a pushed node change reaches the rows without another read", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      const before = await shell.frame()
      expect(lineWith(before, "unit")).toContain("○")

      shell.events.emit(
        nodesPush({
          seq: 1,
          nodes: [wire("unit", "running", { depends_on: ["typecheck"], started_at: NOW - 3_000 })],
        }),
      )
      const after = await shell.waitForFrame((frame) => lineWith(frame, "unit")?.includes("●") === true)
      expect(lineWith(after, "unit")).toContain("3s")
      expect(shell.server.reads).toEqual([WF])
    } finally {
      await shell.dispose()
    }
  })

  test("a pushed summary updates the counts", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("2/5 完成")
      shell.events.emit(
        summaryPush([summaryOf(WF, "依赖升级验证", "running", { completedNodes: 3, runningNodes: 2, failedNodes: 0 })]),
      )
      const frame = await shell.waitForFrame((value) => value.includes("3/5 完成"))
      expect(frame).toContain("2 运行中")
      expect(frame).not.toContain("失败")
    } finally {
      await shell.dispose()
    }
  })

  test("a reconnect reads the table again and the rows follow the server", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      shell.server.tables[WF] = pipeline().map((node) =>
        node.id === "unit" ? { ...node, status: "running", started_at: NOW - 1_000 } : node,
      )
      shell.events.reconnect()
      await waitFor(() => shell.server.reads.length === 2, 10_000)
      const frame = await shell.waitForFrame((value) => lineWith(value, "unit")?.includes("●") === true)
      expect(lineWith(frame, "unit")).toContain("1s")
      expect(shell.server.reads).toEqual([WF, WF])
    } finally {
      await shell.dispose()
    }
  })

  test("the elapsed time is counted by the clock, and the clock is listened to only while something runs", async () => {
    const shell = await mountDag()
    try {
      expect(shell.clock.seconds()).toBe(0)
      await openLoaded(shell)
      expect(shell.clock.seconds()).toBe(1)
      const first = await shell.frame()
      expect(first).toMatch(/已用 10m 0s/)
      shell.clock.advance(5_000)
      const later = await shell.waitForFrame((frame) => frame.includes("已用 10m 5s"))
      expect(lineWith(later, "typecheck")).toContain("9m 5s")

      shell.app.mockInput.pressEscape()
      await waitFor(() => depth(shell) === 0)
      expect(shell.clock.seconds()).toBe(0)
      expect(shell.clock.frames()).toBe(0)
    } finally {
      await shell.dispose()
    }
  })

  test("a workflow that is over holds no timer: its time is where it stopped", async () => {
    const server = dagServer({
      summaries: {
        [ROOT]: [summaryOf(WF, "已结束", "completed", { runningNodes: 0, failedNodes: 0, completedNodes: 5 })],
      },
      tables: {
        [WF]: [
          wire("a", "completed", { started_at: NOW - 100_000, completed_at: NOW - 70_000 }),
          wire("b", "completed", { depends_on: ["a"], started_at: NOW - 70_000, completed_at: NOW - 40_000 }),
        ],
      },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).toContain("[已完成]")
      expect(frame).toContain("已用 1m 0s")
      expect(shell.clock.seconds()).toBe(0)
      shell.clock.advance(60_000)
      await shell.settle()
      expect(await shell.frame()).toContain("已用 1m 0s")
    } finally {
      await shell.dispose()
    }
  })
})

describe("moving around the panel", () => {
  test("it starts on the failed node, and the selected row's note says what went wrong", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(lineWith(frame, "e2e")).toContain("›")
      expect(frame).toContain("ripgrep 下载超时（504）")
    } finally {
      await shell.dispose()
    }
  })

  test("up and down move the selection; a running node's note counts down, a waiting node's names its wave", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      await press(shell, "down")
      const running = await shell.frame()
      expect(lineWith(running, "typecheck")).toContain("›")
      expect(running).toContain("剩余 2m 5s")
      expect(running).not.toContain("ripgrep")

      await press(shell, "down")
      const waiting = await shell.frame()
      expect(lineWith(waiting, "unit")).toContain("›")
      expect(waiting).toContain("等待第 4 波")

      await press(shell, "up")
      await press(shell, "up")
      expect(lineWith(await shell.frame(), "e2e")).toContain("›")
    } finally {
      await shell.dispose()
    }
  })

  test("a node that was restarted says so", async () => {
    const server = dagServer({
      tables: { [WF]: [wire("flaky", "running", { replan_attempts: 2, started_at: NOW - 5_000 })] },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("已重启 ×2")
    } finally {
      await shell.dispose()
    }
  })

  test("enter on a node with a session goes to it and closes the panel", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      // The failed node starts selected, and it has a session.
      expect(await shell.frame()).toContain("进入子 agent")
      await press(shell, "return")
      await waitFor(() => depth(shell) === 0)
      expect(JSON.parse(JSON.stringify(shell.route().data))).toEqual({ type: "session", sessionID: NODE_SESSION })
      await waitFor(() => shell.sync().dag.nodes(WF) === undefined)
      // The session was not retrying, so the way in says nothing.
      expect(shell.toast().currentToast).toBeNull()
    } finally {
      await shell.dispose()
    }
  })

  test("enter on a node whose session is retrying goes to it and says why in the footer", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      shell.sync().set("session_status", NODE_SESSION, { type: "retry", attempt: 2, message: "rate limited", next: 0 })
      await press(shell, "return")
      await waitFor(() => depth(shell) === 0)
      expect(JSON.parse(JSON.stringify(shell.route().data))).toEqual({ type: "session", sessionID: NODE_SESSION })
      expect(shell.toast().currentToast).toMatchObject({ level: "warning", text: "子 agent 正在重试：rate limited" })
    } finally {
      await shell.dispose()
    }
  })

  test("enter on a node without one opens its details, and the output is read once however often it is toggled", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      await press(shell, "down")
      expect(lineWith(await shell.frame(), "typecheck")).toContain("›")
      expect(await shell.frame()).toContain("展开")
      expect(shell.server.reads).toEqual([WF])

      await press(shell, "return")
      const open = await shell.waitForFrame((frame) => frame.includes('"verdict":"pending"'))
      expect(open).toContain("输出：")
      expect(shell.server.reads).toEqual([WF, WF])

      await press(shell, "return")
      expect(await shell.frame()).not.toContain('"verdict":"pending"')
      await press(shell, "return")
      expect(await shell.frame()).toContain('"verdict":"pending"')
      expect(shell.server.reads).toEqual([WF, WF])
      expect(depth(shell)).toBe(1)
    } finally {
      await shell.dispose()
    }
  })

  test("a reconnect drops the outputs read before it and reads the open ones again", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      await press(shell, "down")
      await press(shell, "return")
      await shell.waitForFrame((frame) => frame.includes('"verdict":"pending"'))
      expect(shell.server.reads).toEqual([WF, WF])

      // The node completed while the connection was down.
      shell.server.tables[WF] = pipeline().map((node) =>
        node.id === "typecheck" ? { ...node, status: "completed", output: { verdict: "ACCEPT" } } : node,
      )
      shell.events.reconnect()
      const after = await shell.waitForFrame((frame) => frame.includes('"verdict":"ACCEPT"'))
      expect(after).not.toContain('"verdict":"pending"')
      // One read for the table, then one for the open node's output once the table is in.
      await Bun.sleep(200)
      expect(shell.server.reads).toEqual([WF, WF, WF, WF])
    } finally {
      await shell.dispose()
    }
  })

  test("an open node that finishes or starts another attempt shows the output of its current state", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      await press(shell, "down")
      await press(shell, "return")
      await shell.waitForFrame((frame) => frame.includes('"verdict":"pending"'))
      expect(shell.server.reads).toEqual([WF, WF])

      // Connected the whole time: the node completes and the push carries its new status.
      const completed = (attempt?: string) =>
        pipeline().map((node) =>
          node.id === "typecheck"
            ? {
                ...node,
                status: "completed",
                output: { verdict: attempt ? "RETRIED" : "ACCEPT" },
                ...(attempt ? { attempt_id: attempt } : {}),
              }
            : node,
        )
      shell.server.tables[WF] = completed()
      shell.events.emit(nodesPush({ seq: 1, nodes: completed().filter((node) => node.id === "typecheck") }))
      const done = await shell.waitForFrame((frame) => frame.includes('"verdict":"ACCEPT"'))
      expect(done).not.toContain('"verdict":"pending"')
      expect(shell.server.reads).toEqual([WF, WF, WF])

      // Closing and reopening the same state reads nothing more.
      await press(shell, "return")
      await press(shell, "return")
      expect(await shell.frame()).toContain('"verdict":"ACCEPT"')
      expect(shell.server.reads).toEqual([WF, WF, WF])

      // Another attempt of the same node is another output.
      shell.server.tables[WF] = completed("att_2")
      shell.events.emit(nodesPush({ seq: 2, nodes: completed("att_2").filter((node) => node.id === "typecheck") }))
      await shell.waitForFrame((frame) => frame.includes('"verdict":"RETRIED"'))
      expect(shell.server.reads).toEqual([WF, WF, WF, WF])
    } finally {
      await shell.dispose()
    }
  })

  test("o opens the details of any node, a node with a session included, and shows what the row leaves out", async () => {
    const server = dagServer({
      tables: {
        [WF]: [
          wire("worker", "running", {
            child_session_id: NODE_SESSION,
            started_at: NOW - 9_000,
            directory: "/work/tree",
            head: "abc1234",
            attempt_id: "att-1",
            accepted_input_revision: 3,
            snapshot_revision: 2,
            agent_messages: { queued: 1, delivered: 4, undeliverable: 0 },
            output: "all good",
          }),
        ],
      },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      await press(shell, "o")
      const frame = await shell.waitForFrame((value) => value.includes("all good"))
      expect(frame).toContain("消息：1 排队 · 4 已投递 · 0 无法投递")
      expect(frame).toContain("尝试 att-1 · 输入 3 · 快照 2")
      expect(frame).toContain("目录：/work/tree")
      expect(frame).toContain("提交：abc1234")
      expect(depth(shell)).toBe(1)
      await press(shell, "o")
      expect(await shell.frame()).not.toContain("all good")
    } finally {
      await shell.dispose()
    }
  })

  test("an output that cannot be read says so, and a node with none says that", async () => {
    const server = dagServer({
      tables: { [WF]: [wire("quiet", "completed", { started_at: NOW - 9_000, completed_at: NOW - 8_000 })] },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      await press(shell, "o")
      expect(await shell.waitForFrame((value) => value.includes("输出：无"))).toContain("输出：无")
    } finally {
      await shell.dispose()
    }
  })

  test("left and right switch workflows, the panel's hold follows, and the choice is remembered for the band", async () => {
    const server = dagServer({
      summaries: {
        [ROOT]: [summaryOf(WF, "依赖升级验证", "running"), summaryOf(WF2, "文档整理", "completed")],
      },
      tables: {
        [WF]: pipeline(),
        [WF2]: [wire("docs", "completed", { started_at: NOW - 9_000, completed_at: NOW - 4_000 }, WF2)],
      },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      const first = await shell.frame()
      expect(first).toContain("依赖升级验证")
      expect(first).toContain("文档整理")
      expect(shell.sync().dag.focus.chosen(ROOT)).toBeUndefined()

      await press(shell, "right")
      await waitFor(() => shell.sync().dag.nodes(WF2) !== undefined, 10_000)
      const second = await shell.waitForFrame((frame) => frame.includes("[已完成]"))
      expect(second).toContain("docs")
      expect(second).not.toContain("typecheck")
      expect(shell.sync().dag.focus.chosen(ROOT)).toBe(WF2)
      // Only what is shown is held: the first workflow's table went when it left the screen.
      expect(shell.sync().dag.nodes(WF)).toBeUndefined()
      expect(shell.server.reads).toEqual([WF, WF2])

      await press(shell, "left")
      await waitFor(() => shell.sync().dag.nodes(WF) !== undefined, 10_000)
      expect(shell.sync().dag.nodes(WF2)).toBeUndefined()
      expect(shell.sync().dag.focus.chosen(ROOT)).toBe(WF)
    } finally {
      await shell.dispose()
    }
  })

  test("it opens on the workflow the band would show: the running one, not the newest", async () => {
    const server = dagServer({
      summaries: {
        [ROOT]: [summaryOf(WF2, "文档整理", "completed"), summaryOf(WF, "依赖升级验证", "running")],
      },
      tables: { [WF]: pipeline(), [WF2]: [wire("docs", "completed", {}, WF2)] },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("[运行中]")
      expect(shell.server.reads).toEqual([WF])
    } finally {
      await shell.dispose()
    }
  })

  test("opening a workflow counts as having seen it, and the panel does not jump away from it for that", async () => {
    const server = dagServer({
      summaries: {
        [ROOT]: [summaryOf(WF2, "文档整理", "completed"), summaryOf(WF, "依赖升级验证", "failed")],
      },
      tables: { [WF]: pipeline(), [WF2]: [wire("docs", "completed", {}, WF2)] },
    })
    const shell = await mountDag({ server })
    try {
      expect([...shell.sync().dag.focus.acknowledged(ROOT)]).toEqual([])
      await openLoaded(shell)
      // The failed one was the one the band would have kept; it is what the panel opened on.
      expect(await shell.frame()).toContain("[失败]")
      expect([...shell.sync().dag.focus.acknowledged(ROOT)]).toEqual([WF])
      await shell.settle()
      expect(await shell.frame()).toContain("[失败]")
      expect(shell.server.reads).toEqual([WF])
      // Having chosen nothing, nothing is remembered as chosen.
      expect(shell.sync().dag.focus.chosen(ROOT)).toBeUndefined()
    } finally {
      await shell.dispose()
    }
  })

  test("a workflow that vanishes while it is shown hands the panel to the next one", async () => {
    const server = dagServer({
      summaries: { [ROOT]: [summaryOf(WF, "依赖升级验证", "running"), summaryOf(WF2, "文档整理", "completed")] },
      tables: { [WF]: pipeline(), [WF2]: [wire("docs", "completed", {}, WF2)] },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      shell.events.emit(summaryPush([summaryOf(WF2, "文档整理", "completed")]))
      await shell.waitForFrame((frame) => frame.includes("docs"))
      expect(await shell.frame()).not.toContain("typecheck")
    } finally {
      await shell.dispose()
    }
  })

  test("the sub-agent view shows the workflows of the root session's tree", async () => {
    const shell = await mountDag({ sessionID: CHILD })
    try {
      await shell.registry().run("dag.open", { args: "", origin: "palette" })
      await waitFor(() => topID(shell) === "dag", 10_000)
      await waitFor(() => shell.sync().dag.nodes(WF) !== undefined, 10_000)
      expect(await shell.frame()).toContain("依赖升级验证")
    } finally {
      await shell.dispose()
    }
  })
})

describe("asking the main agent: the panel only fills in the input", () => {
  test("i lists the templates the selected node allows, and nothing the state rules out", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      await press(shell, "i")
      expect(depth(shell)).toBe(2)
      expect(topID(shell)).toBe("dag-request")
      const frame = await shell.frame()
      expect(frame).toContain("请主 agent 处理")
      expect(frame).toContain("检查当前状态")
      expect(frame).toContain("重试节点 e2e")
      expect(frame).toContain("暂停工作流")
      expect(frame).toContain("取消所有运行中的工作流")
      // The failed node is selected and the workflow is running: no resume, and no acting on a running node.
      expect(frame).not.toContain("恢复工作流")
      expect(frame).not.toContain("取消节点")
      expect(frame).not.toContain("延长节点")
    } finally {
      await shell.dispose()
    }
  })

  test("a running node has other templates than a failed one", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      await press(shell, "down")
      await press(shell, "i")
      const frame = await shell.frame()
      expect(frame).toContain("取消节点 typecheck")
      expect(frame).toContain("延长节点 typecheck 的超时")
      expect(frame).toContain("向节点 typecheck 的 agent 转达")
      expect(frame).not.toContain("重试节点")
    } finally {
      await shell.dispose()
    }
  })

  test("choosing one closes every panel and leaves the text in the input, focused and not sent", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      await press(shell, "i")
      for (let index = 0; index < 3; index++) await press(shell, "down")
      expect(await shell.frame()).toContain("重试节点 e2e")
      await press(shell, "return")
      await waitFor(() => depth(shell) === 0)
      await shell.settle()
      expect(shell.promptDraft()).toBe("请重试节点 e2e（工作流 wf_alpha）。")
      expect(await shell.frame()).toContain("请重试节点 e2e（工作流 wf_alpha）。")
      expect(shell.writes()).toEqual([])
      expect(shell.app.renderer.currentFocusedRenderable?.constructor.name).toBe("TextareaRenderable")
    } finally {
      await shell.dispose()
    }
  })

  test("a draft is kept: the text is added on a new line after it", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      shell.app.mockInput.pressEscape()
      await waitFor(() => depth(shell) === 0)
      await shell.app.mockInput.typeText("look first")
      await shell.settle()
      // The input holds a draft, so `/dag` cannot be typed after it: run the command as the palette does.
      await shell.registry().run("dag.open", { args: "", origin: "palette" })
      await waitFor(() => topID(shell) === "dag", 10_000)
      await waitFor(() => shell.sync().dag.nodes(WF) !== undefined, 10_000)
      await press(shell, "i")
      await press(shell, "return")
      await waitFor(() => depth(shell) === 0)
      await shell.settle()
      expect(shell.promptDraft()?.startsWith("look first\n请检查工作流「依赖升级验证」(wf_alpha)")).toBe(true)
      expect(shell.writes()).toEqual([])
    } finally {
      await shell.dispose()
    }
  })

  test("a template that ends where the user goes on writing leaves the cursor there", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      await press(shell, "down")
      await press(shell, "i")
      for (let index = 0; index < 5; index++) await press(shell, "down")
      expect(await shell.frame()).toContain("向节点 typecheck 的 agent 转达")
      await press(shell, "return")
      await waitFor(() => depth(shell) === 0)
      await shell.settle()
      expect(shell.promptDraft()).toBe("请向节点 typecheck（工作流 wf_alpha）的 agent 转达：")
      expect(shell.writes()).toEqual([])
    } finally {
      await shell.dispose()
    }
  })

  test("escape in the list comes back to the panel where it was", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      await press(shell, "down")
      await press(shell, "return")
      await shell.waitForFrame((value) => value.includes("输出："))
      await press(shell, "i")
      expect(depth(shell)).toBe(2)
      shell.app.mockInput.pressEscape()
      await waitFor(() => depth(shell) === 1)
      await waitFor(() => topID(shell) === "dag")
      const frame = await shell.waitForFrame((value) => value.includes('"verdict":"pending"'))
      // The selection, and the node opened before, are as they were left.
      expect(lineWith(frame, "typecheck")).toContain("›")
      expect(shell.promptDraft()).toBe("")
    } finally {
      await shell.dispose()
    }
  })

  test("from a sub-agent view the text goes to the root session's input", async () => {
    const shell = await mountDag({ sessionID: CHILD })
    try {
      await shell.registry().run("dag.open", { args: "", origin: "palette" })
      await waitFor(() => topID(shell) === "dag", 10_000)
      await waitFor(() => shell.sync().dag.nodes(WF) !== undefined, 10_000)
      await press(shell, "i")
      await press(shell, "return")
      await waitFor(() => depth(shell) === 0)
      await waitFor(() => {
        const data = shell.route().data
        return data.type === "session" && data.sessionID === ROOT
      }, 10_000)
      await waitFor(() => (shell.promptDraft() ?? "").includes("依赖升级验证"), 10_000)
      expect(shell.writes()).toEqual([])
    } finally {
      await shell.dispose()
    }
  })

  test("the English texts follow the interface language", async () => {
    const shell = await mountDag({ language: "en" })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("Ask main agent")
      await press(shell, "i")
      for (let index = 0; index < 3; index++) await press(shell, "down")
      await press(shell, "return")
      await waitFor(() => depth(shell) === 0)
      await shell.settle()
      expect(shell.promptDraft()).toBe("Please retry node e2e (workflow wf_alpha).")
    } finally {
      await shell.dispose()
    }
  })
})

describe("what the panel costs", () => {
  test("a key inside the panel registers no keymap layer: the panel's layers are made when it mounts", async () => {
    const shell = await mountDag()
    const counters = createCounters(shell.app.renderer, shell.keymap())
    try {
      const start = counters.snapshot()
      await openLoaded(shell)
      // The two layers of the detail template, the panel's own, and the host's, which follows how deep the stack is.
      expect(counters.delta(start).registerLayer).toBeLessThanOrEqual(4)

      const mounted = counters.snapshot()
      for (const key of ["down", "down", "up", "o", "return", "o", "i"]) await press(shell, key)
      shell.app.mockInput.pressEscape()
      await waitFor(() => depth(shell) === 1)
      await shell.settle()
      // Moving, opening details, asking, and coming back from the list: the list's own layers are the only ones.
      expect(counters.delta(mounted).registerLayer).toBeLessThanOrEqual(6)

      const settled = counters.snapshot()
      for (const key of ["down", "up", "o", "o"]) await press(shell, key)
      expect(counters.delta(settled).registerLayer).toBe(0)
    } finally {
      counters.dispose()
      await shell.dispose()
    }
  })

  test("it writes nothing into the message and part stores", async () => {
    const shell = await mountDag()
    const probe = probeStoreWrites(shell.sync().data, ["message", "part"])
    try {
      await openLoaded(shell)
      for (const key of ["down", "o", "return", "up", "i"]) await press(shell, key)
      shell.events.emit(nodesPush({ seq: 1, nodes: [wire("unit", "running", { depends_on: ["typecheck"] })] }))
      await shell.settle()
      expect(probe.total()).toBe(0)
    } finally {
      probe.dispose()
      await shell.dispose()
    }
  })
})

describe("the panel is read-only", () => {
  test("after everything reachable has been done, the server was only read from", async () => {
    const server = dagServer({
      summaries: { [ROOT]: [summaryOf(WF, "依赖升级验证", "running"), summaryOf(WF2, "文档整理", "completed")] },
      tables: { [WF]: pipeline(), [WF2]: [wire("docs", "completed", {}, WF2)] },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      for (const key of ["down", "down", "up", "return", "o", "return", "right", "left"]) await press(shell, key)
      await press(shell, "i")
      shell.app.mockInput.pressEscape()
      await waitFor(() => depth(shell) === 1)
      await press(shell, "i")
      await press(shell, "return")
      await waitFor(() => depth(shell) === 0)
      await shell.settle()

      expect(shell.writes()).toEqual([])
      const dag = shell.requested.filter((entry) => entry.includes("/dag"))
      expect(dag.length).toBeGreaterThan(0)
      expect(dag.filter((entry) => !entry.startsWith("GET "))).toEqual([])
    } finally {
      await shell.dispose()
    }
  })

  test("a sub-agent view reaches the panel and asks for nothing but reads either", async () => {
    const shell = await mountDag({ sessionID: CHILD })
    try {
      await shell.registry().run("dag.open", { args: "", origin: "palette" })
      await waitFor(() => topID(shell) === "dag", 10_000)
      await waitFor(() => shell.sync().dag.nodes(WF) !== undefined, 10_000)
      for (const key of ["down", "o", "return", "up"]) await press(shell, key)
      expect(shell.writes()).toEqual([])
    } finally {
      await shell.dispose()
    }
  })
})

describe("what the panel does with text from the server", () => {
  test("escapes and line breaks in names, titles and reasons never reach the screen", async () => {
    const server = dagServer({
      summaries: { [ROOT]: [summaryOf(WF, "标题\u001b[31m红\u001b[0m", "failed")] },
      tables: {
        [WF]: [
          wire("bad\u001b[2Jname", "failed", {
            error_reason: "line one\nline two\u001b]0;pwned\u0007",
          }),
        ],
      },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
      expect(frame).toContain("标题红")
      expect(frame).toContain("badname")
      expect(frame).toContain("line one line two")
      expect(frame).not.toContain("pwned")
    } finally {
      await shell.dispose()
    }
  })
})

describe("how it looks", () => {
  async function look(options: Parameters<typeof mountDag>[0]) {
    const shell = await mountDag(options)
    await openLoaded(shell)
    const frame = await shell.frame()
    await shell.dispose()
    return frame
  }

  test("80 by 24, in Chinese", async () => {
    expect(await look({ width: 80, height: 24 })).toMatchSnapshot()
  })

  test("120 by 40, in Chinese", async () => {
    expect(await look({ width: 120, height: 40 })).toMatchSnapshot()
  })

  test("80 by 24, in English", async () => {
    expect(await look({ width: 80, height: 24, language: "en" })).toMatchSnapshot()
  })

  test("a workflow with several tabs and a loop, 100 by 30", async () => {
    const server = dagServer({
      summaries: {
        [ROOT]: [
          summaryOf(WF, "有环的工作流", "running", { nodeCount: 4, completedNodes: 1 }),
          summaryOf(WF2, "文档整理", "completed"),
        ],
      },
      tables: {
        [WF]: [
          wire("start", "completed", { started_at: NOW - 60_000, completed_at: NOW - 30_000 }),
          wire("x", "pending", { depends_on: ["y"] }),
          wire("y", "pending", { depends_on: ["x"] }),
          wire("after", "pending", { depends_on: ["x"] }),
        ],
        [WF2]: [wire("docs", "completed", {}, WF2)],
      },
    })
    expect(await look({ width: 100, height: 30, server })).toMatchSnapshot()
  })

  for (const language of ["zh-CN", "en"] as const) {
    for (const ambiguousWidth of [1, 2] as const) {
      test(`nothing is laid out wider than 80 columns, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
        const reason = "一条相当长的失败原因，用来检查说明行在窄终端下被截断而不是换行或溢出".repeat(2)
        const server = dagServer({
          summaries: {
            [ROOT]: [
              summaryOf(WF, "一个相当长的工作流标题用来检查窄终端下是否会溢出到边框外面去", "running", {
                nodeCount: 60,
                completedNodes: 19,
                runningNodes: 0,
                failedNodes: 1,
                queuedNodes: 40,
              }),
            ],
          },
          tables: {
            [WF]: [
              // Thirty waves of one node, then thirty nodes that wait on the last: far more than the bar has cells for.
              ...Array.from({ length: 30 }, (_, index) => {
                const id = `step-${String(index).padStart(2, "0")}`
                const depends_on = index === 0 ? [] : [`step-${String(index - 1).padStart(2, "0")}`]
                if (index === 2)
                  return wire(id, "failed", {
                    depends_on,
                    started_at: NOW - 90_000,
                    completed_at: NOW - 80_000,
                    error_reason: reason,
                  })
                if (index < 20)
                  return wire(id, "completed", { depends_on, started_at: NOW - 90_000, completed_at: NOW - 80_000 })
                return wire(id, "pending", { depends_on })
              }),
              ...Array.from({ length: 30 }, (_, index) =>
                wire(`late-${String(index).padStart(2, "0")}`, "pending", { depends_on: ["step-29"] }),
              ),
            ],
          },
        })
        const shell = await mountDag({ server, width: 80, height: 24, language, ambiguousWidth })
        try {
          await openLoaded(shell)
          const frame = await shell.frame()
          const lines = rowsOf(frame).filter((line) => line.startsWith("│") && line.endsWith("│"))
          expect(lines.length).toBeGreaterThan(5)
          for (const line of lines) {
            // Inside the border and the padding: what the panel itself laid out.
            const inner = line.slice(1, -1).trimEnd()
            expect({ line, fits: cellWidth(inner, ambiguousWidth) <= 80 - 3 }).toEqual({ line, fits: true })
          }
          // The bar is cut to the room there is, and uses nearly all of it: 76 cells inside border and padding.
          const bar = lines.find((line) => /^│ [━─╌! ]+│$/.test(line))
          if (bar === undefined) throw new Error(`no bar in the frame:\n${frame}`)
          const cells = cellWidth(bar.slice(2, -1).trimEnd(), ambiguousWidth)
          expect(cells).toBeLessThanOrEqual(76)
          expect(cells).toBeGreaterThanOrEqual(72)
          // The failed node starts selected and its long reason is cut to one row, not wrapped onto two.
          expect(lines.filter((line) => line.includes("一条相当长的失败原因")).length).toBe(1)
          expect(lines.find((line) => line.includes("一条相当长的失败原因"))).toContain("…")
        } finally {
          await shell.dispose()
        }
      })
    }
  }
})

// ── DAG mode in the panel (#1032 7) ────────────────────────────────────────────────────────────────────────────

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

/** The color a piece of text is drawn in: the foreground of the first span that holds it. */
function colorOf(frame: Awaited<ReturnType<Shell["spans"]>>, needle: string) {
  for (const line of frame.lines) {
    for (const span of line.spans) if (span.text.includes(needle)) return span.fg
  }
  return undefined
}

const modeSessions = [
  sessionFixture(ROOT, { dagMode: "on" }),
  sessionFixture(CHILD, { parentID: ROOT }),
  sessionFixture(NODE_SESSION, { parentID: ROOT }),
]

/** A session with 1.2M of a 5M budget used, `running` slots busy of twelve (three by default), nodes capped at 100. */
const snapshot = (extra: Partial<SessionDagMode["budget"]> = {}, running = 3) =>
  dagModeStatus({
    mode: "on",
    budget: { tokens: 5_000_000, used: 1_200_000, usedCacheRead: 0, warnRatio: 0.8, ...extra },
    limits: { concurrency: 12, maxTotalNodes: 100, running },
  })

function quality(extra: Partial<DagWorkflowQuality> = {}): DagWorkflowQuality {
  return {
    reviewBound: true,
    reviews: 2,
    raised: 7,
    fixed: 5,
    refuted: 2,
    stillOpen: 0,
    skepticRefutations: 1,
    rounds: 4,
    quietRounds: 2,
    completeness: { covered: 5, total: 6, unlisted: 0 },
    ...extra,
  }
}

const frameLines = (frame: string) => rowsOf(frame).map((line) => line.replace(/^│\s?/, "").replace(/\s*│$/, ""))

describe("the mode line above the workflow", () => {
  test("says the mode, the slots of the whole process, the node cap and the tokens against the budget", async () => {
    const server = dagServer({ mode: snapshot() })
    const shell = await mountDag({ server, sessions: modeSessions })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      const lines = frameLines(frame)
      const mode = lines.findIndex((line) => line.includes("DAG 模式：开"))
      expect(mode).toBeGreaterThan(-1)
      expect(lines[mode]).toContain("DAG 模式：开 · 运行 3/12（全进程） · 节点上限 100 · token 1.2M/5M")
      // It is the first line of the summary: the bar comes after it.
      expect(lines.findIndex((line) => /^[━─╌! ]+$/.test(line))).toBeGreaterThan(mode)
    } finally {
      await shell.dispose()
    }
  })

  test("says off when the session's mode is off, and keeps the figures", async () => {
    const server = dagServer({ mode: snapshot() })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("DAG 模式：关 · 运行 3/12（全进程） · 节点上限 100 · token 1.2M/5M")
    } finally {
      await shell.dispose()
    }
  })

  test("takes the tokens from the workflows' summaries once they report them, and follows their events", async () => {
    // The snapshot is read after the summary and its slot count is the later report, so it counts the same five;
    // the tokens differ on purpose: the summary's stand for the session's usage, the snapshot's figure is older.
    const server = dagServer({
      mode: snapshot({}, 5),
      summaries: { [ROOT]: [summaryOf(WF, "依赖升级验证", "running", { tokens: 4_000_000, concurrencyRunning: 5 })] },
    })
    const shell = await mountDag({ server, sessions: modeSessions })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("运行 5/12（全进程） · 节点上限 100 · token 4M/5M")

      shell.events.emit(
        summaryPush([summaryOf(WF, "依赖升级验证", "running", { tokens: 4_500_000, concurrencyRunning: 2 })]),
      )
      await shell.settle()
      expect(await shell.frame()).toContain("运行 2/12（全进程） · 节点上限 100 · token 4.5M/5M")
    } finally {
      await shell.dispose()
    }
  })

  test("follows the slots of the whole process when another session's workflows move them", async () => {
    const server = dagServer({
      mode: snapshot(),
      summaries: { [ROOT]: [summaryOf(WF, "依赖升级验证", "running", { tokens: 4_000_000, concurrencyRunning: 3 })] },
    })
    const shell = await mountDag({ server, sessions: modeSessions })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("运行 3/12（全进程）")

      // Only the other session's own summary says so; this session's workflows keep their old figure of three.
      shell.events.emit(
        summaryPush(
          [summaryOf("wf_elsewhere", "别处的工作流", "running", { concurrencyRunning: 8 })],
          "ses_dag_elsewhere",
        ),
      )
      await shell.settle()
      expect(await shell.frame()).toContain("运行 8/12（全进程） · 节点上限 100 · token 4M/5M")
    } finally {
      await shell.dispose()
    }
  })

  test("colors the tokens by the band of the budget, and nothing else on the line", async () => {
    const at = async (tokens: number) => {
      const server = dagServer({
        mode: snapshot({ tokens: 1000, used: tokens }),
        summaries: { [ROOT]: [summaryOf(WF, "依赖升级验证", "running", { tokens })] },
      })
      const shell = await mountDag({ server, sessions: modeSessions })
      try {
        await openLoaded(shell)
        const frame = await shell.spans()
        return {
          tokens: colorOf(frame, `token ${formatDagTokens(tokens)}/${formatDagTokens(1000)}`),
          mode: colorOf(frame, "DAG 模式：开"),
        }
      } finally {
        await shell.dispose()
      }
    }
    const quiet = await at(100)
    expect(quiet.tokens?.equals(palette().textMuted)).toBe(true)
    const warn = await at(850)
    expect(warn.tokens?.equals(palette().warning)).toBe(true)
    const exhausted = await at(1000)
    expect(exhausted.tokens?.equals(palette().error)).toBe(true)
    expect(exhausted.mode?.equals(palette().error)).toBe(false)
  })

  test("without a budget the tokens say there is none", async () => {
    const server = dagServer({ mode: snapshot({ tokens: null }) })
    const shell = await mountDag({ server, sessions: modeSessions })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("节点上限 100 · token 1.2M（未设预算）")
    } finally {
      await shell.dispose()
    }
  })

  test("when the snapshot cannot be read it says the mode, which is the session's own, and nothing it does not know", async () => {
    const server = dagServer({ mode: "fail" })
    const shell = await mountDag({ server, sessions: modeSessions })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).toContain("DAG 模式：开")
      expect(frame).not.toContain("全进程")
      expect(frame).not.toContain("节点上限")
    } finally {
      await shell.dispose()
    }
  })

  test("says it in English", async () => {
    const server = dagServer({ mode: snapshot() })
    const shell = await mountDag({ server, sessions: modeSessions, language: "en", width: 100 })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain(
        "DAG mode: on · running 3/12 (process-wide) · node cap 100 · tokens 1.2M/5M",
      )
    } finally {
      await shell.dispose()
    }
  })

  test("reads nothing but the one snapshot, and writes nothing", async () => {
    const server = dagServer({ mode: snapshot() })
    const shell = await mountDag({ server, sessions: modeSessions })
    try {
      await openLoaded(shell)
      expect(shell.requested.filter((entry) => entry.endsWith("/dag-mode"))).toHaveLength(1)
      expect(shell.writes()).toEqual([])
    } finally {
      await shell.dispose()
    }
  })
})

describe("the review quality row", () => {
  const withQuality = (value: DagWorkflowQuality | null | undefined, id = WF, title = "依赖升级验证") =>
    summaryOf(id, title, "running", value === undefined ? {} : { quality: value })

  test("says reviews, what is still open and how complete the acceptance items are, under the counts", async () => {
    const server = dagServer({ summaries: { [ROOT]: [withQuality(quality())] } })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      const lines = frameLines(await shell.frame())
      const row = lines.findIndex((line) => line.includes("审核 2 次 · 遗留 0 项 · 完整性 5/6"))
      expect(row).toBeGreaterThan(-1)
      expect(row).toBeGreaterThan(lines.findIndex((line) => line.includes("完成 · 第")))
    } finally {
      await shell.dispose()
    }
  })

  test("is not there for a workflow without a review decision", async () => {
    for (const value of [null, undefined]) {
      const server = dagServer({ summaries: { [ROOT]: [withQuality(value)] } })
      const shell = await mountDag({ server })
      try {
        await openLoaded(shell)
        expect(await shell.frame()).not.toContain("审核")
      } finally {
        await shell.dispose()
      }
    }
  })

  test("belongs to the workflow on show: switching tabs changes it, and a pushed summary updates it", async () => {
    const server = dagServer({
      summaries: {
        [ROOT]: [
          withQuality(quality({ reviews: 3, stillOpen: 1 })),
          withQuality(quality({ reviews: 6, completeness: null }), WF2, "文档整理"),
        ],
      },
      tables: { [WF]: pipeline(), [WF2]: [wire("docs", "completed", {}, WF2)] },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("审核 3 次 · 遗留 1 项 · 完整性 5/6")

      await press(shell, "right")
      await waitFor(() => shell.sync().dag.nodes(WF2) !== undefined)
      await shell.settle()
      const second = await shell.frame()
      expect(second).toContain("审核 6 次 · 遗留 0 项")
      expect(second).not.toContain("完整性")

      shell.events.emit(
        summaryPush([
          withQuality(quality({ reviews: 3, stillOpen: 1 })),
          withQuality(quality({ reviews: 7 }), WF2, "文档整理"),
        ]),
      )
      await shell.settle()
      expect(await shell.frame()).toContain("审核 7 次 · 遗留 0 项 · 完整性 5/6")
    } finally {
      await shell.dispose()
    }
  })

  test("says it in English", async () => {
    const server = dagServer({ summaries: { [ROOT]: [withQuality(quality())] } })
    const shell = await mountDag({ server, language: "en" })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("reviews 2 · open 0 · complete 5/6")
    } finally {
      await shell.dispose()
    }
  })
})

describe("what the work did not cover", () => {
  /** A table in which one node of each kind of gap sits among the ones that are fine. */
  function gaps(workflow = WF): DagNode[] {
    return [
      wire("resolve", "completed", {}, workflow),
      wire("e2e", "failed", { depends_on: ["resolve"], error_reason: "ripgrep 下载超时（504）" }, workflow),
      wire("docs", "skipped", { depends_on: ["resolve"] }, workflow),
      wire("lint", "failed", { depends_on: ["resolve"], error_class: "cancelled" }, workflow),
      wire("perf", "aborted", { depends_on: ["resolve"] }, workflow),
      wire("unit", "pending", { depends_on: ["e2e"] }, workflow),
    ]
  }

  const covered = (count: number | undefined, table = gaps()) =>
    dagServer({
      summaries: {
        [ROOT]: [summaryOf(WF, "依赖升级验证", "running", count === undefined ? {} : { coverageCount: count })],
      },
      tables: { [WF]: table },
    })

  test("lists the failed, skipped, cancelled and aborted nodes with the reason, in the summary above the rows", async () => {
    const shell = await mountDag({ server: covered(4), height: 40 })
    try {
      await openLoaded(shell)
      const lines = frameLines(await shell.frame())
      const title = lines.findIndex((line) => line.includes("覆盖与截断（4）"))
      expect(title).toBeGreaterThan(-1)
      const block = lines.slice(title + 1, title + 5)
      expect(block.some((line) => line.includes("✗ e2e") && line.includes("ripgrep 下载超时（504）"))).toBe(true)
      expect(block.some((line) => line.includes("⊘ docs"))).toBe(true)
      expect(block.some((line) => line.includes("⊘ lint"))).toBe(true)
      expect(block.some((line) => line.includes("↯ perf"))).toBe(true)
      // It sits with the summary, above the rows, so it is on screen when the panel opens; nothing that is fine is in it.
      expect(title).toBeGreaterThan(lines.findIndex((line) => line.includes("完成 · 第")))
      expect(title).toBeLessThan(lines.findIndex((line) => line.includes("第 1 波")))
      expect(block.some((line) => line.includes("resolve") || line.includes("unit"))).toBe(false)
      // Four entries, four nodes: nothing is left over to account for.
      expect(lines.join("\n")).not.toContain("不对应节点")
    } finally {
      await shell.dispose()
    }
  })

  test("accounts for the entries that are not nodes: the count is the server's, the list is what the nodes say", async () => {
    const shell = await mountDag({ server: covered(7), height: 40 })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).toContain("覆盖与截断（7）")
      expect(frame).toContain("另有 3 项不对应节点")
    } finally {
      await shell.dispose()
    }
  })

  test("says both remainders on one line when a long list and entries that are not nodes come together", async () => {
    const many = [
      wire("resolve", "completed"),
      ...Array.from({ length: 6 }, (_, index) => wire(`gap-${index}`, "skipped", { depends_on: ["resolve"] })),
    ]
    const shell = await mountDag({ server: covered(9, many), height: 40 })
    try {
      await openLoaded(shell)
      const lines = frameLines(await shell.frame())
      expect(lines.filter((line) => line.includes("… 还有 2 个 · 另有 3 项不对应节点"))).toHaveLength(1)
    } finally {
      await shell.dispose()
    }
  })

  test("a count with no node to show for it still says so", async () => {
    const shell = await mountDag({ server: covered(2, [wire("resolve", "completed")]), height: 40 })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).toContain("覆盖与截断（2）")
      expect(frame).toContain("另有 2 项不对应节点")
    } finally {
      await shell.dispose()
    }
  })

  test("is not there when the count is zero or the server does not report one", async () => {
    for (const count of [0, undefined]) {
      const shell = await mountDag({ server: covered(count), height: 40 })
      try {
        await openLoaded(shell)
        expect(await shell.frame()).not.toContain("覆盖与截断")
      } finally {
        await shell.dispose()
      }
    }
  })

  test("goes when the count falls to zero, and comes when a push raises it", async () => {
    const shell = await mountDag({ server: covered(4), height: 40 })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("覆盖与截断（4）")
      shell.events.emit(summaryPush([summaryOf(WF, "依赖升级验证", "running", { coverageCount: 0 })]))
      await shell.settle()
      expect(await shell.frame()).not.toContain("覆盖与截断")
      shell.events.emit(summaryPush([summaryOf(WF, "依赖升级验证", "running", { coverageCount: 5 })]))
      await shell.settle()
      expect(await shell.frame()).toContain("覆盖与截断（5）")
    } finally {
      await shell.dispose()
    }
  })

  test("shows a bounded list and says how many more there are", async () => {
    const many = [
      wire("resolve", "completed"),
      ...Array.from({ length: 12 }, (_, index) =>
        wire(`gap-${String(index).padStart(2, "0")}`, "skipped", { depends_on: ["resolve"] }),
      ),
    ]
    const shell = await mountDag({ server: covered(12, many), height: 60 })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).toContain("覆盖与截断（12）")
      expect(frame).toContain("… 还有 8 个")
      expect(frame).toContain("gap-03")
      // The rows below list every node; the block has the four first and the number of the rest.
      expect(frameLines(frame).filter((line) => /^\s*⊘ gap-\d+\s*$/.test(line))).toHaveLength(4)
    } finally {
      await shell.dispose()
    }
  })

  test("a reason from the server has no escapes or line breaks in it", async () => {
    const table = [wire("bad\u001b[2Jname", "failed", { error_reason: "one\ntwo\u001b]0;pwned\u0007" })]
    const shell = await mountDag({ server: covered(1, table), height: 40 })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
      expect(frame).toContain("badname")
      expect(frame).toContain("one two")
      expect(frame).not.toContain("pwned")
    } finally {
      await shell.dispose()
    }
  })

  test("says it in English", async () => {
    const shell = await mountDag({ server: covered(6), height: 40, language: "en", width: 100 })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).toContain("Coverage and cut-offs (6)")
      expect(frame).toContain("2 more not tied to a node")
    } finally {
      await shell.dispose()
    }
  })
})

describe("a budget that ran out", () => {
  const exhausted = (status: string, extra: Partial<DagWorkflowSummary> = {}) =>
    dagServer({
      mode: snapshot({ tokens: 1000, used: 1000 }),
      summaries: { [ROOT]: [summaryOf(WF, "依赖升级验证", status, { tokens: 1000, ...extra })] },
    })

  test("a paused workflow keeps the label of a pause and says the budget is gone", async () => {
    const shell = await mountDag({ server: exhausted("paused"), sessions: modeSessions })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).toContain("[已暂停]")
      expect(frame).toContain("token 预算已耗尽，因预算暂停的工作流会在预算调高后恢复")
    } finally {
      await shell.dispose()
    }
  })

  test("says it only of a pause that is not a checkpoint, and only once the budget is gone", async () => {
    const checkpoint = await mountDag({
      server: exhausted("paused", { checkpointPending: true }),
      sessions: modeSessions,
    })
    try {
      await openLoaded(checkpoint)
      expect(await checkpoint.frame()).not.toContain("token 预算已耗尽")
    } finally {
      await checkpoint.dispose()
    }

    const running = await mountDag({ server: exhausted("running"), sessions: modeSessions })
    try {
      await openLoaded(running)
      expect(await running.frame()).not.toContain("token 预算已耗尽")
    } finally {
      await running.dispose()
    }

    const plenty = dagServer({
      mode: snapshot({ tokens: 1000, used: 100 }),
      summaries: { [ROOT]: [summaryOf(WF, "依赖升级验证", "paused", { tokens: 100 })] },
    })
    const normal = await mountDag({ server: plenty, sessions: modeSessions })
    try {
      await openLoaded(normal)
      expect(await normal.frame()).not.toContain("token 预算已耗尽")
    } finally {
      await normal.dispose()
    }
  })

  test("says it in English", async () => {
    const shell = await mountDag({
      server: exhausted("paused"),
      sessions: modeSessions,
      language: "en",
      width: 120,
      height: 40,
    })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("Budget exhausted: paused workflows resume once it is raised")
    } finally {
      await shell.dispose()
    }
  })
})

describe("DAG mode in the panel: how it looks", () => {
  /**
   * A workflow with the additions on it: usage and quality, and with `gaps` the coverage block too. The panel is
   * ten rows high at 80 by 24, so the smaller sizes take the one without the block.
   */
  function full(gaps = true) {
    return dagServer({
      mode: snapshot({ tokens: 1_000_000, used: 850_000 }),
      summaries: {
        [ROOT]: [
          summaryOf(WF, "依赖升级验证", "running", {
            tokens: 850_000,
            concurrencyRunning: 3,
            ...(gaps ? { coverageCount: 3 } : {}),
            quality: quality(),
          }),
        ],
      },
      tables: {
        [WF]: [
          wire("resolve", "completed", { started_at: NOW - 600_000, completed_at: NOW - 598_000 }),
          wire("e2e", "failed", {
            depends_on: ["resolve"],
            error_reason: "ripgrep 下载超时（504）",
            started_at: NOW - 540_000,
            completed_at: NOW - 300_000,
          }),
          wire("docs", "skipped", { depends_on: ["resolve"] }),
          wire("unit", "running", { depends_on: ["resolve"], started_at: NOW - 100_000 }),
        ],
      },
    })
  }

  async function look(options: Omit<Parameters<typeof mountDag>[0] & object, "server" | "sessions">, gaps = true) {
    const shell = await mountDag({ ...options, server: full(gaps), sessions: modeSessions })
    await openLoaded(shell)
    const frame = await shell.frame()
    await shell.dispose()
    // Every addition is on screen before the frame is taken as the one to keep.
    expect(frame).toContain(options.language === "en" ? "DAG mode: on" : "DAG 模式：开")
    expect(frame).toContain(options.language === "en" ? "reviews 2" : "审核 2 次")
    if (gaps) expect(frame).toContain(options.language === "en" ? "Coverage and cut-offs (3)" : "覆盖与截断（3）")
    return frame
  }

  test("80 by 24, in Chinese", async () => {
    expect(await look({ width: 80, height: 24 }, false)).toMatchSnapshot()
  })

  test("120 by 40, in Chinese", async () => {
    expect(await look({ width: 120, height: 40 })).toMatchSnapshot()
  })

  test("80 by 24, in English", async () => {
    expect(await look({ width: 80, height: 24, language: "en" }, false)).toMatchSnapshot()
  })

  test("120 by 40, in English", async () => {
    expect(await look({ width: 120, height: 40, language: "en" })).toMatchSnapshot()
  })

  for (const language of ["zh-CN", "en"] as const) {
    for (const ambiguousWidth of [1, 2] as const) {
      test(`nothing it adds is laid out wider than 80 columns, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
        const shell = await mountDag({
          server: full(),
          sessions: modeSessions,
          width: 80,
          height: 40,
          language,
          ambiguousWidth,
        })
        try {
          await openLoaded(shell)
          const lines = rowsOf(await shell.frame()).filter((line) => line.startsWith("│") && line.endsWith("│"))
          expect(lines.length).toBeGreaterThan(8)
          for (const line of lines) {
            const inner = line.slice(1, -1).trimEnd()
            expect({ line, fits: cellWidth(inner, ambiguousWidth) <= 80 - 3 }).toEqual({ line, fits: true })
          }
          // The mode line is one row: cut with an ellipsis where it does not fit, never wrapped.
          expect(lines.filter((line) => /DAG (模式|mode)/.test(line))).toHaveLength(1)
        } finally {
          await shell.dispose()
        }
      })
    }
  }
})
