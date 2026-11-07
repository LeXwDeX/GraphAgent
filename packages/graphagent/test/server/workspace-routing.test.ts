import { describe, expect, test } from "bun:test"
import { isLocalWorkspaceRoute, getWorkspaceRouteSessionID } from "../../src/server/shared/workspace-routing"
import { SessionID } from "../../src/session/schema"

describe("isLocalWorkspaceRoute", () => {
  test("GET /session is local", () => {
    expect(isLocalWorkspaceRoute("GET", "/session")).toBe(true)
  })

  test("GET /session/ses_abc is local (prefix match)", () => {
    expect(isLocalWorkspaceRoute("GET", "/session/ses_abc")).toBe(true)
  })

  test("POST /session is not local (method mismatch)", () => {
    expect(isLocalWorkspaceRoute("POST", "/session")).toBe(false)
  })

  test("/session/status is forwarded regardless of method", () => {
    expect(isLocalWorkspaceRoute("GET", "/session/status")).toBe(false)
    expect(isLocalWorkspaceRoute("POST", "/session/status")).toBe(false)
  })

  test("unrecognized paths are not local", () => {
    expect(isLocalWorkspaceRoute("GET", "/config")).toBe(false)
    expect(isLocalWorkspaceRoute("POST", "/session/ses_abc/message")).toBe(false)
  })
})

describe("getWorkspaceRouteSessionID", () => {
  test("extracts session ID from path", () => {
    const url = new URL("http://localhost/session/ses_abc123/message")
    expect(getWorkspaceRouteSessionID(url)).toBe(SessionID.make("ses_abc123"))
  })

  test("extracts session ID without trailing path", () => {
    const url = new URL("http://localhost/session/ses_xyz")
    expect(getWorkspaceRouteSessionID(url)).toBe(SessionID.make("ses_xyz"))
  })

  test("extracts session ID from experimental background path", () => {
    const url = new URL("http://localhost/experimental/session/ses_bg/background")
    expect(getWorkspaceRouteSessionID(url)).toBe(SessionID.make("ses_bg"))
  })

  test("returns null for /session/status", () => {
    const url = new URL("http://localhost/session/status")
    expect(getWorkspaceRouteSessionID(url)).toBeNull()
  })

  test("returns null for non-session paths", () => {
    const url = new URL("http://localhost/config")
    expect(getWorkspaceRouteSessionID(url)).toBeNull()
  })

  test("returns null for bare /session path", () => {
    const url = new URL("http://localhost/session")
    expect(getWorkspaceRouteSessionID(url)).toBeNull()
  })
})

