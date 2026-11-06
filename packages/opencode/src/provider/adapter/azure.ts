import type { AdapterContext, ProviderAdapter } from "./types"

export function AzureAdapter(_ctx: AdapterContext): ProviderAdapter {
  const prompts = []
  if (!process.env.AZURE_RESOURCE_NAME) {
    prompts.push({
      type: "text" as const,
      key: "resourceName",
      message: "Enter Azure Resource Name",
      placeholder: "e.g. my-models",
    })
  }

  return {
    id: "azure",
    auth: {
      provider: "azure",
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
