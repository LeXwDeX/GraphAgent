/** @jsxImportSource @opentui/solid */
// Run from packages/tui: bun test/cli/cmd/tui/reasoning-render.bench.tsx
// Measures signal update through a visible frame in OpenTUI's 100x30 test renderer.
import { performance } from "node:perf_hooks"
import { RGBA, SyntaxStyle, type ScrollBoxRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { ReasoningMarkdown } from "../../../../src/routes/session"

const fg = RGBA.fromHex("#888888")
const sample = (sections: number, alternate = false) =>
  Array.from({ length: sections }, (_, index) =>
    alternate
      ? `### Task ${index + 1}\n\nAudit \`src/task-${index + 1}.ts\` and keep the answer in context.\n`
      : `### Step ${index + 1}\n\nCheck \`src/step-${index + 1}.ts\` and keep the result in context.\n`,
  ).join("\n")

type Case = {
  renderer: "code" | "code-unstyled" | "markdown" | "markdown-raw" | "text"
  sections: number
  parts: number
  mode: "tail" | "full" | "resize"
  collapsed?: boolean
  updates: number
}

async function measure(input: Case) {
  const body = sample(input.sections)
  const alternate = sample(input.mode === "resize" ? 55 : input.sections, true)
  const contents = Array.from({ length: input.parts }, () => createSignal(`${body}\n\nInitial marker`))
  const [title, setTitle] = createSignal("Thought")
  const [expanded, setExpanded] = createSignal(!input.collapsed)
  let scroll!: ScrollBoxRenderable
  const before = process.memoryUsage()
  let peakRSS = before.rss
  let peakHeap = before.heapUsed
  const mountStart = performance.now()
  const app = await testRender(
    () => {
      const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg } }, useRenderer().nativeScene)
      return (
        <scrollbox ref={scroll} width={100} height={30} stickyScroll={true} stickyStart="bottom">
          {Array.from({ length: input.parts }, (_, index) => (
            <box flexDirection="column">
              <text>{`${title()} ${index + 1}`}</text>
              <Show when={expanded()}>
                {input.renderer === "text" ? (
                  <text>{contents[index][0]()}</text>
                ) : input.renderer === "code" || input.renderer === "code-unstyled" ? (
                  <code
                    filetype="markdown"
                    drawUnstyledText={input.renderer === "code-unstyled"}
                    streaming={input.renderer === "code"}
                    syntaxStyle={syntaxStyle}
                    content={contents[index][0]()}
                    conceal={false}
                    fg={fg}
                  />
                ) : input.renderer === "markdown-raw" ? (
                  <markdown
                    content={contents[index][0]()}
                    streaming={false}
                    internalBlockMode="top-level"
                    syntaxStyle={syntaxStyle}
                    conceal={false}
                    fg={fg}
                  />
                ) : (
                  <ReasoningMarkdown
                    content={contents[index][0]()}
                    streaming={false}
                    syntaxStyle={syntaxStyle}
                    conceal={false}
                    fg={fg}
                  />
                )}
              </Show>
            </box>
          ))}
        </scrollbox>
      )
    },
    { width: 100, height: 30 },
  )
  try {
    const visible = async (marker: string, timeout: number) => {
      const deadline = performance.now() + timeout
      while (performance.now() < deadline) {
        await app.renderOnce()
        scroll.scrollBy(100_000)
        await app.renderOnce()
        if (app.captureCharFrame().includes(marker)) return true
        await Bun.sleep(2)
      }
      return false
    }
    const initialVisible = input.collapsed ? (await app.renderOnce(), true) : await visible("Initial marker", 3000)
    const mountMs = performance.now() - mountStart
    const latency: number[] = []
    let visibleUpdates = 0
    let correctFirstBlock = 0
    for (let index = 0; index < input.updates; index++) {
      const marker = `Update ${index}`
      const start = performance.now()
      const swapped = input.mode !== "tail" && index % 2 === 0
      const next = swapped ? alternate : body
      contents[input.parts - 1][1](`${next}\n\n${marker}`)
      setTitle(input.collapsed ? marker : "Thought")
      if (await visible(marker, 3000)) visibleUpdates++
      if (input.mode !== "tail" && !input.collapsed) {
        scroll.scrollTop = 0
        await app.renderOnce()
        const frame = app.captureCharFrame()
        const expected = swapped ? "Task 1" : "Step 1"
        const stale = swapped ? "Step 1" : "Task 1"
        if (frame.includes(expected) && !frame.includes(stale)) correctFirstBlock++
      }
      latency.push(performance.now() - start)
      const memory = process.memoryUsage()
      peakRSS = Math.max(peakRSS, memory.rss)
      peakHeap = Math.max(peakHeap, memory.heapUsed)
    }
    const ordered = latency.toSorted((a, b) => a - b)
    const percentile = (p: number) => Number(ordered[Math.ceil(p * ordered.length) - 1].toFixed(2))
    const expandStart = performance.now()
    if (input.collapsed) setExpanded(true)
    const expandVisible = input.collapsed ? await visible(`Update ${input.updates - 1}`, 3000) : undefined
    return {
      ...input,
      sampleBytes: Buffer.byteLength(body),
      mountMs: Number(mountMs.toFixed(2)),
      initialVisible,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      over16_7ms: latency.filter((ms) => ms > 16.7).length,
      visibleUpdates,
      correctFirstBlock: input.mode === "tail" || input.collapsed || input.parts > 1 ? undefined : correctFirstBlock,
      expandVisible,
      expandToVisibleMs: input.collapsed ? Number((performance.now() - expandStart).toFixed(2)) : undefined,
      peakRSSDeltaMB: Number(((peakRSS - before.rss) / 1024 / 1024).toFixed(1)),
      peakHeapDeltaMB: Number(((peakHeap - before.heapUsed) / 1024 / 1024).toFixed(1)),
    }
  } finally {
    app.renderer.destroy()
  }
}

console.log(JSON.stringify({ bun: Bun.version, viewport: "100x30", measure: "signal update through visible frame" }))
const cases = [
  { renderer: "code", sections: 96, parts: 1, mode: "tail", updates: 40 },
  { renderer: "markdown-raw", sections: 96, parts: 1, mode: "tail", updates: 40 },
  { renderer: "markdown", sections: 55, parts: 1, mode: "tail", updates: 40 },
  { renderer: "markdown", sections: 55, parts: 1, mode: "full", updates: 40 },
  { renderer: "markdown", sections: 60, parts: 1, mode: "full", updates: 40 },
  { renderer: "code", sections: 800, parts: 1, mode: "full", updates: 40 },
  { renderer: "markdown-raw", sections: 800, parts: 1, mode: "full", updates: 40 },
  { renderer: "markdown", sections: 800, parts: 1, mode: "full", updates: 40 },
  { renderer: "code-unstyled", sections: 800, parts: 1, mode: "full", updates: 40 },
  { renderer: "text", sections: 800, parts: 1, mode: "full", updates: 40 },
  { renderer: "markdown", sections: 800, parts: 1, mode: "resize", updates: 40 },
  { renderer: "markdown", sections: 800, parts: 3, mode: "full", updates: 40 },
  { renderer: "markdown", sections: 800, parts: 1, mode: "full", collapsed: true, updates: 40 },
] as const
for (const input of cases.filter(
  (item) =>
    (!process.argv[2] || process.argv[2].split(",").includes(item.renderer)) &&
    (!process.argv[3] || process.argv[3].split(",").includes(String(item.sections))),
)) {
  console.log(JSON.stringify(await measure(input)))
}
