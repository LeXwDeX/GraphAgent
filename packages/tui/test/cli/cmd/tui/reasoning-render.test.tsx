// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { CodeRenderable, RGBA, SyntaxStyle, type BaseRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { testRender, useRenderer, type JSX } from "@opentui/solid"
import { createSignal } from "solid-js"
import { AdaptiveMarkdown } from "../../../../src/ui/adaptive-markdown"

const fg = RGBA.fromHex("#888888")
const createSyntax = (renderer: ReturnType<typeof useRenderer>) =>
  SyntaxStyle.fromStyles({ default: { fg } }, renderer.nativeScene)
const withSyntax = (node: (syntaxStyle: SyntaxStyle) => JSX.Element) => () => node(createSyntax(useRenderer()))
let app: Awaited<ReturnType<typeof testRender>> | undefined

// Markdown blocks start asynchronous Tree-sitter highlighting during rendering.
// Wait for OpenTUI's completion promise, then render its resulting text/layout.
async function renderReady() {
  const current = app!
  const deadline = performance.now() + 5_000
  const highlighting = (node: BaseRenderable): CodeRenderable[] => [
    ...(node instanceof CodeRenderable && node.isHighlighting ? [node] : []),
    ...node.getChildren().flatMap(highlighting),
  ]
  for (;;) {
    await current.renderOnce()
    const pending = highlighting(current.renderer.root)
    if (pending.length === 0) return
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error(`Markdown highlighting did not settle:\n${current.captureCharFrame()}`)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(pending.map((node) => node.highlightingDone)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Markdown highlighting did not settle:\n${current.captureCharFrame()}`)),
            remaining,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}

afterEach(() => {
  app?.renderer.destroy()
  app = undefined
})

test("replaces a streamed thought with distilled markdown in the same rendered slot", async () => {
  const [content, setContent] = createSignal("Original reasoning with `old` detail")
  app = await testRender(
    withSyntax((syntaxStyle) => (
      <box width={56}>
        <text>Thought: Plan</text>
        <AdaptiveMarkdown content={content()} streaming={false} syntaxStyle={syntaxStyle} conceal={false} fg={fg} />
        <text>Final answer</text>
      </box>
    )),
    { width: 56, height: 12 },
  )
  await renderReady()
  expect(app.captureCharFrame()).toContain("Original reasoning with `old` detail")

  setContent("Replacement reasoning with `new` detail")
  await renderReady()
  const frame = app.captureCharFrame()
  expect(frame).toContain("Replacement reasoning with `new` detail")
  expect(frame).toContain("Final answer")
  expect(frame).not.toContain("Original reasoning")
})

test("shows appended text while the thought is still streaming", async () => {
  const [content, setContent] = createSignal("Initial thought")
  app = await testRender(
    withSyntax((syntaxStyle) => (
      <AdaptiveMarkdown content={content()} streaming={true} syntaxStyle={syntaxStyle} conceal={false} fg={fg} />
    )),
    { width: 48, height: 5 },
  )
  await renderReady()
  setContent("Initial thought\n\nNew evidence")
  await renderReady()
  expect(app.captureCharFrame()).toContain("New evidence")
})

test("one mounted thought streams, finalizes, then replaces its first and last blocks", async () => {
  const [content, setContent] = createSignal("OLD FIRST\n\nOLD LAST")
  const [streaming, setStreaming] = createSignal(true)
  app = await testRender(
    withSyntax((syntaxStyle) => (
      <AdaptiveMarkdown
        content={content()}
        streaming={streaming()}
        syntaxStyle={syntaxStyle}
        conceal={false}
        fg={fg}
      />
    )),
    { width: 48, height: 8 },
  )
  await renderReady()
  setContent("OLD FIRST\n\nAPPENDED MIDDLE\n\nOLD LAST")
  await renderReady()
  expect(app.captureCharFrame()).toContain("APPENDED MIDDLE")
  setStreaming(false)
  await renderReady()
  setContent("NEW FIRST\n\nDISTILLED MIDDLE\n\nNEW LAST")
  await renderReady()
  const frame = app.captureCharFrame()
  expect(frame).toContain("NEW FIRST")
  expect(frame).toContain("NEW LAST")
  expect(frame).not.toContain("OLD FIRST")
  expect(frame).not.toContain("OLD LAST")
})

test("switches at exactly 4096/4097 UTF-8 bytes while streaming without leaving old content", async () => {
  const body = (bytes: number, marker: string) => {
    const head = `### ${marker}\n`
    const tail = `\n${marker} END`
    const content = head + "a".repeat(bytes - Buffer.byteLength(head) - Buffer.byteLength(tail)) + tail
    expect(Buffer.byteLength(content)).toBe(bytes)
    return content
  }
  const short = body(4096, "SHORT")
  const long = body(4097, "LONG")
  const [content, setContent] = createSignal(short)
  let scroll!: ScrollBoxRenderable
  app = await testRender(
    withSyntax((syntaxStyle) => (
      <scrollbox ref={scroll} width={56} height={6}>
        <AdaptiveMarkdown content={content()} streaming={true} syntaxStyle={syntaxStyle} conceal={true} fg={fg} />
      </scrollbox>
    )),
    { width: 56, height: 6 },
  )
  const frame = async () => {
    scroll.scrollTop = 0
    await renderReady()
    const top = app!.captureCharFrame()
    scroll.scrollBy(100_000)
    await renderReady()
    return { top, bottom: app!.captureCharFrame() }
  }
  const first = await frame()
  expect(first.top).toContain("SHORT")
  expect(first.top).not.toContain("### SHORT")
  expect(first.bottom).toContain("SHORT END")
  setContent(long)
  const second = await frame()
  expect(second.top).toContain("### LONG")
  expect(second.top).not.toContain("SHORT")
  expect(second.bottom).toContain("LONG END")
  setContent(short)
  const third = await frame()
  expect(third.top).not.toContain("### SHORT")
  expect(third.top).not.toContain("LONG")
  expect(third.bottom).toContain("SHORT END")

  const chineseShort = body(4096, "思考")
  const chineseLong = body(4097, "替换")
  setContent(chineseShort)
  const fourth = await frame()
  expect(fourth.top).not.toContain("### 思考")
  expect(fourth.bottom).toContain("思考 END")
  setContent(chineseLong)
  const fifth = await frame()
  expect(fifth.top).toContain("### 替换")
  expect(fifth.top).not.toContain("思考")
  expect(fifth.bottom).toContain("替换 END")
})

test("shows an entire long streaming replacement as readable plain text without stale content", async () => {
  const original = Array.from({ length: 800 }, (_, i) => `### Step ${i}: original evidence`).join("\n")
  const replacement = Array.from({ length: 800 }, (_, i) => `### Task ${i}: distilled evidence`).join("\n")
  const [content, setContent] = createSignal(original)
  let scroll!: ScrollBoxRenderable
  app = await testRender(
    withSyntax((syntaxStyle) => (
      <scrollbox ref={scroll} width={64} height={8}>
        <AdaptiveMarkdown content={content()} streaming={true} syntaxStyle={syntaxStyle} conceal={false} fg={fg} />
      </scrollbox>
    )),
    { width: 64, height: 8 },
  )
  await renderReady()
  expect(app.captureCharFrame()).toContain("### Step 0: original evidence")
  setContent(replacement)
  await renderReady()
  const top = app.captureCharFrame()
  expect(top).toContain("### Task 0: distilled evidence")
  expect(top).not.toContain("original evidence")
  scroll.scrollBy(100_000)
  await renderReady()
  expect(app.captureCharFrame()).toContain("### Task 799: distilled evidence")
})

test("shortening a thought below the viewport keeps the earlier reading position", async () => {
  const [content, setContent] = createSignal(Array.from({ length: 14 }, (_, i) => `Thought line ${i}`).join("\n\n"))
  let scroll!: ScrollBoxRenderable
  app = await testRender(
    withSyntax((syntaxStyle) => (
      <scrollbox ref={scroll} width={48} height={5}>
        <text>{Array.from({ length: 10 }, (_, i) => `Earlier row ${i}`).join("\n")}</text>
        <AdaptiveMarkdown content={content()} streaming={false} syntaxStyle={syntaxStyle} conceal={false} fg={fg} />
        <text>Later anchor</text>
      </scrollbox>
    )),
    { width: 48, height: 5 },
  )
  await renderReady()
  scroll.scrollTop = 4
  await renderReady()
  const before = scroll.scrollTop
  expect(app.captureCharFrame()).toContain("Earlier row 4")
  setContent("Short replacement")
  await renderReady()
  expect(scroll.scrollTop).toBe(before)
  expect(app.captureCharFrame()).toContain("Earlier row 4")
})

test("growing a thought while following the bottom keeps the later anchor visible", async () => {
  const [content, setContent] = createSignal("Short thought")
  let scroll!: ScrollBoxRenderable
  app = await testRender(
    withSyntax((syntaxStyle) => (
      <scrollbox ref={scroll} stickyScroll={true} stickyStart="bottom" width={48} height={5}>
        <text>{Array.from({ length: 10 }, (_, i) => `Earlier row ${i}`).join("\n")}</text>
        <AdaptiveMarkdown content={content()} streaming={false} syntaxStyle={syntaxStyle} conceal={false} fg={fg} />
        <text>Later anchor</text>
      </scrollbox>
    )),
    { width: 48, height: 5 },
  )
  await renderReady()
  scroll.scrollBy(1000)
  await renderReady()
  const before = scroll.scrollTop
  expect(app.captureCharFrame()).toContain("Later anchor")
  setContent(Array.from({ length: 14 }, (_, i) => `Distilled line ${i}`).join("\n\n"))
  await renderReady()
  expect(scroll.scrollTop).toBeGreaterThan(before)
  expect(app.captureCharFrame()).toContain("Later anchor")
})
