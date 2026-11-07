import path from "node:path"
import { describe, expect, test } from "bun:test"

describe("mcp session recovery", () => {
  test("session-bound POST returning 404 surfaces a typed transport error (v2 removed auto session recovery)", async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixture/mcp-session-recovery.ts")], {
      cwd: path.join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      Bun.readableStreamToText(child.stdout),
      Bun.readableStreamToText(child.stderr),
    ])

    expect(code, stderr).toBe(0)
    // v1's StreamableHTTPClientTransport transparently re-initialized a fresh
    // session and retried once on 404. v2 removed that recovery: the ping
    // rejects with SdkHttpError and no second initialize is attempted.
    expect(JSON.parse(stdout)).toEqual({
      posts: [
        { method: "initialize", session: null },
        { method: "notifications/initialized", session: "expired" },
        { method: "ping", session: "expired" },
      ],
      error: { name: "SdkHttpError", code: "CLIENT_HTTP_NOT_IMPLEMENTED", status: 404 },
    })
  })
})
