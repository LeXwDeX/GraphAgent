import { EventEmitter } from "node:events"
import { expect, test } from "bun:test"
import { destroyRenderer, limitRendererListeners, RENDERER_LISTENER_LIMIT } from "../../src/util/renderer"

test("clears the terminal title before destroying the renderer", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: false,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual(["title:", "destroy"])
})

test("does not touch a destroyed renderer", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: true,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual([])
})

test("sets the listener limit to a fixed value above Node's default, not to unlimited", () => {
  const renderer = new EventEmitter()
  expect(renderer.getMaxListeners()).toBe(EventEmitter.defaultMaxListeners)
  limitRendererListeners(renderer)
  expect(renderer.getMaxListeners()).toBe(RENDERER_LISTENER_LIMIT)
  expect(RENDERER_LISTENER_LIMIT).toBeGreaterThan(EventEmitter.defaultMaxListeners)
  // 0 and Infinity both turn the warning off, and a real leak would pass in silence.
  expect(RENDERER_LISTENER_LIMIT).toBeGreaterThan(0)
  expect(Number.isFinite(RENDERER_LISTENER_LIMIT)).toBe(true)
})
