// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"

test("pasted multiline text grows the textarea and refreshes the frame", async () => {
  let area!: TextareaRenderable
  const app = await testRender(
    () => (
      <box width={20} flexDirection="column">
        <textarea ref={(value: TextareaRenderable) => (area = value)} focused minHeight={1} />
      </box>
    ),
    { width: 20, height: 10 },
  )

  try {
    await app.renderOnce()
    expect(area.getLayout().height).toBe(1)

    await app.mockInput.pasteBracketedText("one\r\ntwo\nthree")
    area.invalidateIntrinsicSize()
    await app.renderOnce()

    expect(area.plainText).toBe("one\ntwo\nthree")
    expect(area.getLayout().height).toBe(3)
    expect(app.captureCharFrame()).toContain("three")
  } finally {
    app.renderer.destroy()
    await app.renderer.closed
  }
})