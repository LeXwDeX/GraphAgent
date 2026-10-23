import { describe, expect, test } from "bun:test"
import { ProviderError } from "@/provider/error"

describe("provider stream errors", () => {
  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })

  test("classifies rejected reasoning state as one actionable non-retryable error", () => {
    const cases = [
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_encrypted_content",
          message: "The encrypted content gAAA could not be verified.",
        },
      },
      {
        type: "error",
        error: {
          message: "Encrypted content could not be decrypted or parsed.",
        },
      },
      {
        type: "error",
        error: {
          message: "messages.1.content.0: Invalid signature in thinking block",
        },
      },
    ]

    for (const input of cases) {
      const parsed = ProviderError.parseStreamError(input)
      expect(parsed).toEqual({
        type: "api_error",
        message: ProviderError.REASONING_STATE_MESSAGE,
        isRetryable: false,
        responseBody: JSON.stringify(input),
      })
    }
    expect(ProviderError.REASONING_STATE_MESSAGE).toContain("/compact")
    expect(ProviderError.REASONING_STATE_MESSAGE).toContain("new session")
  })

  test("recognizes the invalid_encrypted_content code when the message is generic", () => {
    const input = { type: "error", error: { code: "invalid_encrypted_content", message: "Bad request" } }

    expect(ProviderError.parseStreamError(input)).toEqual({
      type: "api_error",
      message: ProviderError.REASONING_STATE_MESSAGE,
      isRetryable: false,
      responseBody: JSON.stringify(input),
    })
  })

  test("does not classify unrelated encrypted storage or authentication failures", () => {
    for (const message of ["Failed to decrypt encrypted authentication token", "Cannot open encrypted file"]) {
      const input = { type: "error", error: { message } }

      expect(ProviderError.parseStreamError(input)).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify(input),
      })
    }
  })

  test("keeps raw reasoning-state string bodies instead of dropping them", () => {
    const cases = [
      "invalid_encrypted_content",
      "The encrypted content could not be verified.",
      JSON.stringify({ type: "error", error: { code: "invalid_encrypted_content", message: "Bad request" } }),
    ]

    for (const input of cases) {
      expect(ProviderError.parseStreamError(input)).toEqual({
        type: "api_error",
        message: ProviderError.REASONING_STATE_MESSAGE,
        isRetryable: false,
        responseBody: input,
      })
    }
  })

  test("keeps unrelated authentication signature errors retryable", () => {
    const input = {
      type: "error",
      error: {
        message:
          "The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.",
      },
    }

    expect(ProviderError.parseStreamError(input)).toEqual({
      type: "api_error",
      message: input.error.message,
      isRetryable: true,
      responseBody: JSON.stringify(input),
    })
  })
})
