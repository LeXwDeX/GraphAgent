import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"
import { repositoryToken } from "../src/github-token"

test("Octokit sends a repository restriction in the installation token request", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  let sent: Record<string, unknown> | undefined
  let endpoint: string | undefined
  const client = new Octokit({
    request: {
      fetch: async (url: string | URL | Request, options?: RequestInit) => {
        endpoint = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
        if (typeof options?.body !== "string") throw new Error("Expected a JSON request body")
        sent = JSON.parse(options.body)
        return Response.json({
          token: "synthetic-token",
          expires_at: "2099-01-01T00:00:00Z",
          permissions: {},
          repository_selection: "selected",
          repositories: [{ id: 42, name: "authorized-repo" }],
        })
      },
    },
  })
  const auth = createAppAuth({
    appId: 1,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    request: client.request,
  })
  const token = await repositoryToken(auth, 123, "authorized-repo")
  expect(token.token).toBe("synthetic-token")
  expect(endpoint).toBe("https://api.github.com/app/installations/123/access_tokens")
  expect(sent?.repositories).toEqual(["authorized-repo"])
})
