import { describe, expect, test } from "bun:test"
import { normalizeCustomProviderID, sortedProviders } from "../../../../src/panel/provider"

describe("sortedProviders", () => {
  test("keeps popular providers first and sorts the rest alphabetically", () => {
    expect(
      sortedProviders([
        { id: "openai", name: "OpenAI" },
        { id: "custom-z", name: "Zebra Provider" },
        { id: "anthropic", name: "Anthropic" },
        { id: "mistral", name: "Mistral" },
        { id: "aws", name: "AWS Bedrock" },
      ]).map((provider) => provider.id),
    ).toEqual(["openai", "anthropic", "aws", "mistral", "custom-z"])
  })

  test("falls back to the provider id when names collide", () => {
    expect(
      sortedProviders([
        { id: "zeta", name: "Same" },
        { id: "alpha", name: "Same" },
      ]).map((provider) => provider.id),
    ).toEqual(["alpha", "zeta"])
  })
})

describe("normalizeCustomProviderID", () => {
  test("normalizes and validates custom provider ids", () => {
    expect(normalizeCustomProviderID("  custom-provider  ")).toBe("custom-provider")
    expect(normalizeCustomProviderID("custom_provider")).toBe("custom_provider")
    expect(normalizeCustomProviderID("@ai-sdk/custom-provider")).toBe("custom-provider")
    expect(normalizeCustomProviderID("-custom-provider")).toBeUndefined()
    expect(normalizeCustomProviderID("Custom Provider")).toBeUndefined()
  })
})
