// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// `models --verbose` prints the resolved model. Secrets that the configuration puts under `options` or `headers`
// must not reach the terminal, and nothing else in the printed model may change.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

describe("graphagent models --verbose", () => {
  cliIt.live(
    "masks secrets under options and headers and keeps everything else",
    ({ graphagent, llm }) =>
      Effect.gen(function* () {
        const base = testProviderConfig(llm.url)
        const declared = base.provider.test.models["test-model"]
        const config = {
          ...base,
          provider: {
            test: {
              ...base.provider.test,
              models: {
                "test-model": {
                  ...declared,
                  options: { apiKey: "opt-secret", max_tokens: 1234, nested: { accessToken: "nested-secret" } },
                  headers: { Authorization: "Bearer header-secret", "X-Org": "acme-org" },
                },
              },
            },
          },
        }

        const result = yield* graphagent.spawn(["models", "test", "--verbose"], {
          env: { GRAPHAGENT_CONFIG_CONTENT: JSON.stringify(config) },
        })
        graphagent.expectExit(result, 0, "models test --verbose")

        expect(result.stdout).not.toContain("opt-secret")
        expect(result.stdout).not.toContain("nested-secret")
        expect(result.stdout).not.toContain("header-secret")
        expect(result.stdout).not.toContain("acme-org")
        expect(result.stdout).toContain("[redacted]")

        // The rest of the printed model is the declared one: first the id line, then the model JSON.
        const [idLine, ...rest] = result.stdout.trimEnd().split("\n")
        expect(idLine).toBe("test/test-model")
        const printed = JSON.parse(rest.join("\n"))
        expect(printed.options).toEqual({
          apiKey: "[redacted]",
          max_tokens: 1234,
          nested: { accessToken: "[redacted]" },
        })
        expect(printed.headers).toEqual({ Authorization: "[redacted]", "X-Org": "[redacted]" })
        expect(printed.id).toBe("test-model")
        expect(printed.api.npm).toBe("@ai-sdk/openai-compatible")
        expect(printed.limit).toEqual({ context: 100_000, output: 10_000 })
      }),
    60_000,
  )
})
