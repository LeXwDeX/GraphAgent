/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { NativeResourceOwner, SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createSyntaxStyleMemo } from "../src/context/theme"
import { DEFAULT_THEMES, generateSyntax, resolveTheme } from "../src/theme"

function isDestroyed(style: SyntaxStyle) {
  try {
    style.getStyleCount()
    return false
  } catch {
    return true
  }
}

test("binds syntax styles to the renderer owner and releases replaced styles", async () => {
  const theme = resolveTheme(DEFAULT_THEMES.opencode, "dark")
  const owners: NativeResourceOwner[] = []
  const styles: SyntaxStyle[] = []
  let swap!: () => void

  const app = await testRender(
    () => {
      const [version, setVersion] = createSignal(0)
      swap = () => setVersion((value) => value + 1)
      const syntax = createSyntaxStyleMemo((owner) => {
        owners.push(owner)
        // Reading the signal keeps the memo subscribed; swapping rebuilds the style.
        void version()
        const style = generateSyntax(theme, owner)
        styles.push(style)
        return style
      })
      return <text>{syntax().getStyleCount()}</text>
    },
    { width: 20, height: 3 },
  )

  try {
    await app.renderOnce()
    expect(styles.length).toBe(1)
    expect(owners[0]).toBe(app.renderer.nativeScene)
    expect(() => styles[0].getStyleCount()).not.toThrow()

    swap()
    await app.waitFor(async () => {
      if (styles.length !== 2) return false
      await app.renderOnce()
      return isDestroyed(styles[0])
    })
    expect(owners[1]).toBe(app.renderer.nativeScene)
    expect(() => styles[0].getStyleCount()).toThrow("NativeSyntaxStyle is destroyed")
    expect(() => styles[1].getStyleCount()).not.toThrow()
  } finally {
    app.renderer.destroy()
    await app.renderer.closed
  }

  expect(isDestroyed(styles[1])).toBe(true)
})