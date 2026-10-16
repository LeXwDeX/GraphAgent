import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

cliIt.live("legacy upgrade exits nonzero with manual installation guidance", ({ opencode }) =>
  Effect.gen(function* () {
    const result = yield* opencode.spawn(["upgrade", "99.0.0", "--method", "curl"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Built-in application updates are disabled")
    expect(result.stderr).toContain("Install releases manually")
  }),
)
