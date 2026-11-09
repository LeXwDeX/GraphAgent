// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { buildStdinEnvelope } from "@/hook/envelope"

// §12: `dag_mode` is a read-only input field on the two events that can
// observe a session's DAG mode. Only a defined value is emitted; a child
// session (or a session without a mode) omits the key entirely rather than
// sending an empty string.

const ctx = { sessionID: "ses-dag-envelope" }

describe("dag_mode envelope field", () => {
  for (const dagMode of ["on", "off"] as const) {
    test(`UserPromptSubmit emits dag_mode "${dagMode}"`, () => {
      const envelope = buildStdinEnvelope({ event: "UserPromptSubmit", prompt: "hi", dagMode }, ctx, "/tmp")
      expect(envelope).toMatchObject({ hook_event_name: "UserPromptSubmit", dag_mode: dagMode })
    })

    test(`SessionStart emits dag_mode "${dagMode}"`, () => {
      const envelope = buildStdinEnvelope({ event: "SessionStart", source: "startup", dagMode }, ctx, "/tmp")
      expect(envelope).toMatchObject({ hook_event_name: "SessionStart", dag_mode: dagMode })
    })
  }

  test("UserPromptSubmit omits dag_mode when undefined", () => {
    const envelope = buildStdinEnvelope({ event: "UserPromptSubmit", prompt: "hi" }, ctx, "/tmp")
    expect(Object.hasOwn(envelope, "dag_mode")).toBe(false)
  })

  test("SessionStart omits dag_mode when undefined", () => {
    const envelope = buildStdinEnvelope({ event: "SessionStart", source: "resume" }, ctx, "/tmp")
    expect(Object.hasOwn(envelope, "dag_mode")).toBe(false)
  })

  test("other events do not gain a dag_mode field", () => {
    const envelope = buildStdinEnvelope({ event: "Stop", stopHookActive: false }, ctx, "/tmp")
    expect(Object.hasOwn(envelope, "dag_mode")).toBe(false)
  })
})
