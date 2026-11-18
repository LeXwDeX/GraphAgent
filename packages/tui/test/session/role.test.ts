// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { isRoot, isSubagent } from "../../src/session/role"

describe("session role", () => {
  test("a root is a root and every other role is delegated work", () => {
    expect([isRoot({ role: "root" }), isSubagent({ role: "root" })]).toEqual([true, false])
    for (const role of ["task_child", "dag_node"] as const) {
      expect([isRoot({ role }), isSubagent({ role })]).toEqual([false, true])
    }
  })

  test("no session is neither a root nor a sub-agent", () => {
    expect([isRoot(undefined), isSubagent(undefined)]).toEqual([false, false])
  })
})
