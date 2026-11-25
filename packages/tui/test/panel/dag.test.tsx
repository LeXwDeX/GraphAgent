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
import { GUTTER } from "../../src/ui/layout"
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

/**
 * A compose block after its slot expanded (#1158): the block's split node, three workers the plan asked for, which
 * name the slot they hang under, and the slot itself, now the join node that waits for them. One worker failed, one runs.
 */
function composed(workflow = WF): DagNode[] {
  return [
    wire("scope", "completed", { started_at: NOW - 600_000, completed_at: NOW - 590_000 }, workflow),
    wire(
      "review--split",
      "completed",
      { depends_on: ["scope"], started_at: NOW - 590_000, completed_at: NOW - 580_000 },
      workflow,
    ),
    wire(
      "review--api",
      "completed",
      {
        depends_on: ["review--split"],
        expanded_from: "review",
        started_at: NOW - 580_000,
        completed_at: NOW - 500_000,
      },
      workflow,
    ),
    wire(
      "review--core",
      "failed",
      {
        depends_on: ["review--split"],
        expanded_from: "review",
        started_at: NOW - 580_000,
        completed_at: NOW - 400_000,
        error_reason: "审查超时",
      },
      workflow,
    ),
    wire(
      "review--docs",
      "running",
      { depends_on: ["review--split"], expanded_from: "review", started_at: NOW - 580_000 },
      workflow,
    ),
    wire("review", "pending", { depends_on: ["review--api", "review--core", "review--docs"] }, workflow),
    wire("ship", "pending", { depends_on: ["review"] }, workflow),
  ]
}

/** A block whose docs worker was split again: a nested slot, whose own workers name it, under the outer one. */
function composedNested(workflow = WF): DagNode[] {
  return [
    wire("scope", "completed", { started_at: NOW - 600_000, completed_at: NOW - 590_000 }, workflow),
    wire(
      "review--split",
      "completed",
      { depends_on: ["scope"], started_at: NOW - 590_000, completed_at: NOW - 580_000 },
      workflow,
    ),
    wire(
      "review--api",
      "completed",
      {
        depends_on: ["review--split"],
        expanded_from: "review",
        started_at: NOW - 580_000,
        completed_at: NOW - 500_000,
      },
      workflow,
    ),
    // The nested split node and the nested slot name the outer slot; what the nested slot expanded into names it.
    wire(
      "review--docs--split",
      "completed",
      {
        depends_on: ["review--split"],
        expanded_from: "review",
        started_at: NOW - 580_000,
        completed_at: NOW - 570_000,
      },
      workflow,
    ),
    wire(
      "review--docs--intro",
      "completed",
      {
        depends_on: ["review--docs--split"],
        expanded_from: "review--docs",
        started_at: NOW - 570_000,
        completed_at: NOW - 520_000,
      },
      workflow,
    ),
    wire(
      "review--docs--refs",
      "running",
      { depends_on: ["review--docs--split"], expanded_from: "review--docs", started_at: NOW - 570_000 },
      workflow,
    ),
    wire(
      "review--docs",
      "pending",
      { depends_on: ["review--docs--intro", "review--docs--refs"], expanded_from: "review" },
      workflow,
    ),
    wire("review", "pending", { depends_on: ["review--api", "review--docs"] }, workflow),
    wire("ship", "pending", { depends_on: ["review"] }, workflow),
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
/** The rows of a frame without the gutter at their left: the panel's frame starts in the first column of what is left. */
const rowsOf = (frame: string) => frame.split("\n").map((line) => line.slice(GUTTER).trimEnd())
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

/** The cells a line puts before `needle`: where the text starts on the screen, wide characters counted as two. */
const columnOf = (line: string | undefined, needle: string, ambiguousWidth: 1 | 2 = 1) => {
  if (line === undefined || !line.includes(needle)) throw new Error(`no ${needle} in ${line}`)
  return cellWidth(line.slice(0, line.indexOf(needle)), ambiguousWidth)
}

/** A compose block's workflow, in the server's answer: nothing is asked of it but what it says. */
function composeServer(tables: Record<string, DagNode[]> = { [WF]: composed() }) {
  const nodes = tables[WF] ?? []
  const count = (...statuses: string[]) => nodes.filter((node) => statuses.includes(node.status)).length
  return dagServer({
    summaries: {
      [ROOT]: [
        summaryOf(WF, "代码审查", "running", {
          nodeCount: nodes.length,
          completedNodes: count("completed"),
          runningNodes: count("running"),
          failedNodes: count("failed"),
          queuedNodes: count("pending", "queued"),
        }),
      ],
    },
    tables,
  })
}

describe("an expansion folded under its slot", () => {
  test("the slot shows its own state and how many children it has; the children are not rows", async () => {
    const shell = await mountDag({ server: composeServer() })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      const slot = lineWith(frame, "review ")
      expect(slot).toContain("▸")
      expect(slot).toContain("○")
      expect(slot).toContain("（3 个子节点）")
      for (const child of ["review--api", "review--core", "review--docs"]) expect(frame).not.toContain(child)
      // What is not under a slot is as it was.
      for (const plain of ["scope", "review--split", "ship"]) expect(frame).toContain(plain)
      expect(lineWith(frame, "scope")).toContain("10s")
    } finally {
      await shell.dispose()
    }
  })

  test("a slot with one child says so in the singular, in each language", async () => {
    const one = composed().filter((node) => node.id !== "review--core" && node.id !== "review--docs")
    const server = composeServer({ [WF]: one })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("（1 个子节点）")
      setLanguage("en")
      await shell.settle()
      const frame = await shell.frame()
      expect(frame).toContain("(1 child)")
      expect(frame).not.toContain("1 children")
    } finally {
      await shell.dispose()
    }
  })

  test("the wave of the folded children has no row, and the slot and what follows keep their numbers", async () => {
    const shell = await mountDag({ server: composeServer() })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(lineWith(frame, "scope")).toContain("第 1 波")
      expect(lineWith(frame, "review--split")).toContain("第 2 波")
      expect(lineWith(frame, "review ")).toContain("第 4 波")
      expect(lineWith(frame, "ship")).toContain("第 5 波")
      expect(frame).not.toContain("第 3 波")
    } finally {
      await shell.dispose()
    }
  })

  test("it starts on the slot when what needs a look is a child folded under it", async () => {
    const shell = await mountDag({ server: composeServer() })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(lineWith(frame, "›")).toContain("review")
      expect(lineWith(frame, "›")).toContain("▸")
      expect(
        shell
          .sync()
          .dag.nodes(WF)
          ?.find((node) => node.id === "review--core")?.status,
      ).toBe("failed")
    } finally {
      await shell.dispose()
    }
  })

  test("space unfolds the slot: its children are ordinary rows one step in, each with its own state", async () => {
    const shell = await mountDag({ server: composeServer() })
    try {
      await openLoaded(shell)
      await press(shell, " ")
      const frame = await shell.frame()
      const slot = lineWith(frame, "review ")
      expect(slot).toContain("▾")
      expect(lineWith(frame, "review--api")).toContain("✓")
      expect(lineWith(frame, "review--api")).toContain("1m 20s")
      expect(lineWith(frame, "review--core")).toContain("✗")
      expect(lineWith(frame, "review--core")).toContain("3m 0s")
      expect(lineWith(frame, "review--docs")).toContain("●")
      expect(lineWith(frame, "review--docs")).toContain("9m 40s")
      // Between the slot (and the note of the selected row) and what follows it, in wave order, and one step further
      // in than the slot's own name.
      const rows = rowsOf(frame)
      const at = (name: string) => rows.findIndex((line) => line.includes(name))
      expect(at("review ")).toBeGreaterThan(at("review--split"))
      expect(at("review--api")).toBeGreaterThan(at("review "))
      expect(at("review--core")).toBe(at("review--api") + 1)
      expect(at("review--docs")).toBe(at("review--core") + 1)
      expect(at("ship")).toBe(at("review--docs") + 1)
      for (const name of ["review--api", "review--core", "review--docs"]) {
        expect(columnOf(lineWith(frame, name), name)).toBe(columnOf(slot, "review") + 2)
      }
      // They sit in no wave of the list: neither a number nor a bar.
      for (const name of ["review--api", "review--core", "review--docs"]) {
        const line = lineWith(frame, name) ?? ""
        expect(line).not.toContain("第")
        expect(line.slice(1, -1)).not.toContain("│")
      }
      expect(lineWith(frame, "ship")).toContain("第 5 波")
      // The slot stays the selected row.
      expect(lineWith(frame, "›")).toContain("review ")
    } finally {
      await shell.dispose()
    }
  })

  test("space again folds it, and the selection stays on the slot", async () => {
    const shell = await mountDag({ server: composeServer() })
    try {
      await openLoaded(shell)
      const folded = await shell.frame()
      await press(shell, " ")
      await press(shell, " ")
      const frame = await shell.frame()
      expect(frame).toBe(folded)
      expect(frame).not.toContain("review--api")
    } finally {
      await shell.dispose()
    }
  })

  test("a child can be selected like any node, and says what went wrong", async () => {
    const shell = await mountDag({ server: composeServer() })
    try {
      await openLoaded(shell)
      await press(shell, " ")
      await press(shell, "down")
      expect(lineWith(await shell.frame(), "›")).toContain("review--api")
      await press(shell, "down")
      const frame = await shell.frame()
      expect(lineWith(frame, "›")).toContain("review--core")
      expect(frame).toContain("审查超时")
    } finally {
      await shell.dispose()
    }
  })

  test("a pushed change reaches a child while it is folded, and a new child counts", async () => {
    const shell = await mountDag({ server: composeServer() })
    try {
      await openLoaded(shell)
      shell.events.emit(
        nodesPush({
          seq: 1,
          nodes: [
            wire("review--docs", "completed", {
              depends_on: ["review--split"],
              expanded_from: "review",
              started_at: NOW - 580_000,
              completed_at: NOW - 200_000,
            }),
            wire("review--perf", "running", {
              depends_on: ["review--split"],
              expanded_from: "review",
              started_at: NOW - 580_000,
            }),
            wire("review", "pending", {
              depends_on: ["review--api", "review--core", "review--docs", "review--perf"],
            }),
          ],
        }),
      )
      await waitFor(() => shell.sync().dag.nodes(WF)?.length === 8)
      await shell.settle()
      expect(await shell.frame()).toContain("（4 个子节点）")
      await press(shell, " ")
      const frame = await shell.frame()
      expect(lineWith(frame, "review--docs")).toContain("✓")
      expect(lineWith(frame, "review--perf")).toContain("●")
    } finally {
      await shell.dispose()
    }
  })

  test("a slot inside a slot starts folded, with its own count, and opens in turn", async () => {
    const shell = await mountDag({ server: composeServer({ [WF]: composedNested() }), height: 40 })
    try {
      await openLoaded(shell)
      let frame = await shell.frame()
      expect(lineWith(frame, "review ")).toContain("（3 个子节点）")
      for (const child of ["review--api", "review--docs", "review--docs--intro"]) expect(frame).not.toContain(child)

      await press(shell, " ")
      frame = await shell.frame()
      const nested = lineWith(frame, "review--docs ")
      expect(nested).toContain("▸")
      expect(nested).toContain("（2 个子节点）")
      expect(frame).not.toContain("review--docs--intro")
      // The nested split node, which the outer slot generated, is one of its plain children.
      expect(lineWith(frame, "review--docs--split")).toContain("✓")
      expect(columnOf(nested, "review--docs")).toBe(columnOf(lineWith(frame, "review "), "review") + 2)

      // Down to the nested slot (the children come in wave order: api, the nested split, the nested slot).
      for (let step = 0; step < 3; step++) await press(shell, "down")
      expect(lineWith(await shell.frame(), "›")).toContain("review--docs ")
      await press(shell, " ")
      frame = await shell.frame()
      expect(lineWith(frame, "review--docs ")).toContain("▾")
      expect(lineWith(frame, "review--docs--intro")).toContain("✓")
      expect(lineWith(frame, "review--docs--refs")).toContain("●")
      expect(columnOf(lineWith(frame, "review--docs--intro"), "review--docs--intro")).toBe(
        columnOf(lineWith(frame, "review--docs "), "review--docs") + 2,
      )
    } finally {
      await shell.dispose()
    }
  })

  test("folding the outer slot takes everything under it away and keeps what was opened inside", async () => {
    const shell = await mountDag({ server: composeServer({ [WF]: composedNested() }), height: 40 })
    try {
      await openLoaded(shell)
      await press(shell, " ")
      for (let step = 0; step < 3; step++) await press(shell, "down")
      await press(shell, " ")
      expect(await shell.frame()).toContain("review--docs--intro")
      // Back up to the outer slot and fold it.
      for (let step = 0; step < 3; step++) await press(shell, "up")
      expect(lineWith(await shell.frame(), "›")).toContain("review ")
      await press(shell, " ")
      let frame = await shell.frame()
      for (const hidden of ["review--api", "review--docs", "review--docs--intro"]) expect(frame).not.toContain(hidden)
      // Opened again, the nested slot is open as it was left.
      await press(shell, " ")
      frame = await shell.frame()
      expect(lineWith(frame, "review--docs ")).toContain("▾")
      expect(frame).toContain("review--docs--refs")
    } finally {
      await shell.dispose()
    }
  })

  test("the fold is kept for each workflow on its own", async () => {
    const server = dagServer({
      summaries: {
        [ROOT]: [summaryOf(WF, "代码审查", "running"), summaryOf(WF2, "第二次审查", "completed")],
      },
      tables: { [WF]: composed(), [WF2]: composed(WF2) },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      await press(shell, " ")
      await press(shell, "down")
      let frame = await shell.frame()
      expect(lineWith(frame, "review--api")).toContain("✓")
      expect(lineWith(frame, "›")).toContain("review--api")

      // The other workflow has its own: its slot is folded.
      await press(shell, "right")
      await waitFor(() => shell.sync().dag.nodes(WF2) !== undefined, 10_000)
      await shell.settle()
      frame = await shell.frame()
      expect(frame).toContain("（3 个子节点）")
      expect(frame).not.toContain("review--api")

      await press(shell, "left")
      frame = await shell.frame()
      expect(lineWith(frame, "review ")).toContain("▾")
      expect(frame).toContain("review--api")
    } finally {
      await shell.dispose()
    }
  })

  test("enter on a slot goes where it always did: to its session, or to its details", async () => {
    const withSession = composed().map((node) =>
      node.id === "review" ? { ...node, child_session_id: NODE_SESSION } : node,
    )
    const shell = await mountDag({ server: composeServer({ [WF]: withSession }) })
    try {
      await openLoaded(shell)
      expect(lineWith(await shell.frame(), "›")).toContain("review ")
      expect(await shell.frame()).toContain("查看输出")
      await press(shell, "return")
      await waitFor(() => depth(shell) === 0)
      expect(JSON.parse(JSON.stringify(shell.route().data))).toEqual({ type: "session", sessionID: NODE_SESSION })
    } finally {
      await shell.dispose()
    }

    const second = await mountDag({ server: composeServer() })
    try {
      await openLoaded(second)
      await press(second, "return")
      const frame = await second.frame()
      expect(frame).toContain("输出：")
      // The details are open and the slot is still folded.
      expect(lineWith(frame, "review ")).toContain("▸")
      expect(frame).not.toContain("review--api")
    } finally {
      await second.dispose()
    }
  })

  test("o opens the details of the slot like those of any node, and the fold is left as it is", async () => {
    const shell = await mountDag({ server: composeServer() })
    try {
      await openLoaded(shell)
      await press(shell, "o")
      const frame = await shell.frame()
      expect(frame).toContain("输出：")
      expect(lineWith(frame, "review ")).toContain("▸")
    } finally {
      await shell.dispose()
    }
  })

  test("space on a node that is not a slot does nothing", async () => {
    const shell = await mountDag({ server: composeServer() })
    try {
      await openLoaded(shell)
      await press(shell, "up")
      expect(lineWith(await shell.frame(), "›")).toContain("review--split")
      const before = await shell.frame()
      await press(shell, " ")
      expect(await shell.frame()).toBe(before)
    } finally {
      await shell.dispose()
    }
  })

  test("a workflow without marks has no slot: no mark in front of a name, and space does nothing", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      const before = await shell.frame()
      expect(before).not.toMatch(/[▸▾]/)
      expect(before).not.toContain("space")
      await press(shell, " ")
      expect(await shell.frame()).toBe(before)
    } finally {
      await shell.dispose()
    }
  })

  test("a mark that names a node that is not there leaves the node where it was", async () => {
    const server = dagServer({
      summaries: { [ROOT]: [summaryOf(WF, "旧的展开", "running", { nodeCount: 3 })] },
      tables: {
        [WF]: [
          wire("first", "completed", { started_at: NOW - 60_000, completed_at: NOW - 30_000 }),
          wire("orphan", "running", { depends_on: ["first"], expanded_from: "slot-that-was-replaced" }),
          wire("last", "pending", { depends_on: ["orphan"], expanded_from: "last" }),
        ],
      },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      for (const name of ["first", "orphan", "last"]) expect(frame).toContain(name)
      expect(lineWith(frame, "orphan")).toContain("第 2 波")
      expect(lineWith(frame, "last")).toContain("第 3 波")
      expect(frame).not.toMatch(/[▸▾]/)
    } finally {
      await shell.dispose()
    }
  })

  test("the hint for the key is there while a slot is selected, and nowhere else, in each language", async () => {
    const shell = await mountDag({ server: composeServer(), width: 120, height: 40 })
    try {
      await openLoaded(shell)
      const hints = (frame: string) => rowsOf(frame).find((line) => /\besc\b/.test(line))
      expect(hints(await shell.frame())).toContain("空格 展开子节点")
      await press(shell, " ")
      expect(hints(await shell.frame())).toContain("空格 折叠子节点")
      await press(shell, "down")
      expect(hints(await shell.frame())).not.toContain("空格")
      await press(shell, "up")
      setLanguage("en")
      await shell.settle()
      expect(hints(await shell.frame())).toContain("space Fold")
      await press(shell, " ")
      expect(hints(await shell.frame())).toContain("space Unfold")
    } finally {
      await shell.dispose()
    }
  })

  test("on a slot row the fold key's hint comes before the other hints, and the close hint stays", async () => {
    // Where the room runs out, the details key's hint goes first and the request key's next.
    for (const width of [80, 100, 119, 120, 140]) {
      const shell = await mountDag({ server: composeServer(), width, height: 30 })
      try {
        await openLoaded(shell)
        const hints = rowsOf(await shell.frame()).find((line) => /\besc\b/.test(line)) ?? ""
        expect(hints).toContain("空格 展开子节点")
        expect(hints).toContain("esc 关闭")
        expect(hints).not.toContain("详情")
        expect(hints.includes("请主 agent 处理")).toBe(width >= 120)
        await press(shell, "up")
        const plain = rowsOf(await shell.frame()).find((line) => /\besc\b/.test(line)) ?? ""
        expect(plain).toContain("请主 agent 处理")
        // The details key's hint is gone: `enter` (view output) and `i` (ask) are the only ones now.
        expect(plain).not.toContain("详情")
        expect(plain).not.toContain("空格")
      } finally {
        await shell.dispose()
      }
    }
  })

  test("with a second workflow in the tabs the hint row still ends in the way out, in each language", async () => {
    const server = dagServer({
      summaries: { [ROOT]: [summaryOf(WF, "代码审查", "running"), summaryOf(WF2, "第二次审查", "completed")] },
      tables: { [WF]: composed(), [WF2]: [wire("docs", "completed", {}, WF2)] },
    })
    for (const language of ["zh-CN", "en"] as const) {
      for (const width of [100, 110, 120]) {
        const shell = await mountDag({ server, width, height: 30, language })
        try {
          await openLoaded(shell)
          const hints = rowsOf(await shell.frame()).find((line) => /\besc\b/.test(line)) ?? ""
          expect(hints).toContain(language === "en" ? "space Unfold" : "空格 展开子节点")
          expect(hints).toContain(language === "en" ? "esc Close" : "esc 关闭")
          expect(hints).not.toContain("…")
        } finally {
          await shell.dispose()
        }
      }
    }
  })

  test("the bar and the counts hold every node, folded or not", async () => {
    const shell = await mountDag({ server: composeServer() })
    try {
      await openLoaded(shell)
      const bar = (frame: string) => rowsOf(frame).find((line) => /^│ [━─╌ ]+│$/.test(line))
      const folded = await shell.frame()
      // Five cells to a node, seven nodes: the folded children are in it.
      expect(bar(folded)?.match(/[━─╌]/g)?.length).toBe(35)
      expect(folded).toContain("3/7 完成 · 第 3/5 波")
      await press(shell, " ")
      const open = await shell.frame()
      expect(bar(open)).toBe(bar(folded))
      expect(open).toContain("3/7 完成 · 第 3/5 波")
    } finally {
      await shell.dispose()
    }
  })

  test("the coverage block still names a failed child that is folded away", async () => {
    const server = dagServer({
      summaries: {
        [ROOT]: [summaryOf(WF, "代码审查", "running", { nodeCount: 7, failedNodes: 1, coverageCount: 1 })],
      },
      tables: { [WF]: composed() },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).toContain("review--core")
      expect(frame).toContain("审查超时")
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
      expect(await shell.frame()).toContain("查看输出")
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
      expect(await shell.frame()).toContain("查看输出")
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
      // The node table can be loaded before the panel has drawn it; on a slow runner read until it shows (#1397).
      let frame = await shell.frame()
      for (const start = Date.now(); !frame.includes("依赖升级验证") && Date.now() - start < 10_000;) {
        await Bun.sleep(20)
        frame = await shell.frame()
      }
      expect(frame).toContain("依赖升级验证")
    } finally {
      await shell.dispose()
    }
  })
})

describe("asking the main agent: one press fills in the input", () => {
  test("i prefills the selected node with its reason and closes every panel", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      // The failed node is the one the panel starts on; its reason comes with the request.
      await press(shell, "i")
      await waitFor(() => depth(shell) === 0)
      await shell.settle()
      expect(shell.promptDraft()).toBe(
        "请主 agent 处理工作流「依赖升级验证」(wf_alpha) 的节点「e2e」：ripgrep 下载超时（504）",
      )
      expect(await shell.frame()).toContain("请主 agent 处理工作流「依赖升级验证」(wf_alpha) 的节点「e2e」")
      expect(shell.writes()).toEqual([])
      expect(shell.app.renderer.currentFocusedRenderable?.constructor.name).toBe("TextareaRenderable")
    } finally {
      await shell.dispose()
    }
  })

  test("a running node carries its deadline as the reason", async () => {
    const shell = await mountDag()
    try {
      await openLoaded(shell)
      await press(shell, "down")
      await press(shell, "i")
      await waitFor(() => depth(shell) === 0)
      await shell.settle()
      expect(shell.promptDraft()).toBe(
        "请主 agent 处理工作流「依赖升级验证」(wf_alpha) 的节点「typecheck」：剩余 2m 5s",
      )
      expect(shell.writes()).toEqual([])
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
      await waitFor(() => depth(shell) === 0)
      await shell.settle()
      expect(
        shell.promptDraft()?.startsWith("look first\n请主 agent 处理工作流「依赖升级验证」(wf_alpha) 的节点「e2e」"),
      ).toBe(true)
      expect(shell.writes()).toEqual([])
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
      await waitFor(() => depth(shell) === 0)
      await waitFor(() => {
        const data = shell.route().data
        return data.type === "session" && data.sessionID === ROOT
      }, 10_000)
      await waitFor(() => (shell.promptDraft() ?? "").includes("e2e"), 10_000)
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
      await waitFor(() => depth(shell) === 0)
      await shell.settle()
      expect(shell.promptDraft()).toContain('handle node "e2e" in workflow "依赖升级验证" (wf_alpha)')
      expect(shell.writes()).toEqual([])
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
      for (const key of ["down", "down", "up", "o", "return", "o"]) await press(shell, key)
      shell.app.mockInput.pressEscape()
      await waitFor(() => depth(shell) === 1)
      await shell.settle()
      // Moving, opening details, and coming back: the list's own layers are the only ones.
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

describe("what folding costs", () => {
  test("folding and unfolding register no keymap layer: the key is the template's, bound when it mounted", async () => {
    const shell = await mountDag({ server: composeServer({ [WF]: composedNested() }), height: 40 })
    const counters = createCounters(shell.app.renderer, shell.keymap())
    try {
      await openLoaded(shell)
      const settled = counters.snapshot()
      // Open, walk onto a nested slot, open that, walk off and fold, in a row.
      for (const key of [" ", "down", "down", "down", " ", "up", "up", "up", " ", " ", "down", " "]) {
        await press(shell, key)
      }
      expect(counters.delta(settled).registerLayer).toBe(0)
    } finally {
      counters.dispose()
      await shell.dispose()
    }
  })

  test("it writes nothing into the message and part stores", async () => {
    const shell = await mountDag({ server: composeServer({ [WF]: composedNested() }), height: 40 })
    const probe = probeStoreWrites(shell.sync().data, ["message", "part"])
    try {
      await openLoaded(shell)
      for (const key of [" ", "down", "down", "down", " ", "o", "up", " "]) await press(shell, key)
      expect(probe.total()).toBe(0)
    } finally {
      probe.dispose()
      await shell.dispose()
    }
  })

  test("it asks the workflow for nothing: not a write, and not a read either", async () => {
    const server = composeServer({ [WF]: composedNested() })
    const shell = await mountDag({ server, height: 40 })
    try {
      await openLoaded(shell)
      // Every key a user presses is reported as activity (`attention`), which is not about the workflow.
      const dagRequests = () => shell.requested.filter((entry) => entry.includes("/dag"))
      const before = dagRequests()
      expect(before.length).toBeGreaterThan(0)
      for (const key of [" ", "down", "down", "down", " ", "up", "up", "up", " ", " ", " "]) await press(shell, key)
      expect(dagRequests()).toEqual(before)
      expect(shell.writes()).toEqual([])
      expect(server.reads).toEqual([WF])
    } finally {
      await shell.dispose()
    }
  })
})

describe("the panel is read-only", () => {
  test("a compose workflow's slots can be opened, walked into and asked about, and the server is only read from", async () => {
    const server = composeServer({ [WF]: composedNested() })
    const shell = await mountDag({ server, height: 40 })
    try {
      await openLoaded(shell)
      // Unfold, into a child, its details, back to the slot, fold; then the templates and one of them.
      for (const key of [" ", "down", "return", "o", "up", " "]) await press(shell, key)
      await press(shell, "i")
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

  test("after everything reachable has been done, the server was only read from", async () => {
    const server = dagServer({
      summaries: { [ROOT]: [summaryOf(WF, "依赖升级验证", "running"), summaryOf(WF2, "文档整理", "completed")] },
      tables: { [WF]: pipeline(), [WF2]: [wire("docs", "completed", {}, WF2)] },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      for (const key of ["down", "down", "up", " ", "return", "o", "return", "right", "left"]) await press(shell, key)
      await press(shell, "i")
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

  test("a sub-agent view folds and unfolds a slot without asking for anything either", async () => {
    const server = composeServer()
    // The workflow belongs to the root; the sub-agent view shows the root's.
    const shell = await mountDag({ sessionID: CHILD, server })
    try {
      await shell.registry().run("dag.open", { args: "", origin: "palette" })
      await waitFor(() => topID(shell) === "dag", 10_000)
      await waitFor(() => shell.sync().dag.nodes(WF) !== undefined, 10_000)
      await shell.settle()
      const dagRequests = () => shell.requested.filter((entry) => entry.includes("/dag"))
      const before = dagRequests()
      for (const key of [" ", " ", " "]) await press(shell, key)
      expect(await shell.frame()).toContain("review--api")
      expect(dagRequests()).toEqual(before)
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

  async function lookAtCompose(
    options: Parameters<typeof mountDag>[0],
    keys: string[] = [],
    tables: Record<string, DagNode[]> = { [WF]: composed() },
  ) {
    const shell = await mountDag({ server: composeServer(tables), ...options })
    try {
      await openLoaded(shell)
      for (const key of keys) await press(shell, key)
      return await shell.frame()
    } finally {
      await shell.dispose()
    }
  }

  test("a compose expansion folded, 80 by 24, in Chinese", async () => {
    expect(await lookAtCompose({ width: 80, height: 24 })).toMatchSnapshot()
  })

  test("a compose expansion folded, 120 by 40, in Chinese", async () => {
    expect(await lookAtCompose({ width: 120, height: 40 })).toMatchSnapshot()
  })

  test("a compose expansion folded, 80 by 24, in English", async () => {
    expect(await lookAtCompose({ width: 80, height: 24, language: "en" })).toMatchSnapshot()
  })

  test("a compose expansion unfolded, 80 by 24, in Chinese", async () => {
    expect(await lookAtCompose({ width: 80, height: 24 }, [" "])).toMatchSnapshot()
  })

  test("a compose expansion unfolded, 120 by 40, in English", async () => {
    expect(await lookAtCompose({ width: 120, height: 40, language: "en" }, [" "])).toMatchSnapshot()
  })

  test("a slot inside a slot, both unfolded, 120 by 40, in Chinese", async () => {
    const frame = await lookAtCompose({ width: 120, height: 40 }, [" ", "down", "down", "down", " "], {
      [WF]: composedNested(),
    })
    expect(frame).toMatchSnapshot()
  })

  for (const language of ["zh-CN", "en"] as const) {
    for (const ambiguousWidth of [1, 2] as const) {
      test(`a compose expansion is laid out no wider than 80 columns, folded and unfolded, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
        // Wide characters in the names, the marks and the counts: what the rows are laid out with must hold under both widths.
        const tables = {
          [WF]: composedNested().map((node) =>
            node.id.startsWith("review") ? { ...node, name: `审查任务 ${node.id.replace("review", "子")}` } : node,
          ),
        }
        for (const keys of [[], [" "], [" ", "down", "down", "down", " "]]) {
          const frame = await lookAtCompose({ width: 80, height: 24, language, ambiguousWidth }, keys, tables)
          const lines = rowsOf(frame).filter((line) => line.startsWith("│") && line.endsWith("│"))
          expect(lines.length).toBeGreaterThan(5)
          for (const line of lines) {
            const inner = line.slice(1, -1).trimEnd()
            expect({ keys, line, fits: cellWidth(inner, ambiguousWidth) <= 80 - 3 }).toEqual({
              keys,
              line,
              fits: true,
            })
          }
          // Every hint row ends in the way out.
          const hints = lines.find((line) => /\besc\b/.test(line)) ?? ""
          expect(/\besc\b/.test(hints) || hints.includes("…")).toBe(true)
        }
      })

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
    limits: {
      concurrency: 12,
      configuredConcurrency: null,
      maxTotalNodes: 100,
      configuredMaxTotalNodes: null,
      running,
    },
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

describe("the usage row", () => {
  /** What the server's summary carries once it itemises the attempts' usage (#1475). */
  const figures = {
    tokensInput: 1_200,
    tokensOutput: 340,
    tokensReasoning: 56,
    tokensCacheRead: 98_000,
    tokensCacheWrite: 7_800,
    cost: 0.0027,
    costUnknown: false,
  } satisfies Partial<DagWorkflowSummary>
  const ZH = "用量 输入 1.2K · 输出 340 · 推理 56 · 缓存 读 98K 写 7.8K · 费用 $0.0027"
  const EN = "Usage in 1.2K · out 340 · reasoning 56 · cache r 98K w 7.8K · cost $0.0027"
  /** A workflow with the review quality too, so the row can be placed between the counts and the quality. */
  const withUsage = (extra: Partial<DagWorkflowSummary> = {}, id = WF, title = "依赖升级验证") =>
    summaryOf(id, title, "running", { ...figures, quality: quality(), ...extra })

  test("sits between the counts and the review quality, and says the workflow's own figures", async () => {
    const server = dagServer({ summaries: { [ROOT]: [withUsage()] } })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      const lines = frameLines(await shell.frame())
      const counts = lines.findIndex((line) => line.includes("完成 · 第"))
      const usage = lines.findIndex((line) => line.includes(ZH))
      const review = lines.findIndex((line) => line.includes("审核 2 次"))
      expect(counts).toBeGreaterThan(-1)
      expect(usage).toBe(counts + 1)
      expect(review).toBe(usage + 1)
      // One row, in the muted color of the counts around it.
      expect(lines.filter((line) => line.includes("用量 输入"))).toHaveLength(1)
      expect(colorOf(await shell.spans(), ZH)?.equals(palette().textMuted)).toBe(true)
    } finally {
      await shell.dispose()
    }
  })

  test("is there without a review decision too, under the counts", async () => {
    const server = dagServer({ summaries: { [ROOT]: [withUsage({ quality: null })] } })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      const lines = frameLines(await shell.frame())
      expect(lines.findIndex((line) => line.includes(ZH))).toBe(
        lines.findIndex((line) => line.includes("完成 · 第")) + 1,
      )
    } finally {
      await shell.dispose()
    }
  })

  test("says an unpriced part as the drawer does", async () => {
    const server = dagServer({
      summaries: {
        [ROOT]: [withUsage({ costUnknown: true }), withUsage({ cost: 0, costUnknown: true }, WF2, "文档整理")],
      },
      tables: { [WF]: pipeline(), [WF2]: [wire("docs", "completed", {}, WF2)] },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain("缓存 读 98K 写 7.8K · 费用 $0.0027 + 未知")
      await press(shell, "right")
      await waitFor(() => shell.sync().dag.nodes(WF2) !== undefined)
      await shell.settle()
      const second = await shell.frame()
      expect(second).toContain("缓存 读 98K 写 7.8K · 费用 未知")
      expect(second).not.toContain("$0.00")
    } finally {
      await shell.dispose()
    }
  })

  test("is not drawn for a summary without the figures, and the rows around it stay", async () => {
    const server = dagServer({
      summaries: { [ROOT]: [summaryOf(WF, "依赖升级验证", "running", { quality: quality() })] },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      const frame = await shell.frame()
      expect(frame).not.toContain("用量")
      expect(frame).not.toContain("费用")
      expect(frame).toContain("审核 2 次 · 遗留 0 项 · 完整性 5/6")
    } finally {
      await shell.dispose()
    }
  })

  test("is not drawn while any one figure is missing, and follows a pushed summary in and out", async () => {
    const server = dagServer({ summaries: { [ROOT]: [withUsage()] } })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain(ZH)
      for (const field of [
        "tokensInput",
        "tokensOutput",
        "tokensReasoning",
        "tokensCacheRead",
        "tokensCacheWrite",
        "cost",
      ] as const) {
        shell.events.emit(summaryPush([withUsage({ [field]: undefined })]))
        await shell.settle()
        const frame = await shell.frame()
        expect({ field, drawn: frame.includes("用量 输入") }).toEqual({ field, drawn: false })
        expect(frame).toContain("审核 2 次")
        shell.events.emit(summaryPush([withUsage()]))
        await shell.settle()
        expect({ field, back: (await shell.frame()).includes(ZH) }).toEqual({ field, back: true })
      }
    } finally {
      await shell.dispose()
    }
  })

  test("belongs to the workflow on show: switching tabs changes it, and a pushed summary updates it", async () => {
    const second = { tokensInput: 5_000_000, tokensOutput: 20, tokensReasoning: 0, cost: 12.5 }
    const server = dagServer({
      summaries: { [ROOT]: [withUsage(), withUsage(second, WF2, "文档整理")] },
      tables: { [WF]: pipeline(), [WF2]: [wire("docs", "completed", {}, WF2)] },
    })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain(ZH)

      await press(shell, "right")
      await waitFor(() => shell.sync().dag.nodes(WF2) !== undefined)
      await shell.settle()
      const other = await shell.frame()
      expect(other).toContain("用量 输入 5M · 输出 20 · 推理 0 · 缓存 读 98K 写 7.8K · 费用 $12.50")
      expect(other).not.toContain(ZH)

      shell.events.emit(summaryPush([withUsage(), withUsage({ ...second, tokensOutput: 4_000 }, WF2, "文档整理")]))
      await shell.settle()
      expect(await shell.frame()).toContain("用量 输入 5M · 输出 4K · 推理 0 · 缓存 读 98K 写 7.8K · 费用 $12.50")
    } finally {
      await shell.dispose()
    }
  })

  test("says it in English", async () => {
    const server = dagServer({ summaries: { [ROOT]: [withUsage()] } })
    const shell = await mountDag({ server, language: "en" })
    try {
      await openLoaded(shell)
      const lines = frameLines(await shell.frame())
      const counts = lines.findIndex((line) => line.includes(" done · wave "))
      expect(counts).toBeGreaterThan(-1)
      expect(lines.findIndex((line) => line.includes(EN))).toBe(counts + 1)
      expect(lines.findIndex((line) => line.includes("reviews 2 · open 0"))).toBe(counts + 2)
    } finally {
      await shell.dispose()
    }
  })

  test("takes its figures from the summary: nothing is read for it, and nothing is written", async () => {
    const server = dagServer({ summaries: { [ROOT]: [withUsage()] } })
    const shell = await mountDag({ server })
    try {
      await openLoaded(shell)
      expect(await shell.frame()).toContain(ZH)
      expect(shell.requested.filter((entry) => entry.includes("/usage"))).toEqual([])
      expect(shell.writes()).toEqual([])
    } finally {
      await shell.dispose()
    }
  })

  describe("how it looks", () => {
    async function look(options: Parameters<typeof mountDag>[0]) {
      const server = dagServer({ summaries: { [ROOT]: [withUsage()] } })
      const shell = await mountDag({ server, ...options })
      try {
        await openLoaded(shell)
        return await shell.frame()
      } finally {
        await shell.dispose()
      }
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
  })

  for (const language of ["zh-CN", "en"] as const) {
    for (const ambiguousWidth of [1, 2] as const) {
      test(`is cut to the width of the panel on one row, never wider, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
        const lead = language === "en" ? "Usage in" : "用量 输入"
        for (const width of [60, 80]) {
          const server = dagServer({ summaries: { [ROOT]: [withUsage()] } })
          const shell = await mountDag({ server, width, height: 30, language, ambiguousWidth })
          try {
            await openLoaded(shell)
            const lines = rowsOf(await shell.frame()).filter((line) => line.startsWith("│") && line.endsWith("│"))
            const rows = lines.filter((line) => line.includes(lead))
            expect({ width, rows: rows.length }).toEqual({ width, rows: 1 })
            // Inside the border and the padding: what the panel itself laid out.
            const inner = rows[0].slice(1, -1).trimEnd()
            expect({ width, fits: cellWidth(inner, ambiguousWidth) <= width - 3 }).toEqual({ width, fits: true })
            // The 60-column panel cannot hold the whole row: it ends in the cut mark and the cost is gone.
            if (width === 60) {
              expect(inner.endsWith("…")).toBe(true)
              expect(inner).not.toContain(language === "en" ? "cost" : "费用")
            }
          } finally {
            await shell.dispose()
          }
        }
      })
    }
  }
})

// #1618: where the workflow's isolated worktree is and which branch it is on, one muted row under the counts. The
// server's summary says it (`worktree`): the live pointer as `active`, and once the workflow settled it the state it
// settled in. The row is read-only text: no key, no button, nothing asked of the server.
describe("the worktree row", () => {
  const PATH = "/repo/.agents/worktree/dag-8f3a1c-workflow"
  const BRANCH = "graphagent/dag-8f3a1c-workflow"
  const ZH = `工作目录 ${PATH} · 分支 ${BRANCH}`
  const EN = `Worktree ${PATH} · branch ${BRANCH}`
  const ZH_REMOVED = `分支 ${BRANCH} · 目录已清理`
  const EN_REMOVED = `branch ${BRANCH} · directory cleaned up`
  type Worktree = NonNullable<DagWorkflowSummary["worktree"]>
  const tree = (state: Worktree["state"], extra: Partial<Worktree> = {}): Worktree => ({
    directory: PATH,
    branch: BRANCH,
    state,
    ...extra,
  })
  const withTree = (
    worktree: Worktree | undefined,
    extra: Partial<DagWorkflowSummary> = {},
    id = WF,
    title = "依赖升级验证",
  ) => summaryOf(id, title, "running", { ...(worktree ? { worktree } : {}), ...extra })
  const figures = {
    tokensInput: 1_200,
    tokensOutput: 340,
    tokensReasoning: 56,
    tokensCacheRead: 98_000,
    tokensCacheWrite: 7_800,
    cost: 0.0027,
    costUnknown: false,
  } satisfies Partial<DagWorkflowSummary>

  async function frameOf(summary: DagWorkflowSummary, options: Parameters<typeof mountDag>[0] = {}) {
    const shell = await mountDag({ server: dagServer({ summaries: { [ROOT]: [summary] } }), ...options })
    try {
      await openLoaded(shell)
      return await shell.frame()
    } finally {
      await shell.dispose()
    }
  }

  test("a live pointer is active: the directory and the branch, under the counts, in the muted color", async () => {
    const server = dagServer({ summaries: { [ROOT]: [withTree(tree("active"))] } })
    const shell = await mountDag({ server, width: 120, height: 40 })
    try {
      await openLoaded(shell)
      const lines = frameLines(await shell.frame())
      const counts = lines.findIndex((line) => line.includes("完成 · 第"))
      expect(counts).toBeGreaterThan(-1)
      expect(lines.findIndex((line) => line.includes(ZH))).toBe(counts + 1)
      // One row, in the color of the counts above it, and not a word of it is a key to press.
      expect(lines.filter((line) => line.includes("工作目录"))).toHaveLength(1)
      expect(colorOf(await shell.spans(), ZH)?.equals(palette().textMuted)).toBe(true)
    } finally {
      await shell.dispose()
    }
  })

  test("a kept worktree reads like an active one: the directory is still there", async () => {
    const frame = await frameOf(withTree(tree("kept")), { width: 120, height: 40 })
    expect(frameLines(frame)).toContain(ZH)
    expect(frame).not.toContain("目录已清理")
  })

  test("a cleaned-up worktree names the branch and that the directory is gone, and not the directory", async () => {
    const frame = await frameOf(withTree(tree("removed")), { width: 120, height: 40 })
    const lines = frameLines(frame)
    expect(lines).toContain(ZH_REMOVED)
    expect(frame).not.toContain(PATH)
    expect(frame).not.toContain("工作目录")
  })

  test("without a branch the row is the directory alone, and a cleaned-up worktree has nothing to say", async () => {
    const bare = { ...tree("active"), branch: undefined }
    const active = await frameOf(withTree(bare), { width: 120, height: 40 })
    expect(frameLines(active)).toContain(`工作目录 ${PATH}`)
    expect(active).not.toContain("分支")
    // Kept is the same as active here; the cleaned-up one has no directory to name and no branch to name instead.
    expect(frameLines(await frameOf(withTree({ ...bare, state: "kept" }), { width: 120, height: 40 }))).toContain(
      `工作目录 ${PATH}`,
    )
    const removed = await frameOf(withTree({ ...bare, state: "removed" }), { width: 120, height: 40 })
    expect(removed).not.toContain("目录已清理")
    expect(removed).not.toContain("工作目录")
    expect(removed).not.toContain(PATH)
  })

  test("a workflow without the field draws no row, and the rows around it stay", async () => {
    const frame = await frameOf(withTree(undefined, { ...figures, quality: quality() }), { width: 120, height: 40 })
    expect(frame).not.toContain("工作目录")
    expect(frame).not.toContain("目录已清理")
    const lines = frameLines(frame)
    const counts = lines.findIndex((line) => line.includes("完成 · 第"))
    // No gap where the row would be: the usage row follows the counts directly.
    expect(lines[counts + 1]).toContain("用量 输入")
    expect(lines[counts + 2]).toContain("审核 2 次")
  })

  test("sits between the counts and the usage row", async () => {
    const frame = await frameOf(withTree(tree("active"), { ...figures, quality: quality() }), {
      width: 120,
      height: 40,
    })
    const lines = frameLines(frame)
    const counts = lines.findIndex((line) => line.includes("完成 · 第"))
    expect(lines[counts + 1]).toBe(ZH)
    expect(lines[counts + 2]).toContain("用量 输入")
    expect(lines[counts + 3]).toContain("审核 2 次")
  })

  test("says it in English, in each of the three shapes", async () => {
    const active = frameLines(await frameOf(withTree(tree("active")), { width: 120, height: 40, language: "en" }))
    const counts = active.findIndex((line) => line.includes(" done · wave "))
    expect(counts).toBeGreaterThan(-1)
    expect(active[counts + 1]).toBe(EN)
    expect(frameLines(await frameOf(withTree(tree("kept")), { width: 120, height: 40, language: "en" }))).toContain(EN)
    expect(
      frameLines(
        await frameOf(withTree({ ...tree("active"), branch: undefined }), { width: 120, height: 40, language: "en" }),
      ),
    ).toContain(`Worktree ${PATH}`)
    const removed = await frameOf(withTree(tree("removed")), { width: 120, height: 40, language: "en" })
    expect(frameLines(removed)).toContain(EN_REMOVED)
    expect(removed).not.toContain(PATH)
  })

  test("belongs to the workflow on show: switching tabs changes it, and a pushed summary moves it along", async () => {
    const other = { directory: "/repo/.agents/worktree/dag-2-workflow", branch: "graphagent/dag-2-workflow" }
    const server = dagServer({
      summaries: {
        [ROOT]: [withTree(tree("active")), withTree({ ...other, state: "kept" }, {}, WF2, "文档整理")],
      },
      tables: { [WF]: pipeline(), [WF2]: [wire("docs", "completed", {}, WF2)] },
    })
    const shell = await mountDag({ server, width: 120, height: 40 })
    try {
      await openLoaded(shell)
      expect(frameLines(await shell.frame())).toContain(ZH)

      await press(shell, "right")
      await waitFor(() => shell.sync().dag.nodes(WF2) !== undefined)
      await shell.settle()
      const second = frameLines(await shell.frame())
      expect(second).toContain(`工作目录 ${other.directory} · 分支 ${other.branch}`)
      expect(second).not.toContain(ZH)

      // The terminal event came with the pointer; the settlement then says the directory is gone, and a push for the
      // other workflow does not touch this one.
      await press(shell, "left")
      await shell.settle()
      shell.events.emit(
        summaryPush([withTree(tree("removed")), withTree({ ...other, state: "kept" }, {}, WF2, "文档整理")]),
      )
      await shell.settle()
      const settled = frameLines(await shell.frame())
      expect(settled).toContain(ZH_REMOVED)
      expect(settled).not.toContain(ZH)

      // And a summary without the field, as an older server would send, takes the row away again.
      shell.events.emit(summaryPush([withTree(undefined), withTree({ ...other, state: "kept" }, {}, WF2, "文档整理")]))
      await shell.settle()
      const gone = await shell.frame()
      expect(gone).not.toContain("目录已清理")
      expect(gone).not.toContain("工作目录")
    } finally {
      await shell.dispose()
    }
  })

  test("a path and a branch from the server have no escapes or line breaks in them", async () => {
    const frame = await frameOf(
      withTree({
        directory: `/wt/\u001b[31mred\u001b[0m\n/inner`,
        branch: "feat/\u001b]0;title\u0007x\ny",
        state: "active",
      }),
      { width: 120, height: 40 },
    )
    expect(frame).not.toContain("\u001b")
    expect(frame).not.toContain("\u0007")
    expect(frameLines(frame)).toContain("工作目录 /wt/red /inner · 分支 feat/x y")
  })

  test("takes everything from the summary: nothing is read for it, and nothing is written", async () => {
    const server = dagServer({ summaries: { [ROOT]: [withTree(tree("active"))] } })
    const shell = await mountDag({ server, width: 120, height: 40 })
    const probe = probeStoreWrites(shell.sync().data, ["message", "part"])
    try {
      await openLoaded(shell)
      expect(frameLines(await shell.frame())).toContain(ZH)
      // Every key the panel has, and a pushed settlement: the row never asks the server for anything.
      for (const key of ["down", "o", "return", "up", "i"]) await press(shell, key)
      shell.events.emit(summaryPush([withTree(tree("removed"))]))
      await shell.settle()
      expect(shell.writes()).toEqual([])
      // Whatever the DAG routes were asked, it was only read from, and nothing was asked about the worktree.
      const dag = shell.requested.filter((entry) => entry.includes("/dag"))
      expect(dag.length).toBeGreaterThan(0)
      expect(dag.filter((entry) => !entry.startsWith("GET "))).toEqual([])
      expect(shell.requested.filter((entry) => entry.includes("worktree"))).toEqual([])
      expect(probe.total()).toBe(0)
    } finally {
      probe.dispose()
      await shell.dispose()
    }
  })

  // The row is text laid out from the summary: it listens to no clock and asks for no repaint, so the panel costs what
  // it cost without it, and an idle screen with a finished workflow on it draws nothing at all.
  test("adds no clock subscription and no repaint: a finished workflow with the row on screen stays still", async () => {
    const done = { runningNodes: 0, failedNodes: 0, completedNodes: 5 }
    const tables = {
      [WF]: [
        wire("a", "completed", { started_at: NOW - 100_000, completed_at: NOW - 70_000 }),
        wire("b", "completed", { depends_on: ["a"], started_at: NOW - 70_000, completed_at: NOW - 40_000 }),
      ],
    }
    const server = dagServer({
      summaries: { [ROOT]: [summaryOf(WF, "已结束", "completed", { ...done, worktree: tree("removed") })] },
      tables,
    })
    const shell = await mountDag({ server, width: 120, height: 40 })
    const counters = createCounters(shell.app.renderer, shell.keymap())
    try {
      await openLoaded(shell)
      expect(frameLines(await shell.frame())).toContain(ZH_REMOVED)
      expect(shell.clock.seconds()).toBe(0)
      expect(shell.clock.frames()).toBe(0)
      await shell.app.renderOnce()
      const before = counters.snapshot()
      shell.clock.advance(2_000)
      await shell.app.renderOnce()
      expect(counters.delta(before).renderRequests).toBe(0)
      expect(shell.clock.seconds()).toBe(0)
      expect(shell.clock.frames()).toBe(0)
    } finally {
      counters.dispose()
      await shell.dispose()
    }

    // A running workflow listens to the one-second clock for its elapsed time, with the row or without it, once.
    for (const worktree of [undefined, tree("active")]) {
      const running = await mountDag({
        server: dagServer({ summaries: { [ROOT]: [withTree(worktree)] } }),
        width: 120,
        height: 40,
      })
      try {
        await openLoaded(running)
        expect({
          drawn: worktree !== undefined,
          seconds: running.clock.seconds(),
          frames: running.clock.frames(),
        }).toEqual({
          drawn: worktree !== undefined,
          seconds: 1,
          frames: 0,
        })
      } finally {
        await running.dispose()
      }
    }
  })

  describe("how it looks", () => {
    test("active, 80 by 24, in Chinese", async () => {
      expect(await frameOf(withTree(tree("active")), { width: 80, height: 24 })).toMatchSnapshot()
    })

    test("active, 120 by 40, in Chinese", async () => {
      expect(await frameOf(withTree(tree("active")), { width: 120, height: 40 })).toMatchSnapshot()
    })

    test("active, 80 by 24, in English", async () => {
      expect(await frameOf(withTree(tree("active")), { width: 80, height: 24, language: "en" })).toMatchSnapshot()
    })

    test("kept, 120 by 40, in English", async () => {
      expect(await frameOf(withTree(tree("kept")), { width: 120, height: 40, language: "en" })).toMatchSnapshot()
    })

    test("cleaned up, 80 by 24, in Chinese", async () => {
      expect(await frameOf(withTree(tree("removed")), { width: 80, height: 24 })).toMatchSnapshot()
    })

    test("cleaned up, 120 by 40, in English", async () => {
      expect(await frameOf(withTree(tree("removed")), { width: 120, height: 40, language: "en" })).toMatchSnapshot()
    })
  })

  for (const language of ["zh-CN", "en"] as const) {
    for (const ambiguousWidth of [1, 2] as const) {
      test(`is one row, cut from the left of the path and never wider, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
        const lead = language === "en" ? "Worktree" : "工作目录"
        const branchLead = language === "en" ? " · branch " : " · 分支 "
        // A long path and a branch that has to stay whole, from the narrowest the panel is drawn to one with room for it all.
        const directory = "/work/some-project/.agents/worktree/dag-8f3a1c9d-workflow"
        for (const width of [60, 80, 100, 140]) {
          const frame = await frameOf(withTree({ directory, branch: BRANCH, state: "active" }), {
            width,
            height: 30,
            language,
            ambiguousWidth,
          })
          const lines = rowsOf(frame).filter((line) => line.startsWith("│") && line.endsWith("│"))
          const rows = lines.filter((line) => line.includes(lead))
          expect({ width, rows: rows.length }).toEqual({ width, rows: 1 })
          // Inside the border and the padding: what the panel itself laid out.
          const inner = rows[0].slice(1, -1).trimEnd()
          expect({ width, fits: cellWidth(inner, ambiguousWidth) <= width - 3 }).toEqual({ width, fits: true })
          // The branch is whole at every width; the path gave way from the left when it did not all fit.
          expect({ width, branch: inner.endsWith(`${branchLead}${BRANCH}`) }).toEqual({ width, branch: true })
          const shown = inner.slice(
            inner.indexOf(lead) + lead.length + 1,
            inner.length - `${branchLead}${BRANCH}`.length,
          )
          if (width < 140) {
            expect({ width, cut: shown.startsWith("…") }).toEqual({ width, cut: true })
            expect({ width, tail: directory.endsWith(shown.slice(1)) }).toEqual({ width, tail: true })
          } else {
            expect({ width, whole: shown }).toEqual({ width, whole: directory })
          }
        }
      })

      test(`a cleaned-up worktree and a line that cannot hold its branch are cut to the width too, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
        const long = `graphagent/${"very-long-branch-name-".repeat(6)}end`
        for (const state of ["removed", "active"] as const) {
          for (const width of [60, 80]) {
            const frame = await frameOf(withTree({ directory: PATH, branch: long, state }), {
              width,
              height: 30,
              language,
              ambiguousWidth,
            })
            const lines = rowsOf(frame).filter((line) => line.startsWith("│") && line.endsWith("│"))
            const rows = lines.filter((line) => line.includes("very-long-branch"))
            expect({ state, width, rows: rows.length }).toEqual({ state, width, rows: 1 })
            const inner = rows[0].slice(1, -1).trimEnd()
            expect({ state, width, fits: cellWidth(inner, ambiguousWidth) <= width - 3 }).toEqual({
              state,
              width,
              fits: true,
            })
            // No room even for the whole branch: the end of the line is what goes.
            expect({ state, width, cut: inner.endsWith("…") }).toEqual({ state, width, cut: true })
          }
        }
      })
    }
  }
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
