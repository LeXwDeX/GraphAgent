// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { LocalPermissionStartup } from "@/permission/local-startup"
import { interactiveMarkable, nonInteractiveMarkable } from "../../../src/cli/cmd/run/authorization"

describe("run startup authorisation", () => {
  test("an explicit --session marks only that session's resumed write routes", () => {
    const markable = nonInteractiveMarkable({ session: "ses_selected" }, new Set(["ses_selected"]))

    expect(markable("POST", "/session")).toEqual({})
    for (const route of ["message", "prompt", "prompt_async", "command", "resume"])
      expect(markable("POST", `/session/ses_selected/${route}`)).toEqual({ sessionID: "ses_selected" })

    expect(markable("POST", "/session/ses_other/message")).toBeUndefined()
    expect(markable("POST", "/session/ses_selected/abort")).toBeUndefined()
    expect(markable("GET", "/session/ses_selected/message")).toBeUndefined()
    expect(markable("POST", "/session/ses_selected/message/extra")).toBeUndefined()
  })

  test("without --session, --continue or --fork resumed routes stay unmarked", () => {
    const markable = nonInteractiveMarkable({}, new Set(["ses_selected"]))

    expect(markable("POST", "/session")).toEqual({})
    expect(markable("POST", "/session/ses_selected/message")).toBeUndefined()
  })

  test("interactive runs without --session only mark session creation", () => {
    expect(interactiveMarkable("POST", "/session")).toEqual({})
    expect(interactiveMarkable("POST", "/session/ses_interactive/message")).toBeUndefined()
    expect(interactiveMarkable("GET", "/session")).toBeUndefined()
  })

  test("forged headers and bodies cannot create a startup mark", () => {
    const target = "http://example.com/session/ses_target/message"
    const forged = new Request(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-graphagent-directory": "/tmp/project",
        "x-graphagent-session": "ses_target",
        "x-graphagent-permission": "bypass",
        "x-graphagent-local-startup": "ses_target",
      },
      body: JSON.stringify({
        sessionID: "ses_target",
        dangerouslySkipPermissions: true,
        localPermissionStartup: true,
      }),
    })

    // Nothing crossed JSON or headers: an externally built request is unmarked.
    expect(LocalPermissionStartup.take(forged, "ses_target")).toBe(false)

    const original = new Request(target, { method: "POST" })
    LocalPermissionStartup.mark(original, "ses_target")
    expect(LocalPermissionStartup.take(forged, "ses_target")).toBe(false)
    expect(LocalPermissionStartup.take(original, "ses_target")).toBe(true)
  })
})
