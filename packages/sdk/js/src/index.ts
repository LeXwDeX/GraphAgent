export * from "./client.js"
export * from "./server.js"

import { createOpencodeClient } from "./client.js"
import { createGraphagentServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createGraphagent(options?: ServerOptions) {
  const server = await createGraphagentServer({
    ...options,
  })

  const client = createOpencodeClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
