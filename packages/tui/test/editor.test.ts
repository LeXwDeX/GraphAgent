import { afterEach, expect, test } from "bun:test"
import { normalizePromptContent, openEditor } from "../src/editor"

const editor = process.env.EDITOR
const visual = process.env.VISUAL

afterEach(() => {
  process.env.EDITOR = editor
  process.env.VISUAL = visual
})

test("rejects when the external editor cannot start", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = "opencode-editor-that-does-not-exist"
  const calls: string[] = []
  const renderer = {
    suspend() {
      calls.push("suspend")
      return Promise.resolve()
    },
    resume() {
      calls.push("resume")
      return Promise.resolve()
    },
    requestRender() {
      calls.push("render")
    },
    currentRenderBuffer: {
      clear() {
        calls.push("clear")
      },
    },
  }

  await expect(openEditor({ value: "original", renderer: renderer as never })).rejects.toThrow()
  expect(calls).toEqual(["suspend", "clear", "clear", "resume", "render"])
})

test("waits for suspend before starting the editor and resumes before requesting a render", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = `${process.execPath} -e process.exit(0)`
  const calls: string[] = []
  let releaseSuspend!: () => void
  let settled = false
  const renderer = {
    suspend() {
      calls.push("suspend")
      return new Promise<void>((resolve) => {
        releaseSuspend = resolve
      })
    },
    resume() {
      calls.push("resume")
      return Promise.resolve()
    },
    requestRender() {
      calls.push("render")
    },
    currentRenderBuffer: {
      clear() {
        calls.push("clear")
      },
    },
  }

  const pending = openEditor({ value: "original", renderer: renderer as never }).finally(() => {
    settled = true
  })
  await Bun.sleep(50)
  expect(settled).toBe(false)
  expect(calls).toEqual(["suspend"])

  releaseSuspend()
  await expect(pending).resolves.toBe("original")
  expect(calls).toEqual(["suspend", "clear", "clear", "resume", "render"])
})

test("normalizes a single trailing editor newline for one-line prompts", () => {
  expect(normalizePromptContent("hello\n")).toBe("hello")
  expect(normalizePromptContent("hello\r\n")).toBe("hello")
})

test("preserves multiline prompts that end with a newline", () => {
  expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")
})
