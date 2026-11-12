// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { remoteLine } from "../../src/util/remote-text"

test("remoteLine strips ANSI escapes and control characters and keeps one line", () => {
  expect(remoteLine("\u001b[1;31mboom\u001b[0m")).toBe("boom")
  expect(remoteLine("first\r\n  second\nthird")).toBe("first second third")
  expect(remoteLine("a\u0007b\u0000c\u009bd\u007fe")).toBe("abcde")
  expect(remoteLine("title\u001b]0;pwned\u0007 end")).toBe("title end")
  expect(remoteLine("  plain 中文 ◆  ")).toBe("plain 中文 ◆")
})
