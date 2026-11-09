// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { parseServerCommandArgs } from "../../src/commands/server-args"

test("dag-mode lists every candidate when no prefix is typed", () => {
  expect(parseServerCommandArgs("/dag-mode ")).toEqual({
    command: "dag-mode",
    partial: "",
    candidates: ["on", "off", "status", "budget"],
  })
})

test("dag-mode filters candidates by the typed prefix", () => {
  expect(parseServerCommandArgs("/dag-mode o")).toEqual({
    command: "dag-mode",
    partial: "o",
    candidates: ["on", "off"],
  })
  expect(parseServerCommandArgs("/dag-mode b")).toEqual({
    command: "dag-mode",
    partial: "b",
    candidates: ["budget"],
  })
  expect(parseServerCommandArgs("/dag-mode z")).toEqual({
    command: "dag-mode",
    partial: "z",
    candidates: [],
  })
})

test("argument completion only matches the first argument", () => {
  expect(parseServerCommandArgs("/dag-mode")).toBeUndefined()
  expect(parseServerCommandArgs("/dag-mode on extra")).toBeUndefined()
  expect(parseServerCommandArgs("/dag-mode on ")).toBeUndefined()
})

test("unknown and malformed commands have no argument completion", () => {
  expect(parseServerCommandArgs("/unknown ")).toBeUndefined()
  expect(parseServerCommandArgs("/dag-mode/on ")).toBeUndefined()
  expect(parseServerCommandArgs("dag-mode ")).toBeUndefined()
  expect(parseServerCommandArgs("")).toBeUndefined()
})
