import { describe, expect, mock, test, beforeEach } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"

// Negotiated protocol version reported by every MockClient; controlled per test.
let negotiatedVersion: string | undefined

class MockUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized")
    this.name = "UnauthorizedError"
  }
}

// Successful stdio transport: start() resolves, so connect() completes and a
// connected status is built — the seam this file exercises.
class MockStdioTransport {
  async start() {}
  async close() {}
}

// v2 packs Client, StreamableHTTPClientTransport, and UnauthorizedError into
// the single package root, so one mock.module covers the whole surface. The
// Client mock bridges connect() into the (succeeding) mock transport and
// reports the per-test negotiated version.
void mock.module("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: MockStdioTransport,
}))

void mock.module("@modelcontextprotocol/client", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    async start() {}
    async close() {}
  },
  UnauthorizedError: MockUnauthorizedError,
  Client: class MockClient {
    onclose: (() => void) | undefined
    setRequestHandler() {}
    setNotificationHandler() {}
    getServerCapabilities() {
      return undefined
    }
    getInstructions() {
      return undefined
    }
    getNegotiatedProtocolVersion() {
      return negotiatedVersion
    }
    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }
    async close() {}
  },
}))

beforeEach(() => {
  negotiatedVersion = undefined
})

// Import MCP after mocking
const { MCP } = await import("../../src/mcp/index")
const it = testEffect(MCP.defaultLayer)

describe("mcp.protocolEra derivation", () => {
  test("versions at or above the 2026-07-28 baseline are modern", () => {
    expect(MCP.protocolEra("2026-07-28")).toBe("modern")
    expect(MCP.protocolEra("2026-08-15")).toBe("modern")
    expect(MCP.protocolEra("2027-01-05")).toBe("modern")
  })

  test("2025-era versions are legacy", () => {
    expect(MCP.protocolEra("2025-06-18")).toBe("legacy")
    expect(MCP.protocolEra("2025-11-25")).toBe("legacy")
    expect(MCP.protocolEra("2026-07-27")).toBe("legacy")
  })
})

describe("mcp connected status era population", () => {
  it.instance(
    "modern negotiated version surfaces era and protocolVersion",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        negotiatedVersion = "2026-07-28"
        yield* mcp.add("era-modern", { type: "local", command: ["echo", "test"] })
        const statuses = yield* mcp.status()
        expect(statuses["era-modern"]).toEqual({
          status: "connected",
          era: "modern",
          protocolVersion: "2026-07-28",
        })
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "legacy negotiated version surfaces legacy era",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        negotiatedVersion = "2025-06-18"
        yield* mcp.add("era-legacy", { type: "local", command: ["echo", "test"] })
        const statuses = yield* mcp.status()
        expect(statuses["era-legacy"]).toEqual({
          status: "connected",
          era: "legacy",
          protocolVersion: "2025-06-18",
        })
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "undefined negotiated version omits both fields",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("era-unreported", { type: "local", command: ["echo", "test"] })
        const statuses = yield* mcp.status()
        expect(statuses["era-unreported"]).toEqual({ status: "connected" })
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "status endpoint reflects the stored era fields",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        negotiatedVersion = "2026-07-28"
        yield* mcp.add("era-status", { type: "local", command: ["echo", "test"] })
        const statuses = yield* mcp.status()
        expect(statuses["era-status"]?.status).toBe("connected")
        expect(statuses["era-status"]).toMatchObject({ era: "modern", protocolVersion: "2026-07-28" })
      }),
    { config: { mcp: {} } },
  )
})
