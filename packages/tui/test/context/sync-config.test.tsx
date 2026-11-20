// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk"
import { directory, json, mount, wait } from "../cli/cmd/tui/sync-fixture"
import { tmpdir } from "../fixture/fixture"

// #1678: a global write to `permission` / `permissions` keeps the server's instances (no `server.instance.disposed`,
// so no bootstrap), and the merged configuration the `/config` panel shows must follow it. The hot-read notice
// (`config.updated`, which names the changed top-level keys) is what makes the sync layer read it again; other keys
// cost no request, and `sync.config.refresh()` is the same read on demand.

let sequence = 0
function configUpdated(keys: string[]): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_config_${++sequence}`, type: "config.updated", properties: { keys } },
  } as GlobalEvent
}

/** The rule held for `edit`, whichever spelling the configuration used. */
function editRule(config: { permission?: unknown }): unknown {
  const permission = config.permission
  return typeof permission === "object" && permission !== null && "edit" in permission ? permission.edit : undefined
}

/** A server whose `GET /config` answer the test chooses, and whose reads it counts. */
function serveConfig(initial: Record<string, unknown>) {
  const server = {
    answer: (): Response | Promise<Response> => json(initial),
    reads: 0,
    handler: (url: URL): Response | Promise<Response> | undefined => {
      if (url.pathname !== "/config") return undefined
      server.reads += 1
      return server.answer()
    },
  }
  return server
}

async function withConfig(
  initial: Record<string, unknown>,
  run: (ctx: Awaited<ReturnType<typeof mount>> & { server: ReturnType<typeof serveConfig> }) => Promise<void>,
) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const server = serveConfig(initial)
  const ctx = await mount(server.handler, tmp.path)
  try {
    await run({ ...ctx, server })
  } finally {
    ctx.app.renderer.destroy()
  }
}

describe("tui sync: the merged configuration after a hot-read permission write", () => {
  test("config.updated naming permission reads the configuration again and takes the answer", async () => {
    await withConfig({ permission: { edit: "ask" } }, async ({ emit, server, sdk, sync }) => {
      expect(sync.data.config.permission).toEqual({ edit: "ask" })
      const bootstrapReads = server.reads

      server.answer = () => json({ permission: { edit: "allow" } })
      emit(configUpdated(["permission"]))
      sdk.frameClock.flushNow()
      await wait(() => editRule(sync.data.config) === "allow")
      expect(server.reads).toBe(bootstrapReads + 1)
    })
  })

  test("the ordered permissions list is a permission write too", async () => {
    await withConfig({}, async ({ emit, server, sdk, sync }) => {
      server.answer = () => json({ permissions: [{ action: "bash", resource: "*", effect: "deny" }] })
      emit(configUpdated(["permissions"]))
      sdk.frameClock.flushNow()
      await wait(() => sync.data.config.permissions?.[0]?.effect === "deny")
    })
  })

  test("a write that names other keys, or none, reads nothing", async () => {
    await withConfig({ permission: { edit: "ask" } }, async ({ emit, server, sdk }) => {
      const bootstrapReads = server.reads
      emit(configUpdated(["language"]))
      emit(configUpdated(["dag"]))
      emit(configUpdated([]))
      sdk.frameClock.flushNow()
      await Bun.sleep(60)
      expect(server.reads).toBe(bootstrapReads)
    })
  })

  test("a failed read leaves the configuration held, and an answer that is overtaken is dropped", async () => {
    let release!: () => void
    const slow = new Promise<void>((resolve) => {
      release = resolve
    })
    await withConfig({ permission: { edit: "ask" } }, async ({ emit, server, sdk, sync }) => {
      // The read fails: nothing is replaced.
      server.answer = () => new Response("nope", { status: 500 })
      emit(configUpdated(["permission"]))
      sdk.frameClock.flushNow()
      await Bun.sleep(60)
      expect(sync.data.config.permission).toEqual({ edit: "ask" })

      // The first read is still out when a second write is announced; its answer arrives last and must not win.
      let calls = 0
      server.answer = async () => {
        calls += 1
        if (calls === 1) {
          await slow
          return json({ permission: { edit: "deny" } })
        }
        return json({ permission: { edit: "allow" } })
      }
      emit(configUpdated(["permission"]))
      sdk.frameClock.flushNow()
      await wait(() => calls === 1)
      emit(configUpdated(["permission"]))
      sdk.frameClock.flushNow()
      await wait(() => editRule(sync.data.config) === "allow")

      release()
      await Bun.sleep(60)
      expect(editRule(sync.data.config)).toBe("allow")
    })
  })

  // The panel drops the value it wrote once the read it asked for has landed: a read that was overtaken must not
  // report that before the newer answer is in the store, or the row would show the old rules for a moment.
  test("a read that is overtaken resolves only once the newer answer is in the store", async () => {
    let release!: () => void
    const slow = new Promise<void>((resolve) => {
      release = resolve
    })
    await withConfig({ permission: { edit: "ask" } }, async ({ server, sync }) => {
      let calls = 0
      server.answer = async () => {
        calls += 1
        if (calls === 1) {
          await slow
          return json({ permission: { edit: "deny" } })
        }
        return json({ permission: { edit: "allow" } })
      }
      const first = sync.config.refresh()
      await wait(() => calls === 1)
      const second = sync.config.refresh()
      expect(await second).toBe(true)
      expect(editRule(sync.data.config)).toBe("allow")

      release()
      expect(await first).toBe(true)
      expect(editRule(sync.data.config)).toBe("allow")
    })
  })

  test("sync.config.refresh() reads on demand and says whether the server answered", async () => {
    await withConfig({ permission: { edit: "ask" } }, async ({ server, sync }) => {
      server.answer = () => json({ permission: { edit: "deny" } })
      expect(await sync.config.refresh()).toBe(true)
      expect(sync.data.config.permission).toEqual({ edit: "deny" })

      server.answer = () => new Response("nope", { status: 500 })
      expect(await sync.config.refresh()).toBe(false)
      expect(sync.data.config.permission).toEqual({ edit: "deny" })
    })
  })
})
