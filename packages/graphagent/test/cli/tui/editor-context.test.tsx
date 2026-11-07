import os from "node:os"
import path from "node:path"
import { afterEach, expect, spyOn, test } from "bun:test"
import { createRoot } from "solid-js"
import { EditorContextProvider, useEditorContext, type EditorIntegration } from "@graphagent/tui/context/editor"
import { tmpdir } from "../../fixture/fixture"
import { FakeWebSocket } from "../../lib/websocket"
import { TestTuiContexts } from "../../fixture/tui-environment"

const originalGraphagentPort = process.env.GRAPHAGENT_EDITOR_SSE_PORT

afterEach(() => {
  process.env.GRAPHAGENT_EDITOR_SSE_PORT = originalGraphagentPort
})

function nextTick() {
  return new Promise<void>((resolve) => queueMicrotask(resolve))
}

function mountEditorContext(integration: EditorIntegration, WebSocketImpl?: typeof WebSocket) {
  let editor!: ReturnType<typeof useEditorContext>
  let dispose!: () => void

  createRoot((nextDispose) => {
    dispose = nextDispose

    const Consumer = () => {
      editor = useEditorContext()
      return null
    }

    return (
      <TestTuiContexts cwd={process.cwd()} paths={{ home: os.homedir() }}>
        <EditorContextProvider integration={integration} WebSocketImpl={WebSocketImpl}>
          <Consumer />
        </EditorContextProvider>
      </TestTuiContexts>
    )
  })

  return {
    editor,
    dispose,
  }
}

// The editor connection is supplied by the host integration (or the explicit
// GRAPHAGENT_EDITOR_SSE_PORT env override). Claude IDE lock files are never
// read, so tests inject their own discovery function.
function connectionFor(entries: Record<string, number>): EditorIntegration {
  return {
    connection: (directory) => {
      const port = entries[directory]
      return port === undefined ? undefined : { url: `ws://127.0.0.1:${port}`, source: "test" }
    },
  }
}

function createWebSocketImpl(...sockets: FakeWebSocket[]) {
  let index = 0

  return class {
    constructor(url: string) {
      const socket = sockets[index]
      index += 1
      expect(socket).toBeDefined()
      expect(url).toBe(socket!.url)
      return socket as unknown as object
    }
  } as unknown as typeof WebSocket
}

function sendSelection(socket: FakeWebSocket, filePath: string, text = "foo") {
  socket.message(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "selection_changed",
      params: {
        text,
        filePath,
        selection: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 4 },
        },
      },
    }),
  )
}

function expectedSelection(filePath: string, text = "foo") {
  return {
    filePath,
    source: "websocket" as const,
    ranges: [
      {
        text,
        selection: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 4 },
        },
      },
    ],
  }
}

test("useEditorContext reconnect switches editor server by session directory", async () => {
  await using tmp = await tmpdir()
  const startupDirectory = path.join(tmp.path, "startup")
  const sessionDirectory = path.join(tmp.path, "session")

  process.env.GRAPHAGENT_EDITOR_SSE_PORT = undefined
  spyOn(process, "cwd").mockImplementation(() => startupDirectory)
  const firstSocket = new FakeWebSocket("ws://127.0.0.1:3001")
  const secondSocket = new FakeWebSocket("ws://127.0.0.1:3002")
  const integration = connectionFor({ [startupDirectory]: 3001, [sessionDirectory]: 3002 })

  const mounted = mountEditorContext(integration, createWebSocketImpl(firstSocket, secondSocket))
  await nextTick()

  expect(firstSocket.closed).toBeFalse()
  sendSelection(firstSocket, path.join(startupDirectory, "file.ts"))

  expect(mounted.editor.selection()).toEqual(expectedSelection(path.join(startupDirectory, "file.ts")))
  expect(mounted.editor.labelState()).toBe("pending")

  mounted.editor.reconnect(sessionDirectory)
  await nextTick()

  expect(firstSocket.closed).toBeTrue()
  expect(secondSocket.closed).toBeFalse()
  expect(mounted.editor.selection()).toBeUndefined()
  expect(mounted.editor.labelState()).toBe("none")

  mounted.dispose()
})

test("useEditorContext favors configured port over discovered connections", async () => {
  await using tmp = await tmpdir()
  const startupDirectory = path.join(tmp.path, "startup")
  let discovered = 0

  process.env.GRAPHAGENT_EDITOR_SSE_PORT = "4010"
  spyOn(process, "cwd").mockImplementation(() => startupDirectory)
  const socket = new FakeWebSocket("ws://127.0.0.1:4010")

  const mounted = mountEditorContext(
    {
      connection: () => {
        discovered += 1
        return { url: "ws://127.0.0.1:3001", source: "test" }
      },
    },
    createWebSocketImpl(socket),
  )
  await nextTick()

  expect(socket.closed).toBeFalse()
  expect(discovered).toBe(0)

  mounted.dispose()
})

test("useEditorContext clears selection when reconnecting", async () => {
  await using tmp = await tmpdir()
  const startupDirectory = path.join(tmp.path, "startup")

  process.env.GRAPHAGENT_EDITOR_SSE_PORT = undefined
  spyOn(process, "cwd").mockImplementation(() => startupDirectory)
  const socket = new FakeWebSocket("ws://127.0.0.1:3001")

  const mounted = mountEditorContext(connectionFor({ [startupDirectory]: 3001 }), createWebSocketImpl(socket))
  await nextTick()

  expect(socket.closed).toBeFalse()
  expect(mounted.editor.selection()).toBeUndefined()
  expect(mounted.editor.connected()).toBeFalse()

  socket.open()
  socket.message(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "test", version: "0.0.0" },
      },
    }),
  )
  sendSelection(socket, path.join(startupDirectory, "file.ts"))

  expect(mounted.editor.connected()).toBeTrue()
  expect(mounted.editor.server()).toEqual({
    protocolVersion: "2025-11-25",
    serverInfo: { name: "test", version: "0.0.0" },
  })
  expect(mounted.editor.selection()).toEqual(expectedSelection(path.join(startupDirectory, "file.ts")))
  expect(mounted.editor.labelState()).toBe("pending")
  mounted.editor.markSelectionSent()
  expect(mounted.editor.labelState()).toBe("sent")

  mounted.editor.reconnect(startupDirectory)

  expect(socket.closed).toBeFalse()
  expect(mounted.editor.connected()).toBeTrue()
  expect(mounted.editor.selection()).toBeUndefined()
  expect(mounted.editor.labelState()).toBe("none")

  mounted.dispose()
})

test("useEditorContext preserves selection for the next reconnect when requested", async () => {
  await using tmp = await tmpdir()
  const startupDirectory = path.join(tmp.path, "startup")

  process.env.GRAPHAGENT_EDITOR_SSE_PORT = undefined
  spyOn(process, "cwd").mockImplementation(() => startupDirectory)
  const socket = new FakeWebSocket("ws://127.0.0.1:3001")

  const mounted = mountEditorContext(connectionFor({ [startupDirectory]: 3001 }), createWebSocketImpl(socket))
  await nextTick()

  sendSelection(socket, path.join(startupDirectory, "file.ts"))
  expect(mounted.editor.selection()).toEqual(expectedSelection(path.join(startupDirectory, "file.ts")))

  mounted.editor.markSelectionSent()
  mounted.editor.preserveSelectionFromNewSession()
  mounted.editor.reconnect(startupDirectory)

  expect(socket.closed).toBeFalse()
  expect(mounted.editor.selection()).toEqual(expectedSelection(path.join(startupDirectory, "file.ts")))
  expect(mounted.editor.labelState()).toBe("sent")

  mounted.editor.reconnect(startupDirectory)

  expect(mounted.editor.selection()).toBeUndefined()
  expect(mounted.editor.labelState()).toBe("none")

  mounted.dispose()
})

test("useEditorContext connects with GRAPHAGENT_EDITOR_SSE_PORT", async () => {
  await using tmp = await tmpdir()
  process.env.GRAPHAGENT_EDITOR_SSE_PORT = "4020"
  spyOn(process, "cwd").mockImplementation(() => tmp.path)
  const socket = new FakeWebSocket("ws://127.0.0.1:4020")

  const mounted = mountEditorContext({}, createWebSocketImpl(socket))
  await nextTick()

  expect(socket.closed).toBeFalse()

  mounted.dispose()
})
