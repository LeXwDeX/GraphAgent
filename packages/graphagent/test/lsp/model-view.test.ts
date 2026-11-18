// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "url"
import { LspModelView } from "../../src/lsp/model-view"

// #1450: a language server answers in 0-based coordinates and file:// URIs; the model sees what `read` shows.

const file = "/work/project/src/a b.ts"
const uri = pathToFileURL(file).href

describe("LspModelView.modelView", () => {
  test("adds 1 to a position, which holds only line and character", () => {
    expect(LspModelView.modelView({ line: 0, character: 0 })).toEqual({ line: 1, character: 1 })
    expect(LspModelView.modelView({ line: 9, character: 41 })).toEqual({ line: 10, character: 42 })
  })

  test("leaves an object with other keys beside line and character alone", () => {
    const value = { line: 3, character: 4, extra: true }
    expect(LspModelView.modelView(value)).toEqual({ line: 3, character: 4, extra: true })
    expect(LspModelView.modelView({ line: "3", character: 4 })).toEqual({ line: "3", character: 4 })
    expect(LspModelView.modelView({ line: 3 })).toEqual({ line: 3 })
  })

  test("converts a location: the URI becomes an absolute path and the range is 1-based", () => {
    const location = { uri, range: { start: { line: 4, character: 2 }, end: { line: 6, character: 0 } } }
    expect(LspModelView.modelView(location)).toEqual({
      path: file,
      range: { start: { line: 5, character: 3 }, end: { line: 7, character: 1 } },
    })
  })

  test("converts a location link: targetUri becomes targetPath and every range is 1-based", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
    const link = { originSelectionRange: range, targetUri: uri, targetRange: range, targetSelectionRange: range }
    const view = LspModelView.modelView(link)
    const shifted = { start: { line: 1, character: 1 }, end: { line: 1, character: 4 } }
    expect(view).toEqual({
      originSelectionRange: shifted,
      targetPath: file,
      targetRange: shifted,
      targetSelectionRange: shifted,
    })
  })

  test("walks arrays and nested symbols", () => {
    const range = { start: { line: 1, character: 1 }, end: { line: 2, character: 2 } }
    const symbols = [
      { name: "outer", kind: 5, range, selectionRange: range, children: [{ name: "inner", kind: 6, range }] },
      { name: "top", kind: 12, location: { uri, range } },
    ]
    expect(LspModelView.modelView(symbols)).toEqual([
      {
        name: "outer",
        kind: 5,
        range: { start: { line: 2, character: 2 }, end: { line: 3, character: 3 } },
        selectionRange: { start: { line: 2, character: 2 }, end: { line: 3, character: 3 } },
        children: [
          { name: "inner", kind: 6, range: { start: { line: 2, character: 2 }, end: { line: 3, character: 3 } } },
        ],
      },
      {
        name: "top",
        kind: 12,
        location: { path: file, range: { start: { line: 2, character: 2 }, end: { line: 3, character: 3 } } },
      },
    ])
  })

  test("keeps a uri that is not a file:// URI under its own key", () => {
    const value = { uri: "untitled:Untitled-1", range: { start: { line: 0, character: 0 } } }
    expect(LspModelView.modelView(value)).toEqual({
      uri: "untitled:Untitled-1",
      range: { start: { line: 1, character: 1 } },
    })
  })

  test.skipIf(process.platform === "win32")("keeps a file:// URI that does not convert under its own key", () => {
    // A host in a file URL is not a local path on POSIX; the conversion throws and the value is shown as it came.
    const remote = "file://remote-host/share/a.ts"
    expect(LspModelView.modelView({ uri: remote })).toEqual({ uri: remote })
  })

  test("copies everything else as it is", () => {
    expect(LspModelView.modelView("text")).toBe("text")
    expect(LspModelView.modelView(7)).toBe(7)
    expect(LspModelView.modelView(null)).toBeNull()
    expect(LspModelView.modelView(undefined)).toBeUndefined()
    expect(LspModelView.modelView({ contents: { kind: "markdown", value: "doc" } })).toEqual({
      contents: { kind: "markdown", value: "doc" },
    })
  })

  test("does not change its input", () => {
    const input = [{ uri, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } } }]
    const before = JSON.stringify(input)
    LspModelView.modelView(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
