// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { unpriced } from "@graphagent/core/util/cost"
import { sessionTokenTotal } from "../../src/util/session-usage"

test("a session's tokens are the five counts added up, and none for a session that recorded none", () => {
  expect(sessionTokenTotal(undefined)).toBe(0)
  expect(sessionTokenTotal({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })).toBe(0)
  expect(sessionTokenTotal({ input: 1, output: 2, reasoning: 4, cache: { read: 8, write: 16 } })).toBe(31)
})

test("a cost of zero is unknown only when there are tokens to have priced", () => {
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 1 } }
  expect(unpriced(0, sessionTokenTotal(tokens))).toBe(true)
  expect(unpriced(0, sessionTokenTotal(undefined))).toBe(false)
  expect(unpriced(0.0027, sessionTokenTotal(tokens))).toBe(false)
})
