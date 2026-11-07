import { expect, test } from "bun:test"
import { createPluginRuntime } from "../../src/plugin/runtime"

test("routes use the latest registration and restore previous registrations", () => {
  const runtime = createPluginRuntime()
  const first = () => "first"
  const second = () => "second"
  runtime.routes.register([{ name: "demo", render: first }])
  const dispose = runtime.routes.register([{ name: "demo", render: second }])

  expect(runtime.routes.get("demo")).toBe(second)
  dispose()
  expect(runtime.routes.get("demo")).toBe(first)
})
