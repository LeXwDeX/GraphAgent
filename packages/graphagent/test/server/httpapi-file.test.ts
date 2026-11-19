import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { Context, Effect, Schema } from "effect"
import fs from "fs/promises"
import path from "path"
import { Vcs } from "../../src/project/vcs"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-graphagent-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    // hello.txt is untracked: a git status lists it as added.
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([{ path: "hello.txt", added: 1, removed: 0, status: "added" }])
  })

  // #1552: /file/status answered [] whatever the working tree held.
  test("reports the working-tree changes of /vcs/status under its declared field names", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "keep.txt"), "one\ntwo\n")
    await Bun.write(path.join(tmp.path, "gone.txt"), "bye\n")
    await $`git add -A`.cwd(tmp.path).quiet()
    await $`git commit -m seed`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "keep.txt"), "one\nTWO\nthree\n")
    await fs.rm(path.join(tmp.path, "gone.txt"))
    await Bun.write(path.join(tmp.path, "new.txt"), "a\nb\nc\n")

    const [status, vcs] = await Promise.all([request(FilePaths.status, tmp.path), request("/vcs/status", tmp.path)])

    expect(status.status).toBe(200)
    expect(vcs.status).toBe(200)
    const entries = await status.json()
    expect(entries).toEqual([
      { path: "gone.txt", added: 0, removed: 1, status: "deleted" },
      { path: "keep.txt", added: 2, removed: 1, status: "modified" },
      { path: "new.txt", added: 3, removed: 0, status: "added" },
    ])
    const files = Schema.decodeUnknownSync(Schema.Array(Vcs.FileStatus))(await vcs.json())
    expect(
      files.map((item) => ({ path: item.file, added: item.additions, removed: item.deletions, status: item.status })),
    ).toEqual(entries)
  })

  test("reports no status for a clean tree or a directory outside git", async () => {
    await using clean = await tmpdir({ git: true })
    await using plain = await tmpdir()
    await Bun.write(path.join(plain.path, "hello.txt"), "hello")

    const [cleanStatus, plainStatus] = await Promise.all([
      request(FilePaths.status, clean.path),
      request(FilePaths.status, plain.path),
    ])

    expect(cleanStatus.status).toBe(200)
    expect(await cleanStatus.json()).toEqual([])
    expect(plainStatus.status).toBe(200)
    expect(await plainStatus.json()).toEqual([])
  })

  test("marks a truncated long line in findText", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "lines.txt"), ["needle short", `needle${"a".repeat(2_500)}`].join("\n"))

    const response = await request(FilePaths.findText, tmp.path, { pattern: "needle" })

    expect(response.status).toBe(200)
    const lines = (await response.json()) as Array<{ line_number: number; lines: { text: string } }>
    const short = lines.find((line) => line.line_number === 1)
    const long = lines.find((line) => line.line_number === 2)

    expect(short?.lines.text.endsWith("...")).toBe(false)
    expect(long?.lines.text).toHaveLength(2_003)
    expect(long?.lines.text.startsWith("needle")).toBe(true)
    expect(long?.lines.text.endsWith("...")).toBe(true)
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])
    const files = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" })
          const body = await response.json()
          return body.some((item: { path: string }) => item.path === "hello.txt") ? { response, body } : undefined
        }),
        "file search index was not ready",
      ),
    )

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.response.status).toBe(200)
    expect(files.body).toContainEqual({ path: "hello.txt", type: "file" })

    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])
  })
})
