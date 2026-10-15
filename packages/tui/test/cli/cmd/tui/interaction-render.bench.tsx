/** @jsxImportSource @opentui/solid */
// Run from packages/tui: bun test/cli/cmd/tui/interaction-render.bench.tsx [baseline|bounded]
// Fixed budget: p95 input/scroll-to-frame <=100ms; 7500-line diff <=512 mounted source lines.
import { performance } from "node:perf_hooks"
import {
  addDefaultParsers,
  CodeRenderable,
  destroyTreeSitterClient,
  DiffRenderable,
  RGBA,
  SyntaxStyle,
  type Renderable,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, For } from "solid-js"
import parsers from "../../../../src/parsers-config"

addDefaultParsers(parsers.parsers)

const bounded = process.argv[2] === "bounded"
const Patch = bounded ? (await import("../../../../src/component/patch-diff")).PatchDiff : undefined
const fg = RGBA.fromHex("#dddddd")
const syntax = SyntaxStyle.fromStyles({ default: { fg } })
const patch = `--- /dev/null\n+++ b/large.ts\n@@ -0,0 +1,7500 @@\n${Array.from({ length: 7500 }, (_, i) => `+const line${i + 1} = ${i + 1}`).join("\n")}`
const nodes = (root: Renderable): Renderable[] => [root, ...root.getChildren().flatMap(nodes)]
const percentile = (values: number[], p: number) =>
  Number(values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1].toFixed(2))

console.log(
  JSON.stringify({
    mode: bounded ? "bounded" : "baseline",
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    budgetP95Ms: 100,
    mountedSourceLinesBudget: 512,
  }),
)
for (const width of [80, 160]) {
  for (const kind of ["diff", "markdown", "long-session"] as const) {
    let scroll!: ScrollBoxRenderable
    let editor!: TextareaRenderable
    const [typed, setTyped] = createSignal("")
    const [stream, setStream] = createSignal("Initial answer")
    const props = {
      diff: patch,
      view: "unified" as const,
      filetype: "typescript",
      syntaxStyle: syntax,
      showLineNumbers: true,
      width: "100%" as const,
      wrapMode: "char" as const,
      fg,
    }
    const mountedAt = performance.now()
    const app = await testRender(
      () => (
        <box width="100%" height="100%" flexDirection="column">
          <scrollbox ref={scroll} flexGrow={1} minHeight={0}>
            {kind === "diff" ? (
              Patch ? (
                <Patch {...props} scroll={() => scroll} />
              ) : (
                <diff {...props} />
              )
            ) : (
              <>
                <For each={Array.from({ length: kind === "long-session" ? 100 : 1 }, (_, i) => i)}>
                  {(index) => (
                    <markdown
                      content={`### Message ${index}\n\nRead this ordinary answer with **details** and \`code\`.\n\n${"Paragraph of context. ".repeat(12)}`}
                      syntaxStyle={syntax}
                      streaming={false}
                    />
                  )}
                </For>
                <markdown content={stream()} syntaxStyle={syntax} streaming={true} />
              </>
            )}
          </scrollbox>
          <textarea ref={editor} height={1} onContentChange={() => setTyped(editor.plainText)} />
          <text height={1}>{`Input: ${typed()}`}</text>
        </box>
      ),
      { width, height: 30 },
    )
    try {
      await app.renderOnce()
      editor.focus()
      await app.renderOnce()
      await Promise.all(
        nodes(app.renderer.root)
          .filter((node): node is CodeRenderable => node instanceof CodeRenderable)
          .map((node) => node.highlightingDone),
      )
      await app.renderOnce()
      const mountMs = performance.now() - mountedAt
      let mountedSourceLines = 0
      const input: number[] = [],
        scrolling: number[] = [],
        delay: number[] = []
      let visible = 0
      for (let i = 0; i < 40; i++) {
        editor.clear()
        const marker = String(i % 10)
        const start = performance.now()
        const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - start), 0))
        app.mockInput.pressKey(marker)
        if (kind !== "diff") setStream(`Streaming answer ${i}\n\n${"Answer text ".repeat(40)}`)
        await app.renderOnce()
        input.push(performance.now() - start)
        if (app.captureCharFrame().includes(`Input: ${marker}`)) visible++
        const scrollStart = performance.now()
        scroll.scrollTo((i % 10) * 750)
        await app.renderOnce()
        await app.renderOnce()
        scrolling.push(performance.now() - scrollStart)
        delay.push(await timer)
        mountedSourceLines = Math.max(
          mountedSourceLines,
          nodes(app.renderer.root)
            .filter((node): node is DiffRenderable => node instanceof DiffRenderable)
            .reduce(
              (sum, node) =>
                sum + node.diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
              0,
            ),
        )
      }
      scroll.scrollTo(0)
      await app.renderOnce()
      await app.renderOnce()
      const first = app.captureCharFrame().includes("line1 =")
      scroll.scrollTo(1_000_000)
      await app.renderOnce()
      await app.renderOnce()
      const last = app.captureCharFrame().includes("line7500 =")
      if (
        visible !== 40 ||
        percentile(input, 0.95) > 100 ||
        percentile(scrolling, 0.95) > 100 ||
        (bounded && kind === "diff" && (mountedSourceLines > 512 || !first || !last))
      )
        process.exitCode = 1
      console.log(
        JSON.stringify({
          kind,
          width,
          mountMs: Number(mountMs.toFixed(2)),
          inputP50Ms: percentile(input, 0.5),
          inputP95Ms: percentile(input, 0.95),
          scrollP95Ms: percentile(scrolling, 0.95),
          eventLoopP95Ms: percentile(delay, 0.95),
          visible,
          mountedSourceLines,
          first: kind === "diff" ? first : undefined,
          last: kind === "diff" ? last : undefined,
          codeNodes: nodes(app.renderer.root).filter((node) => node instanceof CodeRenderable).length,
        }),
      )
    } finally {
      app.renderer.destroy()
    }
  }
}
await destroyTreeSitterClient()
// This standalone harness owns the renderers and parser worker, which have all been disposed above.
process.exit(process.exitCode ?? 0)
