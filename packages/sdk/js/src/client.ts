export * from "./gen/types.gen.js"
export type { FileSystemEntry as LocationFileSystemEntry } from "./gen/types.gen.js"

import { createClient as createFetchClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { Client } from "./gen/sdk.gen.js"
import { wrapClientError } from "./error-interceptor.js"
export { type Config as ClientConfig, Client }

export function createClient(config?: Config & { directory?: string; experimental_workspaceID?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-graphagent-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-graphagent-workspace": config.experimental_workspaceID,
    }
  }

  const client = createFetchClient(config)
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of GraphAgent Server (Server responded with text/html)")

    return response
  })
  client.interceptors.error.use(wrapClientError)
  return new Client({ client })
}
