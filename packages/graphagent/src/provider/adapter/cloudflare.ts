import type { AdapterContext, ProviderAdapter } from "./types"

export function CloudflareWorkersAdapter(_ctx: AdapterContext): ProviderAdapter {
  const prompts = !process.env.CLOUDFLARE_ACCOUNT_ID
    ? [
        {
          type: "text" as const,
          key: "accountId",
          message: "Enter your Cloudflare Account ID",
          placeholder: "e.g. 1234567890abcdef1234567890abcdef",
        },
      ]
    : []

  return {
    id: "cloudflare-workers-ai",
    auth: {
      provider: "cloudflare-workers-ai",
      methods: [
        {
          type: "api",
          label: "API key",
          prompts,
        },
      ],
    },
  }
}

export function CloudflareAIGatewayAdapter(_ctx: AdapterContext): ProviderAdapter {
  const prompts = [
    ...(!process.env.CLOUDFLARE_ACCOUNT_ID
      ? [
          {
            type: "text" as const,
            key: "accountId",
            message: "Enter your Cloudflare Account ID",
            placeholder: "e.g. 1234567890abcdef1234567890abcdef",
          },
        ]
      : []),
    ...(!process.env.CLOUDFLARE_GATEWAY_ID
      ? [
          {
            type: "text" as const,
            key: "gatewayId",
            message: "Enter your Cloudflare AI Gateway ID",
            placeholder: "e.g. my-gateway",
          },
        ]
      : []),
  ]

  return {
    id: "cloudflare-ai-gateway",
    auth: {
      provider: "cloudflare-ai-gateway",
      methods: [
        {
          type: "api",
          label: "Gateway API token",
          prompts,
        },
      ],
    },
    chatParams: async (input, output) => {
      if (input.model.providerID !== "cloudflare-ai-gateway") return
      // The unified gateway routes through @ai-sdk/openai-compatible, which
      // always emits max_tokens. OpenAI reasoning models (gpt-5.x, o-series)
      // reject that field and require max_completion_tokens instead, and the
      // compatible SDK has no way to rename it. Drop the cap so OpenAI falls
      // back to the model's default output budget.
      if (!input.model.api.id.toLowerCase().startsWith("openai/")) return
      if (!input.model.capabilities.reasoning) return
      output.maxOutputTokens = undefined
    },
  }
}
