/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, type ColorInput } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { SpinnerRenderable } from "../../src/ui/spinner-renderable"
import "../../src/ui/spinner-register"

const FRAMES = ["⠋", "⠙", "⠹"]

function spinnerOf(app: Awaited<ReturnType<typeof testRender>>) {
  const node = app.renderer.root.getChildren()[0]
  if (!(node instanceof SpinnerRenderable)) throw new Error("spinner was not mounted")
  return node
}

test("registers the spinner element and advances frames while visible", async () => {
  const app = await testRender(() => <spinner frames={FRAMES} interval={20} color={RGBA.fromHex("#ff0000")} />, {
    width: 10,
    height: 2,
  })
  try {
    const seen = new Set<string>()
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && seen.size < 2) {
      await app.renderOnce()
      const frame = FRAMES.find((value) => app.captureCharFrame().includes(value))
      if (frame) seen.add(frame)
      await Bun.sleep(20)
    }
    expect(seen.size).toBeGreaterThan(1)
  } finally {
    app.renderer.destroy()
    await app.renderer.closed
  }
})

test("measures frame width and passes every grapheme to the color generator", async () => {
  const calls: Array<[number, number, number, number]> = []
  const color: (...args: [number, number, number, number]) => ColorInput = (...args) => {
    calls.push(args)
    return "#00ff00"
  }
  const app = await testRender(() => <spinner frames={["🌕x"]} interval={1000} autoplay={false} color={color} />, {
    width: 10,
    height: 2,
  })
  try {
    await app.renderOnce()
    const spinner = spinnerOf(app)
    expect(spinner.width).toBe(3)
    expect(calls.some(([frame, char, frames, chars]) => frame === 0 && char === 1 && frames === 1 && chars === 2)).toBe(
      true,
    )
  } finally {
    app.renderer.destroy()
    await app.renderer.closed
  }
})

test("name selects a built-in frame set and interval", async () => {
  const app = await testRender(() => <spinner name="dots" autoplay={false} />, { width: 10, height: 2 })
  try {
    await app.renderOnce()
    const spinner = spinnerOf(app)
    expect(spinner.name).toBe("dots")
    expect(spinner.frames.length).toBeGreaterThan(1)
    expect(app.captureCharFrame()).toContain(spinner.frames[0])
  } finally {
    app.renderer.destroy()
    await app.renderer.closed
  }
})