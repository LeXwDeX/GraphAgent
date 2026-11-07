import { describe, expect, mock, test, beforeEach } from "bun:test"
import { Effect, Schema } from "effect"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { testEffect } from "../lib/effect"

// Captures the options passed to each Client constructor
const clientOptions: Array<{ capabilities?: unknown; versionNegotiation?: { mode?: unknown } }> = []

class MockUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized")
    this.name = "UnauthorizedError"
  }
}

class MockStdioTransport {
  async start() {
    throw new Error("Mock transport cannot connect")
  }
  async close() {}
}

// v2 packs Client, StreamableHTTPClientTransport, and UnauthorizedError into
// the single package root, so one mock.module covers the whole surface. The
// Client mock records constructor options and bridges connect() into the
// (throwing) mock transports — enough to assert how config maps to
// versionNegotiation without a real server.
void mock.module("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: MockStdioTransport,
}))

void mock.module("@modelcontextprotocol/client", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    async start() {
      throw new Error("Mock transport cannot connect")
    }
    async close() {}
  },
  UnauthorizedError: MockUnauthorizedError,
  Client: class MockClient {
    constructor(_info: unknown, options?: { capabilities?: unknown; versionNegotiation?: { mode?: unknown } }) {
      clientOptions.push(options ?? {})
    }
    setRequestHandler() {}
    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }
    async close() {}
  },
}))

beforeEach(() => {
  clientOptions.length = 0
})

// Import MCP after mocking
const { MCP } = await import("../../src/mcp/index")
const it = testEffect(MCP.defaultLayer)

describe("mcp.protocol config parsing", () => {
  test("accepts auto, legacy, and modern on local and remote entries", () => {
    for (const protocol of ["auto", "legacy", "modern"] as const) {
      const local = Schema.decodeUnknownSync(ConfigMCPV1.Info)({
        type: "local",
        command: ["echo", "test"],
        protocol,
      })
      expect(local.protocol).toBe(protocol)

      const remote = Schema.decodeUnknownSync(ConfigMCPV1.Info)({
        type: "remote",
        url: "https://example.com/mcp",
        protocol,
      })
      expect(remote.protocol).toBe(protocol)
    }
  })

  test("protocol is optional and stays undefined when absent (auto is applied at client construction)", () => {
    const local = Schema.decodeUnknownSync(ConfigMCPV1.Info)({ type: "local", command: ["echo", "test"] })
    expect(local.protocol).toBeUndefined()

    const remote = Schema.decodeUnknownSync(ConfigMCPV1.Info)({ type: "remote", url: "https://example.com/mcp" })
    expect(remote.protocol).toBeUndefined()
  })

  test("rejects unrecognized protocol values", () => {
    expect(() =>
      Schema.decodeUnknownSync(ConfigMCPV1.Info)({ type: "local", command: ["echo", "test"], protocol: "2025" }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ConfigMCPV1.Info)({
        type: "remote",
        url: "https://example.com/mcp",
        protocol: "auto-modern",
      }),
    ).toThrow()
  })
})

describe("mcp.versionNegotiation mapping", () => {
  it.instance(
    "undefined protocol negotiates auto (probe with fallback)",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("auto-default", { type: "remote", url: "https://example.com/mcp" }).pipe(
          Effect.catch(() => Effect.void),
        )

        expect(clientOptions.length).toBe(1)
        expect(clientOptions[0].versionNegotiation).toEqual({ mode: "auto" })
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "protocol auto negotiates auto",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("auto-explicit", {
          type: "remote",
          url: "https://example.com/mcp",
          protocol: "auto",
        }).pipe(Effect.catch(() => Effect.void))

        expect(clientOptions.length).toBe(1)
        expect(clientOptions[0].versionNegotiation).toEqual({ mode: "auto" })
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "protocol legacy skips the probe and runs the 2025 initialize handshake",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("legacy-server", {
          type: "remote",
          url: "https://example.com/mcp",
          protocol: "legacy",
        }).pipe(Effect.catch(() => Effect.void))

        expect(clientOptions.length).toBe(1)
        expect(clientOptions[0].versionNegotiation).toEqual({ mode: "legacy" })
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "protocol modern pins 2026-07-28 with no fallback",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("modern-server", {
          type: "remote",
          url: "https://example.com/mcp",
          protocol: "modern",
        }).pipe(Effect.catch(() => Effect.void))

        expect(clientOptions.length).toBe(1)
        expect(clientOptions[0].versionNegotiation).toEqual({ mode: { pin: "2026-07-28" } })
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "local entries map protocol the same way",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("modern-local", {
          type: "local",
          command: ["echo", "test"],
          protocol: "modern",
        }).pipe(Effect.catch(() => Effect.void))

        expect(clientOptions.length).toBe(1)
        expect(clientOptions[0].versionNegotiation).toEqual({ mode: { pin: "2026-07-28" } })
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "client capabilities stay elicitation + roots regardless of protocol",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("caps-server", {
          type: "remote",
          url: "https://example.com/mcp",
          protocol: "legacy",
        }).pipe(Effect.catch(() => Effect.void))

        expect(clientOptions.length).toBe(1)
        expect(clientOptions[0].capabilities).toEqual({ elicitation: {}, roots: {} })
      }),
    { config: { mcp: {} } },
  )
})
