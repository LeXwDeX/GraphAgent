// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { inlineRow } from "../../src/panel/list"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"

// `inlineRow` fits `title  description` to the cells of a row (#1666): the description gives way first, and only when
// there is nothing of it left to show does the title get cut.

describe("inlineRow", () => {
  test("writes both in full, two cells apart, when they fit", () => {
    expect(inlineRow("Model One", "Test Provider", 40, 1)).toEqual({ title: "Model One", description: "Test Provider" })
    // The row is exactly as wide as the two and the gap between them.
    const exact = cellWidth("Model One") + 2 + cellWidth("Test Provider")
    expect(inlineRow("Model One", "Test Provider", exact, 1)).toEqual({
      title: "Model One",
      description: "Test Provider",
    })
  })

  test("cuts the description first, to what is left after the title and the gap", () => {
    const exact = cellWidth("Model One") + 2 + cellWidth("Test Provider")
    const row = inlineRow("Model One", "Test Provider", exact - 1, 1)
    expect(row.title).toBe("Model One")
    expect(row.description).toBe("Test Provid…")
    expect(cellWidth(row.title) + 2 + cellWidth(row.description!)).toBe(exact - 1)
    // Down to a single character before the ellipsis.
    expect(inlineRow("Model One", "Test Provider", cellWidth("Model One") + 2 + 2, 1)).toEqual({
      title: "Model One",
      description: "T…",
    })
  })

  test("drops a description that would be left with only the ellipsis, and keeps the whole title", () => {
    const title = cellWidth("Model One")
    expect(inlineRow("Model One", "Test Provider", title + 2 + 1, 1)).toEqual({ title: "Model One" })
    expect(inlineRow("Model One", "Test Provider", title + 2, 1)).toEqual({ title: "Model One" })
    expect(inlineRow("Model One", "Test Provider", title + 1, 1)).toEqual({ title: "Model One" })
    expect(inlineRow("Model One", "Test Provider", title, 1)).toEqual({ title: "Model One" })
  })

  test("cuts the title only when it does not fit alone, and then writes no description", () => {
    expect(inlineRow("Model One Extended", "Test Provider", 10, 1)).toEqual({ title: "Model One…" })
    expect(inlineRow("Model One Extended", undefined, 10, 1)).toEqual({ title: "Model One…" })
    expect(inlineRow("Model One Extended", "", 10, 1)).toEqual({ title: "Model One…" })
    expect(inlineRow("Model One", undefined, 40, 1)).toEqual({ title: "Model One" })
  })

  test("leaves nothing of a row that has no cell", () => {
    expect(inlineRow("Model One", "Test Provider", 0, 1)).toEqual({ title: "" })
    expect(inlineRow("Model One", "Test Provider", -3, 1)).toEqual({ title: "" })
  })

  test("counts wide characters as two cells and the ellipsis as two at ambiguous width 2", () => {
    // 阿尔法 is six cells; 4 + 2 + 6 = 12 fits exactly, and one cell less cuts a whole character.
    expect(inlineRow("Beta", "阿尔法", 12, 1)).toEqual({ title: "Beta", description: "阿尔法" })
    expect(inlineRow("Beta", "阿尔法", 11, 1)).toEqual({ title: "Beta", description: "阿尔…" })
    expect(inlineRow("Beta", "阿尔法", 11, 2)).toEqual({ title: "Beta", description: "阿…" })
    // A wide character and the ellipsis take three cells at 1 and four at 2; with less room only the ellipsis would be
    // left, and that goes.
    expect(inlineRow("Beta", "阿尔法", 9, 1)).toEqual({ title: "Beta", description: "阿…" })
    expect(inlineRow("Beta", "阿尔法", 9, 2)).toEqual({ title: "Beta" })
    expect(inlineRow("Beta", "阿尔法", 8, 1)).toEqual({ title: "Beta" })
  })

  test("never writes a row wider than the budget, at either ambiguous width", () => {
    const titles = ["", "Model", "Model One Extended Reasoning", "模型一", "模型一 Extended 推理预览", "●◆─ Model"]
    const descriptions = [undefined, "", "P", "Test Provider", "测试提供商", "测试 Provider 的一个相当长的名称"]
    for (const ambiguousWidth of [1, 2] as AmbiguousWidth[]) {
      for (const title of titles) {
        for (const description of descriptions) {
          for (let budget = 0; budget <= 48; budget++) {
            const row = inlineRow(title, description, budget, ambiguousWidth)
            const width =
              cellWidth(row.title, ambiguousWidth) +
              (row.description === undefined ? 0 : 2 + cellWidth(row.description, ambiguousWidth))
            expect({ title, description, budget, ambiguousWidth, fits: width <= budget }).toEqual({
              title,
              description,
              budget,
              ambiguousWidth,
              fits: true,
            })
            // A description that is written is either whole or cut, and a cut one says at least a character.
            if (row.description !== undefined) {
              expect(row.title).toBe(title)
              expect(description!.startsWith(row.description.replace(/…$/, ""))).toBe(true)
              expect(row.description).not.toBe("…")
              expect(row.description).not.toBe("")
            }
            // The title is whole unless even it alone did not fit.
            if (row.title !== title) expect(cellWidth(title, ambiguousWidth)).toBeGreaterThan(budget)
          }
        }
      }
    }
  })
})
