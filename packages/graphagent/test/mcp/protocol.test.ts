// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, mock, test, beforeEach } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { McpConfig } from "../../src/mcp/config"

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

// ConfigInvalidError carries its user-facing text in `data.message`; its
// Error.message is just the tag name.
function decodeError(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    const message = (error as { data?: { message?: string } }).data?.message
    return message ?? (error instanceof Error ? error.message : String(error))
  }
  throw new Error("expected decodeDocument to throw")
}

// Import MCP after mocking
const { MCP } = await import("../../src/mcp/index")
const it = testEffect(MCP.defaultLayer)

describe("mcp.json decoding", () => {
  test("accepts entries under mcpServers with split timeouts and disabled", () => {
    const servers = McpConfig.decodeDocument(
      JSON.stringify({
        mcpServers: {
          local: { type: "local", command: ["echo", "test"], disabled: true, timeout: { startup: 1000 } },
          remote: {
            type: "remote",
            url: "https://example.com/mcp",
            oauth: { client_id: "id", client_secret: "secret", callback_port: 19876 },
            timeout: { request: 2000 },
          },
        },
      }),
      "mcp.json",
    )
    expect(servers.local).toMatchObject({ type: "local", disabled: true, timeout: { startup: 1000 } })
    expect(servers.remote).toMatchObject({ type: "remote", timeout: { request: 2000 } })
  })

  test("rejects the removed protocol field instead of negotiating it", () => {
    for (const type of ["local", "remote"] as const) {
      expect(
        decodeError(() =>
          McpConfig.decodeDocument(
            JSON.stringify({
              mcpServers: {
                server:
                  type === "local"
                    ? { type, command: ["echo", "test"], protocol: "legacy" }
                    : { type, url: "https://example.com/mcp", protocol: "modern" },
              },
            }),
            "mcp.json",
          ),
        ),
      ).toMatch(/protocol negotiation is automatic/)
    }
  })

  test("rejects the removed enabled field and points at disabled", () => {
    expect(
      decodeError(() =>
        McpConfig.decodeDocument(
          JSON.stringify({ mcpServers: { server: { type: "local", command: ["echo", "test"], enabled: false } } }),
          "mcp.json",
        ),
      ),
    ).toMatch(/use "disabled": true/)
  })

  test("rejects the V1 top-level shape and extra top-level keys", () => {
    expect(
      decodeError(() =>
        McpConfig.decodeDocument(
          JSON.stringify({ server: { type: "local", command: ["echo", "test"] } }),
          "mcp.json",
        ),
      ),
    ).toMatch(/removed V1 shape/)
    expect(
      decodeError(() => McpConfig.decodeDocument(JSON.stringify({ mcpServers: {}, servers: {} }), "mcp.json")),
    ).toMatch(/only accepts "mcpServers"/)
  })
})

describe("mcp.versionNegotiation", () => {
  it.instance(
    "remote entries always negotiate automatically",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("auto-remote", { type: "remote", url: "https://example.com/mcp" }).pipe(
          Effect.catch(() => Effect.void),
        )

        expect(clientOptions.length).toBe(1)
        expect(clientOptions[0].versionNegotiation).toEqual({ mode: "auto" })
      }),
    { mcp: {} },
  )

  it.instance(
    "local entries use the same automatic negotiation",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("auto-local", { type: "local", command: ["echo", "test"] }).pipe(
          Effect.catch(() => Effect.void),
        )

        expect(clientOptions.length).toBe(1)
        expect(clientOptions[0].versionNegotiation).toEqual({ mode: "auto" })
      }),
    { mcp: {} },
  )

  it.instance(
    "client capabilities stay elicitation + roots",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("caps-server", { type: "remote", url: "https://example.com/mcp" }).pipe(
          Effect.catch(() => Effect.void),
        )

        expect(clientOptions.length).toBe(1)
        expect(clientOptions[0].capabilities).toEqual({ elicitation: {}, roots: {} })
      }),
    { mcp: {} },
  )
})