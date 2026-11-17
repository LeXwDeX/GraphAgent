// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { serverToastText } from "../../src/ui/toast"

describe("serverToastText: the text of a toast a server event carries", () => {
  test("is the message alone when there is no title", () => {
    expect(serverToastText(undefined, "saved")).toBe("saved")
    expect(serverToastText("", "saved")).toBe("saved")
  })

  test("puts the title in front of a message that does not begin with it", () => {
    expect(serverToastText("Build", "finished in 4s")).toBe("Build: finished in 4s")
  })

  test("does not say the title twice when the message already begins with it", () => {
    // The server's budget toasts: the title is also the first words of the message.
    expect(serverToastText("DAG token budget", "DAG token budget: over 85% used")).toBe(
      "DAG token budget: over 85% used",
    )
    expect(serverToastText("DAG token budget", "DAG token budget exhausted: workflows paused")).toBe(
      "DAG token budget exhausted: workflows paused",
    )
  })

  test("a title that only occurs inside the message is still put in front", () => {
    expect(serverToastText("Budget", "The DAG Budget is low")).toBe("Budget: The DAG Budget is low")
  })
})
