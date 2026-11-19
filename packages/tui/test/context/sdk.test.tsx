// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, mock, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ParentProps } from "solid-js"
import { reportChildSessionReadOnly, SDKProvider, useSDK } from "../../src/context/sdk"
import { setLanguage, t } from "../../src/i18n"
import { FooterToastProvider, useToast } from "../../src/ui/toast"
import { directory, json } from "../fixture/tui-sdk"
import { loggedLines } from "../fixture/tui-log"
import { TestTuiContexts } from "../fixture/tui-environment"

// A write that addresses a sub-agent's session is refused by the server with 409 `ChildSessionReadOnlyError`. The
// SDK's one `fetch` reports it (#1618): the data layer cannot show a toast, so the app turns the report into one, and
// every write entry gets the hint without knowing about it. The response itself is never touched.

afterEach(() => {
  setLanguage("zh-CN")
})

const SERVER_MESSAGE = "This is a child session and is read-only. Send input to its parent agent instead."

function refusal(sessionID = "ses_child") {
  return { name: "ChildSessionReadOnlyError", data: { sessionID, message: SERVER_MESSAGE } } as const
}

type FetchArgs = Parameters<typeof globalThis.fetch>

/** A transport that answers every request with what `respond` makes, and keeps the arguments it was called with. */
function transport(respond: (...args: FetchArgs) => Response) {
  const calls: FetchArgs[] = []
  const fetch = Object.assign(
    async (...args: FetchArgs) => {
      calls.push(args)
      return respond(...args)
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  return { fetch, calls }
}

describe("reportChildSessionReadOnly", () => {
  test("a 409 ChildSessionReadOnlyError is reported once with the session it names, and the response comes back whole", async () => {
    const answer = json(refusal("ses_child"), { status: 409 })
    const onRefused = mock((_sessionID: string) => {})
    const wrapped = reportChildSessionReadOnly(transport(() => answer).fetch, onRefused)

    const response = await wrapped(new Request("http://test/session/ses_child/command", { method: "POST" }))

    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(onRefused).toHaveBeenCalledWith("ses_child")
    // Only a clone was read: the caller gets the response it would have got, body included.
    expect(response).toBe(answer)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(refusal("ses_child"))
  })

  test("a request goes through with the arguments it was made with: one Request, or a URL with an init", async () => {
    const { fetch, calls } = transport(() => json({}))
    const wrapped = reportChildSessionReadOnly(fetch, () => {})

    const request = new Request("http://test/session/ses_a/command", { method: "POST", body: "{}" })
    await wrapped(request)
    const init = { method: "POST", body: "{}", headers: { "x-test": "1" } }
    await wrapped("http://test/session/ses_b/command", init)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toHaveLength(1)
    expect(calls[0][0]).toBe(request)
    expect(calls[1]).toHaveLength(2)
    expect(calls[1][0]).toBe("http://test/session/ses_b/command")
    expect(calls[1][1]).toBe(init)
  })

  test("a 409 that is another error, a success and a 409 that is not JSON are not reported, and read the same", async () => {
    const busy = { name: "SessionBusyError", data: { sessionID: "ses_busy", message: "Session is busy" } }
    for (const [label, make, check] of [
      [
        "another 409",
        () => json(busy, { status: 409 }),
        async (response: Response) => expect(await response.json()).toEqual(busy),
      ],
      [
        "a 200 carrying the same name",
        () => json(refusal(), { status: 200 }),
        async (response: Response) => expect(await response.json()).toEqual(refusal()),
      ],
      [
        "a 403 carrying the same name",
        () => json(refusal(), { status: 403 }),
        async (response: Response) => expect(await response.json()).toEqual(refusal()),
      ],
      [
        "a 409 with plain text",
        () => new Response("conflict", { status: 409, headers: { "content-type": "text/plain" } }),
        async (response: Response) => expect(await response.text()).toBe("conflict"),
      ],
      [
        "a 409 with no body",
        () => new Response(null, { status: 409 }),
        async (response: Response) => expect(await response.text()).toBe(""),
      ],
      [
        "a 409 whose JSON is a string",
        () => json("ChildSessionReadOnlyError", { status: 409 }),
        async (response: Response) => expect(await response.json()).toBe("ChildSessionReadOnlyError"),
      ],
      [
        "a 409 whose JSON is null",
        () => json(null, { status: 409 }),
        async (response: Response) => expect(await response.json()).toBeNull(),
      ],
    ] as const) {
      const onRefused = mock((_sessionID: string) => {})
      const wrapped = reportChildSessionReadOnly(transport(make).fetch, onRefused)
      const response = await wrapped(new Request("http://test/session/ses_x/command", { method: "POST" }))
      expect({ label, calls: onRefused.mock.calls.length }).toEqual({ label, calls: 0 })
      await check(response)
    }
  })

  test("a refusal that does not have the envelope's shape is not reported", async () => {
    for (const body of [
      { name: "ChildSessionReadOnlyError" },
      { name: "ChildSessionReadOnlyError", data: null },
      { name: "ChildSessionReadOnlyError", data: "ses_child" },
      { name: "ChildSessionReadOnlyError", data: { message: SERVER_MESSAGE } },
      { name: "ChildSessionReadOnlyError", data: { sessionID: 7, message: SERVER_MESSAGE } },
      { data: { sessionID: "ses_child", message: SERVER_MESSAGE } },
      { name: "childsessionreadonlyerror", data: { sessionID: "ses_child", message: SERVER_MESSAGE } },
    ]) {
      const onRefused = mock((_sessionID: string) => {})
      const wrapped = reportChildSessionReadOnly(transport(() => json(body, { status: 409 })).fetch, onRefused)
      const response = await wrapped(new Request("http://test/session/ses_child/command", { method: "POST" }))
      expect({ body, calls: onRefused.mock.calls.length }).toEqual({ body, calls: 0 })
      expect(await response.json()).toEqual(body)
    }
  })

  test("each refusal is reported: the repeats are the toast's to merge", async () => {
    const onRefused = mock((_sessionID: string) => {})
    const wrapped = reportChildSessionReadOnly(
      transport(() => json(refusal("ses_child"), { status: 409 })).fetch,
      onRefused,
    )
    for (let i = 0; i < 3; i++) await wrapped(new Request("http://test/session/ses_child/command", { method: "POST" }))
    expect(onRefused.mock.calls).toEqual([["ses_child"], ["ses_child"], ["ses_child"]])
  })

  test("a report that throws is logged and never fails the request", async () => {
    const answer = json(refusal("ses_report_throws"), { status: 409 })
    const wrapped = reportChildSessionReadOnly(transport(() => answer).fetch, () => {
      throw new Error("toast unavailable")
    })

    const response = await wrapped(new Request("http://test/session/ses_report_throws/command", { method: "POST" }))

    expect(response).toBe(answer)
    expect(await response.json()).toEqual(refusal("ses_report_throws"))
    // The log append is not awaited by `write`; poll for the line within a bound.
    const start = Date.now()
    while (loggedLines("ses_report_throws").length === 0 && Date.now() - start < 2000) await Bun.sleep(10)
    expect(loggedLines("ses_report_throws").join("\n")).toContain("toast unavailable")
  })

  test("a transport failure passes through as it is", async () => {
    const wrapped = reportChildSessionReadOnly(
      transport(() => {
        throw new TypeError("network down")
      }).fetch,
      () => {},
    )
    const failure = await wrapped(new Request("http://test/session/ses_x/command", { method: "POST" })).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(TypeError)
    expect(failure).toMatchObject({ message: "network down" })
  })
})

/** The SDK provider wired the way `app.tsx` wires it (`SDKWithToast`): a refusal becomes a footer toast. */
function ToastSDKProvider(props: ParentProps<{ fetch: typeof fetch }>) {
  const toast = useToast()
  return (
    <SDKProvider
      url="http://test"
      directory={directory}
      fetch={props.fetch}
      onChildSessionReadOnly={() =>
        toast.show({
          text: t("error.child_session_read_only"),
          level: "warning",
          dedupeKey: "error.child_session_read_only",
        })
      }
    >
      {props.children}
    </SDKProvider>
  )
}

async function mount(respond: (request: Request) => Response) {
  let sdk!: ReturnType<typeof useSDK>
  let toast!: ReturnType<typeof useToast>
  const { fetch, calls } = transport((input) => respond(input instanceof Request ? input : new Request(input)))

  function Probe() {
    sdk = useSDK()
    toast = useToast()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <FooterToastProvider>
        <ToastSDKProvider fetch={fetch}>
          <Probe />
        </ToastSDKProvider>
      </FooterToastProvider>
    </TestTuiContexts>
  ))
  return { app, sdk: () => sdk, toast: () => toast, calls }
}

const command = { sessionID: "ses_main", command: "dag-mode", arguments: "on" }

describe("a refused write seen through the client", () => {
  test("the toast holds the hint in the language of the UI, as a warning that merges its repeats", async () => {
    for (const [language, text] of [
      ["zh-CN", "子 agent 只读：请回主会话让主 agent 调整"],
      ["en", "Sub-agent is read-only; ask the main agent"],
    ] as const) {
      setLanguage(language)
      const { app, sdk, toast } = await mount(() => json(refusal("ses_main"), { status: 409 }))
      try {
        expect(toast().currentToast).toBeNull()
        // Three writes refused in a row: the refusal of each is reported, and the toast stays one.
        for (let i = 0; i < 3; i++) await sdk().client.session.command(command)
        expect(toast().currentToast).toEqual(
          expect.objectContaining({ text, level: "warning", dedupeKey: "error.child_session_read_only" }),
        )
        expect(toast().queued).toEqual([])
      } finally {
        app.renderer.destroy()
      }
    }
  })

  test("the caller reads the refusal as before, as a result and as a thrown error", async () => {
    const { app, sdk, toast } = await mount(() => json(refusal("ses_main"), { status: 409 }))
    try {
      const result = await sdk().client.session.command(command)
      expect(result.response?.status).toBe(409)
      expect(result.error).toEqual(refusal("ses_main"))
      expect(result.data).toBeUndefined()

      const thrown = await sdk()
        .client.session.command(command, { throwOnError: true })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown).toMatchObject({ message: SERVER_MESSAGE, cause: { status: 409, body: refusal("ses_main") } })
      // The two writes are one toast.
      expect(toast().queued).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })

  test("another 409, a success and a 409 that is not JSON leave no toast", async () => {
    const busy = { name: "SessionBusyError", data: { sessionID: "ses_main", message: "Session is busy" } }
    for (const make of [
      () => json(busy, { status: 409 }),
      () => json({ info: {}, parts: [] }),
      () => new Response("conflict", { status: 409, headers: { "content-type": "text/plain" } }),
    ]) {
      const { app, sdk, toast } = await mount(make)
      try {
        await sdk().client.session.command(command)
        expect(toast().currentToast).toBeNull()
      } finally {
        app.renderer.destroy()
      }
    }
  })

  test("a refused write is one request: nothing is sent again", async () => {
    const { app, sdk, calls } = await mount(() => json(refusal("ses_main"), { status: 409 }))
    try {
      await sdk().client.session.command(command)
      expect(calls).toHaveLength(1)
      const [request] = calls[0]
      expect(request).toBeInstanceOf(Request)
      expect(request instanceof Request && new URL(request.url).pathname).toBe("/session/ses_main/command")
    } finally {
      app.renderer.destroy()
    }
  })

  test("a provider with no callback still serves the write", async () => {
    const { fetch } = transport(() => json(refusal("ses_main"), { status: 409 }))
    let sdk!: ReturnType<typeof useSDK>
    function Probe() {
      sdk = useSDK()
      return <box />
    }
    const app = await testRender(() => (
      <TestTuiContexts>
        <SDKProvider url="http://test" directory={directory} fetch={fetch}>
          <Probe />
        </SDKProvider>
      </TestTuiContexts>
    ))
    try {
      const result = await sdk.client.session.command(command)
      expect(result.error).toEqual(refusal("ses_main"))
    } finally {
      app.renderer.destroy()
    }
  })
})
