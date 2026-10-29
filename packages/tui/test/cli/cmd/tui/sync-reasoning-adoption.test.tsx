/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, SyntaxStyle } from "@opentui/core"
import type { AssistantMessage, ReasoningPart } from "@opencode-ai/sdk/v2"
import { useSync } from "../../../../src/context/sync"
import { ReasoningMarkdown } from "../../../../src/routes/session"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

test("adopted thinking replaces the existing displayed part and survives a fresh session sync", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const sessionID = "ses_reasoning_adoption"
  const messageID = "msg_reasoning_adoption"
  const partID = "prt_reasoning_adoption"
  const session = {
    id: sessionID,
    title: "reasoning",
    slug: "reasoning",
    projectID: "proj_test",
    time: { created: 1, updated: 1 },
    version: "test",
    directory,
  }
  const info: AssistantMessage = {
    id: messageID,
    sessionID,
    parentID: "msg_user",
    role: "assistant",
    agent: "build",
    mode: "build",
    modelID: "model",
    providerID: "provider",
    path: { cwd: directory, root: directory },
    time: { created: 1, completed: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  let part: ReasoningPart = {
    id: partID,
    messageID,
    sessionID,
    type: "reasoning",
    text: "original thinking",
    time: { start: 1 },
  }
  const fg = RGBA.fromHex("#888888")
  const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg } })
  function ReasoningProbe() {
    const sync = useSync()
    const current = () => sync.data.part[messageID]?.find((item): item is ReasoningPart => item.type === "reasoning")
    return (
      <ReasoningMarkdown
        content={current()?.text ?? ""}
        streaming={!current()?.time.end}
        syntaxStyle={syntaxStyle}
        conceal={false}
        fg={fg}
      />
    )
  }
  async function visible(app: Awaited<ReturnType<typeof mount>>["app"], text: string) {
    // A deadline rather than a fixed attempt count: 2 vCPU CI agents can need
    // well over 100ms to render the frame.
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await app.renderOnce()
      if (app.captureCharFrame().includes(text)) return true
      await Bun.sleep(5)
    }
    return false
  }
  const serve = (url: URL) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([{ info, parts: [part] }])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }
  const first = await mount(serve, tmp.path, () => <ReasoningProbe />)
  try {
    await first.sync.session.sync(sessionID)
    expect(first.sync.data.part[messageID][0].type).toBe("reasoning")
    expect(first.sync.data.part[messageID][0]).toMatchObject({ text: "original thinking" })
    expect(await visible(first.app, "original thinking")).toBe(true)
    part = { ...part, text: "original thinking with appended evidence" }
    first.emit({
      directory,
      payload: { id: "evt_append", type: "message.part.updated", properties: { sessionID, part, time: 2 } },
    })
    await wait(() =>
      first.sync.data.part[messageID]?.some((item) => item.type === "reasoning" && item.text === part.text),
    )
    expect(await visible(first.app, "appended evidence")).toBe(true)
    part = { ...part, text: "finalized thinking with appended evidence", time: { start: 1, end: 2 } }
    first.emit({
      directory,
      payload: { id: "evt_finish", type: "message.part.updated", properties: { sessionID, part, time: 2 } },
    })
    await wait(() =>
      first.sync.data.part[messageID]?.some((item) => item.type === "reasoning" && item.text === part.text),
    )
    expect(await visible(first.app, "finalized thinking")).toBe(true)
    part = { ...part, text: "蒸馏后的思考", distillation: { originalText: part.text, sourceFingerprint: "source" } }
    first.emit({
      directory,
      payload: { id: "evt_adoption", type: "message.part.updated", properties: { sessionID, part, time: 3 } },
    })
    await wait(() =>
      first.sync.data.part[messageID].some((item) => item.type === "reasoning" && item.text === part.text),
    )
    expect(first.sync.data.part[messageID]).toHaveLength(1)
    expect(first.sync.data.part[messageID][0]).toMatchObject({ id: partID, text: part.text })
    expect(await visible(first.app, "蒸馏后的思考")).toBe(true)
    expect(first.app.captureCharFrame()).not.toContain("finalized thinking")
  } finally {
    first.app.renderer.destroy()
  }
  const restored = await mount(serve, tmp.path)
  try {
    await restored.sync.session.sync(sessionID)
    expect(restored.sync.data.part[messageID]).toHaveLength(1)
    expect(restored.sync.data.part[messageID][0]).toMatchObject({ id: partID, text: "蒸馏后的思考" })
  } finally {
    restored.app.renderer.destroy()
  }
})
