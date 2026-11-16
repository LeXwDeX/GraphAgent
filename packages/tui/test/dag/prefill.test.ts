// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { setLanguage } from "../../src/i18n"
import { dagRequestKinds, dagRequestLabel, dagRequestText, type DagRequestKind } from "../../src/dag/prefill"
import type { DagWorkflowSummary } from "../../src/dag/model"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

function workflow(status: string, extra: Partial<DagWorkflowSummary> = {}): DagWorkflowSummary {
  return {
    id: "wf-1",
    title: "依赖升级验证",
    status,
    graphRev: 1,
    nodeCount: 4,
    completedNodes: 1,
    runningNodes: 1,
    failedNodes: 0,
    skippedNodes: 0,
    abortedNodes: 0,
    queuedNodes: 2,
    escalatedNodes: 0,
    ...extra,
  }
}

const node = (status: string, error_class?: string) => ({
  id: "n-1",
  name: "e2e-windows",
  status,
  ...(error_class ? { error_class } : {}),
})

const ALL: readonly DagRequestKind[] = [
  "inspect",
  "pause",
  "resume",
  "cancel",
  "retry",
  "cancel-node",
  "extend-timeout",
  "relay",
  "coverage",
  "audit",
  "narrow",
  "cancel-all",
]

describe("dagRequestKinds: which templates a display state offers", () => {
  test("a running workflow can be checked, paused, cancelled, audited and narrowed", () => {
    expect(dagRequestKinds({ workflow: workflow("running") })).toEqual([
      "inspect",
      "pause",
      "cancel",
      "audit",
      "narrow",
      "cancel-all",
    ])
  })

  test("a stepping workflow is still running work: it can be paused and cancelled", () => {
    expect(dagRequestKinds({ workflow: workflow("stepping") })).toEqual([
      "inspect",
      "pause",
      "cancel",
      "audit",
      "narrow",
      "cancel-all",
    ])
  })

  test("only a paused workflow can be resumed, and a paused one does not count as running", () => {
    expect(dagRequestKinds({ workflow: workflow("paused") })).toEqual([
      "inspect",
      "resume",
      "cancel",
      "audit",
      "narrow",
    ])
  })

  test("a finished workflow offers the checks and nothing that acts on running work", () => {
    for (const status of ["completed", "failed", "cancelled", "pending"]) {
      expect(dagRequestKinds({ workflow: workflow(status) })).toEqual(["inspect", "audit", "narrow"])
    }
  })

  test("coverage is offered only when the workflow reports a coverage count", () => {
    expect(dagRequestKinds({ workflow: workflow("completed", { coverageCount: 3 }) })).toContain("coverage")
    expect(dagRequestKinds({ workflow: workflow("completed", { coverageCount: 0 }) })).not.toContain("coverage")
    expect(dagRequestKinds({ workflow: workflow("completed") })).not.toContain("coverage")
  })

  test("cancel-all looks at the whole session tree, not only the shown workflow", () => {
    const shown = workflow("completed")
    const other = workflow("running", { id: "wf-2" })
    expect(dagRequestKinds({ workflow: shown, workflows: [shown, other] })).toContain("cancel-all")
    expect(dagRequestKinds({ workflow: shown, workflows: [shown, workflow("failed", { id: "wf-3" })] })).not.toContain(
      "cancel-all",
    )
    expect(dagRequestKinds({ workflow: shown, workflows: [] })).not.toContain("cancel-all")
  })

  test("a failed node can be retried, but not cancelled, extended or told something", () => {
    const kinds = dagRequestKinds({ workflow: workflow("running"), node: node("failed") })
    expect(kinds).toContain("retry")
    expect(kinds).not.toContain("cancel-node")
    expect(kinds).not.toContain("extend-timeout")
    expect(kinds).not.toContain("relay")
  })

  test("a node that was cancelled shows as cancelled, so it is not offered a retry", () => {
    const kinds = dagRequestKinds({ workflow: workflow("running"), node: node("failed", "cancelled") })
    expect(kinds).not.toContain("retry")
  })

  test("a running node can be cancelled, given more time, or told something", () => {
    const kinds = dagRequestKinds({ workflow: workflow("running"), node: node("running") })
    expect(kinds).toEqual([
      "inspect",
      "pause",
      "cancel",
      "cancel-node",
      "extend-timeout",
      "relay",
      "audit",
      "narrow",
      "cancel-all",
    ])
  })

  test("a node that has not started can be cancelled but there is no agent to tell and no timeout to extend", () => {
    for (const status of ["pending", "queued"]) {
      const kinds = dagRequestKinds({ workflow: workflow("running"), node: node(status) })
      expect(kinds).toContain("cancel-node")
      expect(kinds).not.toContain("extend-timeout")
      expect(kinds).not.toContain("relay")
      expect(kinds).not.toContain("retry")
    }
  })

  test("a node that has finished offers no node-level template", () => {
    for (const status of ["completed", "skipped", "aborted"]) {
      const kinds = dagRequestKinds({ workflow: workflow("running"), node: node(status) })
      expect(kinds.filter((kind) => ["retry", "cancel-node", "extend-timeout", "relay"].includes(kind))).toEqual([])
    }
  })

  test("node-level templates need a node", () => {
    const kinds = dagRequestKinds({ workflow: workflow("running") })
    expect(kinds.filter((kind) => ["retry", "cancel-node", "extend-timeout", "relay"].includes(kind))).toEqual([])
  })

  test("the order is fixed whatever the state", () => {
    const kinds = dagRequestKinds({
      workflow: workflow("paused", { coverageCount: 2 }),
      node: node("failed"),
      workflows: [workflow("running", { id: "wf-2" })],
    })
    expect(kinds).toEqual(ALL.filter((kind) => kinds.includes(kind)))
  })
})

describe("dagRequestText: what lands in the input", () => {
  test("the zh-CN texts name the workflow and the node", () => {
    const ctx = { workflow: workflow("running"), node: node("failed") }
    expect(dagRequestText("inspect", ctx)).toBe(
      "请检查工作流「依赖升级验证」(wf-1) 的当前状态并汇报进展，有失败的节点请说明原因。",
    )
    expect(dagRequestText("pause", ctx)).toBe("请暂停工作流「依赖升级验证」(wf-1)。")
    expect(dagRequestText("resume", ctx)).toBe("请恢复工作流「依赖升级验证」(wf-1)。")
    expect(dagRequestText("cancel", ctx)).toBe("请取消工作流「依赖升级验证」(wf-1)，并汇报已完成的部分和缺口。")
    expect(dagRequestText("retry", ctx)).toBe("请重试节点 e2e-windows（工作流 wf-1）。")
    expect(dagRequestText("cancel-node", ctx)).toBe("请取消节点 e2e-windows（工作流 wf-1）。")
    expect(dagRequestText("extend-timeout", ctx)).toBe("请延长节点 e2e-windows（工作流 wf-1）的超时时间。")
  })

  test("the four DAG-mode templates read as the design gives them", () => {
    const ctx = { workflow: workflow("running", { coverageCount: 2 }) }
    expect(dagRequestText("coverage", ctx)).toBe("请检查工作流「依赖升级验证」(wf-1) 的覆盖范围并补齐未覆盖项。")
    expect(dagRequestText("audit", ctx)).toBe("请为当前改动再加一轮对抗审核。")
    expect(dagRequestText("narrow", ctx)).toBe("请缩小工作流「依赖升级验证」的范围，只保留：")
    expect(dagRequestText("cancel-all", ctx)).toBe("请取消所有运行中的工作流，并汇报目前的结果与缺口。")
  })

  test("relay and narrow stop where the user goes on writing", () => {
    const ctx = { workflow: workflow("running"), node: node("running") }
    expect(dagRequestText("relay", ctx)).toBe("请向节点 e2e-windows（工作流 wf-1）的 agent 转达：")
    for (const kind of ["relay", "narrow"] as const) {
      const text = dagRequestText(kind, ctx)
      expect(text.endsWith("：")).toBe(true)
      expect(text.includes("\n")).toBe(false)
    }
  })

  test("the English texts", () => {
    setLanguage("en")
    const ctx = { workflow: workflow("running", { title: "Dependency upgrade" }), node: node("failed") }
    expect(dagRequestText("inspect", ctx)).toBe(
      'Please check the current state of workflow "Dependency upgrade" (wf-1) and report progress; if any node failed, tell me why.',
    )
    expect(dagRequestText("retry", ctx)).toBe("Please retry node e2e-windows (workflow wf-1).")
    expect(dagRequestText("relay", ctx)).toBe("Please relay this to the agent of node e2e-windows (workflow wf-1):")
    expect(dagRequestText("narrow", ctx)).toBe('Please narrow the scope of workflow "Dependency upgrade" to only:')
    expect(dagRequestText("cancel-all", ctx)).toBe(
      "Please cancel every running workflow and report the results so far and what is missing.",
    )
  })

  test("every kind has a text and a label in both languages, with no placeholder left open", () => {
    const ctx = { workflow: workflow("running", { coverageCount: 1 }), node: node("running") }
    for (const language of ["zh-CN", "en"] as const) {
      setLanguage(language)
      for (const kind of ALL) {
        const text = dagRequestText(kind, ctx)
        const label = dagRequestLabel(kind, ctx)
        expect({ language, kind, text: text.trim().length > 0 }).toEqual({ language, kind, text: true })
        expect({ language, kind, label: label.trim().length > 0 }).toEqual({ language, kind, label: true })
        expect(text).not.toMatch(/\{\w+\}/)
        expect(label).not.toMatch(/\{\w+\}/)
      }
    }
  })

  test("the labels name the node where the template acts on one", () => {
    const ctx = { workflow: workflow("running"), node: node("failed") }
    expect(dagRequestLabel("retry", ctx)).toBe("重试节点 e2e-windows")
    expect(dagRequestLabel("inspect", ctx)).toBe("检查当前状态")
    setLanguage("en")
    expect(dagRequestLabel("retry", ctx)).toBe("Retry node e2e-windows")
  })

  test("the language is read when the text is made, so a switch changes the next one", () => {
    const ctx = { workflow: workflow("running") }
    const zh = dagRequestText("audit", ctx)
    setLanguage("en")
    expect(dagRequestText("audit", ctx)).not.toBe(zh)
  })

  test("a template that needs a node and has none comes back empty instead of naming nobody", () => {
    const ctx = { workflow: workflow("running") }
    for (const kind of ["retry", "cancel-node", "extend-timeout", "relay"] as const) {
      expect(dagRequestText(kind, ctx)).toBe("")
    }
  })

  test("remote names are cleaned of escapes and line breaks before they reach the draft", () => {
    const ctx = {
      workflow: workflow("running", { title: "升级\u001b[31m红\u001b[0m\n第二行" }),
      node: { ...node("failed"), name: "bad\u0007name\r\nnext" },
    }
    for (const kind of ["inspect", "narrow", "retry", "relay"] as const) {
      const text = dagRequestText(kind, ctx)
      expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    }
    expect(dagRequestText("narrow", ctx)).toBe("请缩小工作流「升级红 第二行」的范围，只保留：")
    expect(dagRequestText("retry", ctx)).toBe("请重试节点 badname next（工作流 wf-1）。")
  })
})
