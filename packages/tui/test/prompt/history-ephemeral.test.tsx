// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import path from "path"
import { MAX_HISTORY_ENTRIES, PromptHistoryProvider, usePromptHistory } from "../../src/prompt/history"
import { readText } from "../../src/util/persistence"
import { TestTuiContexts } from "../fixture/tui-environment"
import { tmpdir } from "../fixture/fixture"

type History = ReturnType<typeof usePromptHistory>

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 2000) {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function Probe(props: { ready: (history: History) => void }) {
  props.ready(usePromptHistory())
  return <box />
}

async function mountHistory() {
  const tmp = await tmpdir()
  let history!: History
  const app = await testRender(
    () => (
      <TestTuiContexts cwd={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <PromptHistoryProvider>
          <Probe ready={(value) => (history = value)} />
        </PromptHistoryProvider>
      </TestTuiContexts>
    ),
    { width: 20, height: 5 },
  )
  await waitFor(() => Boolean(history))
  const file = path.join(tmp.path, "prompt-history.jsonl")
  return {
    app,
    history,
    file,
    async dispose() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("ephemeral entries are recallable but never written to prompt-history.jsonl", async () => {
  const fixture = await mountHistory()
  try {
    fixture.history.append({ input: "alpha", parts: [] })
    await waitFor(async () => (await readText(fixture.file).catch(() => "")).includes("alpha"))

    fixture.history.appendEphemeral({ input: "/btw sensitive question", parts: [] })
    await Bun.sleep(30)
    const text = await readText(fixture.file).catch(() => "")
    expect(text).not.toContain("/btw")
    expect(text).not.toContain("sensitive question")
    expect(text.trim().split("\n")).toHaveLength(1)

    // Arrow-key recall walks the same in-memory list.
    const recalled = fixture.history.move(-1, "")
    expect(recalled?.input).toBe("/btw sensitive question")
  } finally {
    await fixture.dispose()
  }
})

test("an overflow rewrite only persists ordinary entries", async () => {
  const tmp = await tmpdir()
  let history!: History
  const file = path.join(tmp.path, "prompt-history.jsonl")
  const lines = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, index) =>
    JSON.stringify({ input: `q${index}`, parts: [] }),
  )
  await Bun.write(file, lines.join("\n") + "\n")

  const app = await testRender(
    () => (
      <TestTuiContexts cwd={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <PromptHistoryProvider>
          <Probe ready={(value) => (history = value)} />
        </PromptHistoryProvider>
      </TestTuiContexts>
    ),
    { width: 20, height: 5 },
  )
  try {
    await waitFor(() => history.move(-1, "")?.input === `q${MAX_HISTORY_ENTRIES - 1}`)

    history.appendEphemeral({ input: "/btw hidden", parts: [] })
    await waitFor(async () => {
      const text = await readText(file).catch(() => "")
      return text.trim().split("\n").length === MAX_HISTORY_ENTRIES - 1
    })
    const afterEphemeral = await readText(file)
    expect(afterEphemeral).not.toContain("/btw")
    expect(JSON.parse(`[${afterEphemeral.trim().split("\n").join(",")}]`)).toHaveLength(MAX_HISTORY_ENTRIES - 1)

    history.append({ input: "ordinary", parts: [] })
    await waitFor(async () => {
      const text = await readText(file).catch(() => "")
      return text.includes("ordinary")
    })
    const afterOrdinary = await readText(file)
    const persisted = afterOrdinary.trim().split("\n")
    // The memory list caps at 50 including the ephemeral entry, so the rewrite
    // filters that entry out instead of growing the file.
    expect(persisted).toHaveLength(MAX_HISTORY_ENTRIES - 1)
    expect(afterOrdinary).not.toContain("/btw")
    expect(afterOrdinary).not.toContain("q0")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})
