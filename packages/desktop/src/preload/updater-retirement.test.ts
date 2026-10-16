import { expect, test } from "bun:test"

// A subprocess keeps the Electron module mock private to this bridge test.
test("preload startup exposes no updater capability or background subscription", async () => {
  const entry = new URL("./index.ts", import.meta.url).href
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test"
    let api
    const effects = []
    globalThis.fetch = (...args) => { effects.push(["fetch", ...args]); throw new Error("unexpected network") }
    mock.module("electron", () => ({
      contextBridge: { exposeInMainWorld: (name, value) => { api = value } },
      ipcRenderer: {
        invoke: (...args) => { effects.push(["invoke", ...args]); return Promise.resolve() },
        on: (...args) => { effects.push(["on", ...args]) },
        send: (...args) => { effects.push(["send", ...args]) },
      },
      webUtils: {},
    }))
    await import(${JSON.stringify(entry)})
    const startup = effects.slice()
    api.relaunch()
    console.log(JSON.stringify({ updater: "updater" in api, startup, effects }))
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
  expect(JSON.parse(output)).toEqual({ updater: false, startup: [], effects: [["send", "relaunch"]] })
})
