import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Server } from "../../src/server/server"
import { Global } from "@opencode-ai/core/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { Effect } from "effect"
import { pollWithTimeout } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("reference HttpApi", () => {
  test("lists usable references resolved in the server workspace", async () => {
    await using source = await tmpdir({ git: true })
    await $`git branch -M main`.cwd(source.path).quiet()
    await using remote = await tmpdir()
    await mkdir(path.join(remote.path, "Effect-TS"), { recursive: true })
    await $`git clone --bare ${source.path} ${path.join(remote.path, "Effect-TS", "effect.git")}`.quiet()

    const previous = process.env.GRAPHAGENT_REPO_CLONE_GITHUB_BASE_URL
    process.env.GRAPHAGENT_REPO_CLONE_GITHUB_BASE_URL = pathToFileURL(remote.path).href
    try {
      await using tmp = await tmpdir({
        config: {
          formatter: false,
          lsp: false,
          references: {
            docs: "./docs",
            effect: { repository: "Effect-TS/effect", branch: "main" },
            bad: "not-a-repo",
          },
        },
      })

      const expected = ["docs", "effect"]
      let observed: string[] = []
      const body = await Effect.runPromise(
        pollWithTimeout(
          Effect.promise(async () => {
            const response = await Server.Default().app.request("/api/reference", {
              headers: { "x-opencode-directory": tmp.path },
            })
            expect(response.status).toBe(200)
            const body = await response.json()
            observed = body.data.map((item: { name: string }) => item.name)
            return expected.every((name) => observed.includes(name)) ? body : undefined
          }),
          () =>
            `references were not loaded; observed=${observed.join(",") || "<none>"} missing=${expected.filter((name) => !observed.includes(name)).join(",") || "<none>"}`,
        ),
      )
      expect(body).toMatchObject({ location: { directory: tmp.path } })
      expect(body.data).toEqual([
        {
          name: "docs",
          path: path.join(tmp.path, "docs"),
          description: null,
          hidden: null,
          source: {
            type: "local",
            path: path.join(tmp.path, "docs"),
            description: null,
            hidden: null,
          },
        },
        {
          name: "effect",
          path: path.join(Global.Path.repos, "github.com", "Effect-TS", "effect"),
          description: null,
          hidden: null,
          source: {
            type: "git",
            repository: "Effect-TS/effect",
            branch: "main",
            description: null,
            hidden: null,
          },
        },
      ])
    } finally {
      if (previous !== undefined) process.env.GRAPHAGENT_REPO_CLONE_GITHUB_BASE_URL = previous
      else delete process.env.GRAPHAGENT_REPO_CLONE_GITHUB_BASE_URL
    }
  })
})
