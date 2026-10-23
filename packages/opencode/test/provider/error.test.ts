import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderError } from "@/provider/error"

function wrappedSuccessResponse(cause: unknown) {
  return new APICallError({
    message: "Failed to process successful response",
    url: "https://example.com/v1/responses",
    requestBodyValues: {},
    statusCode: 200,
    responseHeaders: { "content-type": "text/event-stream" },
    cause,
  })
}

function apiCallError(options: {
  message: string
  statusCode: number
  isRetryable: boolean
  responseBody?: string
  responseHeaders?: Record<string, string>
  cause?: unknown
}) {
  return new APICallError({
    message: options.message,
    url: "https://example.com/v1/responses",
    requestBodyValues: {},
    statusCode: options.statusCode,
    responseHeaders: options.responseHeaders ?? { "content-type": "application/json", "x-request-id": "req_test" },
    responseBody: options.responseBody,
    cause: options.cause,
    isRetryable: options.isRetryable,
  })
}

describe("provider API call errors", () => {
  test("preserves a nested non-retryable provider error through the SDK success-stream wrapper", () => {
    const body = JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } })
    const inner = apiCallError({
      message: "bad request",
      statusCode: 400,
      isRetryable: false,
      responseBody: body,
    })

    expect(
      ProviderError.parseAPICallError({
        providerID: ProviderV2.ID.make("relay"),
        error: wrappedSuccessResponse(inner),
      }),
    ).toEqual({
      type: "api_error",
      message: "bad request",
      statusCode: 400,
      isRetryable: false,
      responseHeaders: inner.responseHeaders,
      responseBody: body,
      metadata: { url: inner.url },
    })
  })

  test("preserves nested retryable 429 and 503 provider errors", () => {
    for (const statusCode of [429, 503]) {
      const inner = apiCallError({
        message: `${statusCode} status code (no body)`,
        statusCode,
        isRetryable: true,
      })

      expect(
        ProviderError.parseAPICallError({
          providerID: ProviderV2.ID.make("relay"),
          error: wrappedSuccessResponse(inner),
        }),
      ).toEqual({
        type: "api_error",
        message: `${statusCode} status code (no body)`,
        statusCode,
        isRetryable: true,
        responseHeaders: inner.responseHeaders,
        responseBody: undefined,
        metadata: { url: inner.url },
      })
    }
  })

  test("turns a wrapped transport failure into a retryable error with its cause message", () => {
    const streamError = new ProviderError.ResponseStreamError(
      "WebSocket closed before response.completed (code 1011)",
      { kind: "close", closeCode: 1011, closeReason: "upstream interrupted" },
    )

    expect(
      ProviderError.parseAPICallError({
        providerID: ProviderV2.ID.make("relay"),
        error: wrappedSuccessResponse(streamError),
      }),
    ).toEqual({
      type: "api_error",
      message: streamError.message,
      isRetryable: true,
      metadata: {
        code: streamError.name,
        kind: "close",
        closeCode: "1011",
        closeReason: "upstream interrupted",
      },
    })
  })

  test("classifies transport failures by their structured kind and close code", () => {
    const cases = [
      { options: { kind: "socket-error" as const }, retryable: true },
      { options: { kind: "idle-timeout" as const }, retryable: true },
      { options: { kind: "connection-limit" as const }, retryable: true },
      { options: { kind: "close" as const, closeCode: 1006 }, retryable: true },
      { options: { kind: "close" as const, closeCode: 1011 }, retryable: true },
      { options: { kind: "close" as const, closeCode: 1001 }, retryable: true },
      { options: { kind: "close" as const, closeCode: 1009 }, retryable: false },
      { options: { kind: "close" as const, closeCode: 1000 }, retryable: false },
      { options: { kind: "close" as const }, retryable: false },
      { options: { kind: "protocol-error" as const }, retryable: false },
    ]

    for (const item of cases) {
      const error = new ProviderError.ResponseStreamError(`transport ${item.options.kind}`, item.options)
      expect(ProviderError.isRetryableResponseStreamError(error)).toBe(item.retryable)
      const parsed = ProviderError.parseAPICallError({
        providerID: ProviderV2.ID.make("relay"),
        error: wrappedSuccessResponse(error),
      })
      expect(parsed.type).toBe("api_error")
      if (parsed.type !== "api_error") throw new Error("Expected api_error")
      expect(parsed.isRetryable).toBe(item.retryable)
    }
  })

  test("uses a plain cause message and drops the misleading status for the generic wrapper", () => {
    const wrapped = wrappedSuccessResponse(new TypeError("terminated"))
    const parsed = ProviderError.parseAPICallError({
      providerID: ProviderV2.ID.make("relay"),
      error: wrapped,
    })

    expect(parsed).toEqual({
      type: "api_error",
      message: "terminated",
      statusCode: undefined,
      isRetryable: false,
      responseHeaders: undefined,
      responseBody: undefined,
      metadata: { url: wrapped.url },
    })
  })

  test("keeps a plain cause message without a generic wrapper untouched", () => {
    const error = apiCallError({
      message: "provider rejected the request",
      statusCode: 400,
      isRetryable: false,
      responseBody: '{"error":{"message":"bad request"}}',
      cause: new TypeError("terminated"),
    })

    expect(
      ProviderError.parseAPICallError({
        providerID: ProviderV2.ID.make("relay"),
        error,
      }),
    ).toEqual({
      type: "api_error",
      message: "provider rejected the request",
      statusCode: 400,
      isRetryable: false,
      responseHeaders: error.responseHeaders,
      responseBody: error.responseBody,
      metadata: { url: error.url },
    })
  })

  test("does not unwrap a specific API error that has the same cause", () => {
    const specific = apiCallError({
      message: "provider rejected the request",
      statusCode: 200,
      isRetryable: false,
      cause: new ProviderError.ResponseStreamError("transport failed"),
    })

    expect(
      ProviderError.parseAPICallError({
        providerID: ProviderV2.ID.make("relay"),
        error: specific,
      }),
    ).toEqual({
      type: "api_error",
      message: "provider rejected the request",
      statusCode: 200,
      isRetryable: false,
      responseHeaders: specific.responseHeaders,
      responseBody: undefined,
      metadata: { url: specific.url },
    })
  })
})

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
