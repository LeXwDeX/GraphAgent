/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import {
  addDefaultParsers,
  CodeRenderable,
  DiffRenderable,
  LineNumberRenderable,
  RGBA,
  SyntaxStyle,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { PatchDiff, type PatchDiffRef } from "../../../src/component/patch-diff"
import parsers from "../../../src/parsers-config"

addDefaultParsers(parsers.parsers)
const fg = RGBA.fromHex("#dddddd")
const syntax = SyntaxStyle.fromStyles({ default: { fg }, comment: { fg: RGBA.fromHex("#888888") } })
const nodes = (root: Renderable): Renderable[] => [root, ...root.getChildren().flatMap(nodes)]
const added = (lines: string[], marker = false) =>
  `--- /dev/null\n+++ b/file.ts\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}${marker ? "\n\\ No newline at end of file" : ""}`

for (const width of [80, 160])
  test(`large additions mount a bounded viewport and retain both ends at ${width} columns`, async () => {
    let scroll!: ScrollBoxRenderable
    let ref!: PatchDiffRef
    const [view, setView] = createSignal<"unified" | "split">("unified")
    const app = await testRender(
      () => (
        <scrollbox ref={scroll} width="100%" height={20}>
          <PatchDiff
            ref={(value) => (ref = value)}
            scroll={() => scroll}
            diff={added(
              Array.from({ length: 7500 }, (_, i) => `line${i + 1}`),
              true,
            )}
            view={view()}
            filetype="typescript"
            syntaxStyle={syntax}
            showLineNumbers={true}
            wrapMode="char"
            width="100%"
          />
        </scrollbox>
      ),
      { width, height: 20 },
    )
    const rendered = () =>
      nodes(app.renderer.root).filter((node): node is DiffRenderable => node instanceof DiffRenderable)
    const ready = async (marker: string) => {
      await app.waitForFrame((frame) => frame.includes(marker))
      expect(
        rendered().reduce(
          (sum, node) =>
            sum + node.diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
          0,
        ),
      ).toBeLessThanOrEqual(512)
    }
    try {
      await ready("line1")
      expect(ref.hunks()).toHaveLength(1)
      const gutters = nodes(app.renderer.root).filter(
        (node): node is LineNumberRenderable => node instanceof LineNumberRenderable,
      )
      expect(gutters.every((node) => node.getLineNumbers().get(-1) === 7500)).toBe(true)
      scroll.scrollTo(1_000_000)
      await ready("line7500")
      setView("split")
      await ready("line7500")
      app.resize(width === 80 ? 160 : 80, 20)
      await ready("line7500")
      scroll.scrollTo(0)
      await ready("line1")
    } finally {
      app.renderer.destroy()
    }
  })

test("wrapped long lines and multi-line syntax retain whole-file context across chunks and view changes", async () => {
  let scroll!: ScrollBoxRenderable
  const [view, setView] = createSignal<"unified" | "split">("unified")
  const lines = Array.from({ length: 3200 }, (_, i) => `comment${i + 1}`)
  lines[0] = "/* comment starts"
  lines[1] = "中文🙂 inside the same comment"
  lines[128] = "inside\t" + "long word ".repeat(60) + "WRAPPED_END"
  lines[3199] = "comment ends */ FINAL"
  const app = await testRender(
    () => (
      <scrollbox ref={scroll} width="100%" height={20}>
        <PatchDiff
          scroll={() => scroll}
          diff={added(lines)}
          view={view()}
          filetype="typescript"
          syntaxStyle={syntax}
          showLineNumbers={true}
          wrapMode="word"
          width="100%"
        />
      </scrollbox>
    ),
    { width: 80, height: 20 },
  )
  try {
    await app.waitForFrame((frame) => frame.includes("comment starts"))
    scroll.scrollTo(125)
    await app.waitForFrame((frame) => frame.includes("WRAPPED_END"))
    const codes = nodes(app.renderer.root).filter(
      (node): node is CodeRenderable => node instanceof CodeRenderable && node.content.startsWith("inside"),
    )
    expect(codes).toHaveLength(1)
    const result = await codes[0].onHighlight?.([], {
      content: codes[0].content,
      filetype: "typescript",
      syntaxStyle: syntax,
    })
    expect(result?.some((item) => item[0] === 0 && item[2] === "comment")).toBe(true)
    setView("split")
    await app.renderOnce()
    await app.renderOnce()
    const split = nodes(app.renderer.root).filter(
      (node): node is CodeRenderable => node instanceof CodeRenderable && node.content.startsWith("inside"),
    )
    expect(split).toHaveLength(1)
    const splitResult = await split[0].onHighlight?.([], {
      content: split[0].content,
      filetype: "typescript",
      syntaxStyle: syntax,
    })
    expect(splitResult?.some((item) => item[0] === 0 && item[2] === "comment")).toBe(true)
    expect(
      nodes(app.renderer.root)
        .filter((node): node is LineNumberRenderable => node instanceof LineNumberRenderable)
        .every((node) => node.getLineNumbers().get(-1) === 3200),
    ).toBe(true)
    setView("unified")
    scroll.scrollTo(1_000_000)
    await app.waitForFrame((frame) => frame.includes("FINAL"))
    app.resize(160, 20)
    scroll.scrollTo(125)
    await app.waitForFrame((frame) => frame.includes("WRAPPED_END"))
  } finally {
    app.renderer.destroy()
  }
})

test("resizing wrapped additions preserves the logical reading position when earlier content reflows", async () => {
  let scroll!: ScrollBoxRenderable
  const lines = Array.from(
    { length: 3200 },
    (_, index) => `source${index + 1} ${index < 100 ? "wide text ".repeat(40) : ""}`,
  )
  const app = await testRender(
    () => (
      <scrollbox ref={scroll} width="100%" height={20}>
        <text wrapMode="char">{"prefix ".repeat(2000)}</text>
        <PatchDiff
          scroll={() => scroll}
          diff={added(lines)}
          view="unified"
          wrapMode="char"
          showLineNumbers={true}
          width="100%"
        />
      </scrollbox>
    ),
    { width: 80, height: 20 },
  )
  try {
    await app.waitForFrame((frame) => frame.includes("prefix"))
    scroll.scrollTo(2200)
    await app.renderOnce()
    await app.renderOnce()
    const before = app.captureCharFrame().match(/source\d+/)?.[0]
    expect(before).toBeDefined()
    app.resize(160, 20)
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame().match(/source\d+/)?.[0]).toBe(before)
  } finally {
    app.renderer.destroy()
  }
})

test("small and mixed patches use the original diff renderer and release lifecycle work", async () => {
  const [patch, setPatch] = createSignal(added(["first", "last"]))
  let scroll!: ScrollBoxRenderable
  let ref!: PatchDiffRef
  const app = await testRender(
    () => (
      <scrollbox ref={scroll} width={80} height={20}>
        <PatchDiff ref={(value) => (ref = value)} scroll={() => scroll} diff={patch()} view="unified" width="100%" />
      </scrollbox>
    ),
    { width: 80, height: 20 },
  )
  try {
    await app.waitForFrame((frame) => frame.includes("first"))
    expect(nodes(app.renderer.root).filter((node) => node instanceof DiffRenderable)).toHaveLength(1)
    setPatch("--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context")
    await app.waitForFrame((frame) => frame.includes("context"))
    const diffs = nodes(app.renderer.root).filter((node): node is DiffRenderable => node instanceof DiffRenderable)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].diff).toBe(patch())
    setPatch(added(Array.from({ length: 7500 }, (_, i) => `large${i}`)))
    await app.waitForFrame((frame) => frame.includes("large0"))
    const virtual = ref.hunks()[0].node
    const unregister = spyOn(app.renderer, "unregisterLifecyclePass")
    setPatch(added(["restored"]))
    await app.waitForFrame((frame) => frame.includes("restored"))
    expect(virtual.isDestroyed).toBe(true)
    expect(unregister.mock.calls.some(([node]) => node === virtual)).toBe(true)
    unregister.mockRestore()
    expect(nodes(app.renderer.root).filter((node) => node instanceof DiffRenderable)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})
