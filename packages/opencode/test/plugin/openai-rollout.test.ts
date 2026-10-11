import { describe, expect, test } from "bun:test"
import { experimentalWebSocketsEnabled } from "../../src/plugin"

describe("plugin.openai.websocket rollout", () => {
  test("enables websockets by default only on pre-release channels", () => {
    expect(experimentalWebSocketsEnabled({ enabled: false, channel: "local" })).toBe(true)
    expect(experimentalWebSocketsEnabled({ enabled: false, channel: "dev" })).toBe(true)
    expect(experimentalWebSocketsEnabled({ enabled: false, channel: "beta" })).toBe(true)
    expect(experimentalWebSocketsEnabled({ enabled: false, channel: "latest" })).toBe(false)
    expect(experimentalWebSocketsEnabled({ enabled: false, channel: "prod" })).toBe(false)
  })

  test("allows releases to opt in through the experimental flag", () => {
    expect(experimentalWebSocketsEnabled({ enabled: true, channel: "latest" })).toBe(true)
    expect(experimentalWebSocketsEnabled({ enabled: true, channel: "prod" })).toBe(true)
  })

  test("explicit provider configuration overrides the flag and channel defaults", () => {
    expect(experimentalWebSocketsEnabled({ enabled: false, channel: "latest", configured: true })).toBe(true)
    expect(experimentalWebSocketsEnabled({ enabled: true, channel: "latest", configured: false })).toBe(false)
    expect(experimentalWebSocketsEnabled({ enabled: false, channel: "local", configured: false })).toBe(false)
  })
})
