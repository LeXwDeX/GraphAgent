import "../../../../src/cli/tui/worker-console"
import "./worker-import-warning"
import { generateText } from "ai"

await generateText({
  model: {
    specificationVersion: "v3",
    provider: "audit",
    modelId: "audit",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("intentional fixture completion")
    },
    doStream: async () => {
      throw new Error("unused")
    },
  },
  maxRetries: 0,
  messages: [
    { role: "system", content: "trusted fixture" },
    { role: "user", content: "hello" },
  ],
}).catch(() => {})
console.info("worker-info-marker")
console.debug("worker-debug-marker")
console.error("worker-error-marker")
postMessage("done")
