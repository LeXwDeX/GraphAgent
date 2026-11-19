// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// `graphagent debug request <session> [--step N]` shows a request that GRAPHAGENT_DEBUG_REQUESTS=1 captured (#1461).
// `requestOutput` is the whole behavior of the command: what it prints, what it says on stderr, and its exit code.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { EOL } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { APP_NAME } from "@graphagent/core/brand"
import { requestOutput } from "@/cli/cmd/debug/request.handler"
import { RequestCapture } from "@/provider/request-capture"
import { tmpdir } from "../fixture/fixture"
import { cliIt } from "../lib/cli-process"

const SESSION = "ses_debug_request"
const DAY = 24 * 60 * 60 * 1000

/** One captured request whose body says which step it is. */
const capture = (dir: string, session: string, marker: number) =>
  RequestCapture.record(
    {
      input: "https://api.example.test/v1/chat/completions",
      init: { method: "POST", headers: { "x-session-id": session }, body: JSON.stringify({ marker }) },
    },
    dir,
  )

const captureSteps = async (dir: string, session: string, count: number) => {
  for (let marker = 1; marker <= count; marker++) await capture(dir, session, marker)
}

describe("requestOutput", () => {
  test("prints the last captured step as JSON indented by two spaces when no step is given", async () => {
    await using tmp = await tmpdir()
    await captureSteps(tmp.path, SESSION, 3)

    const output = await requestOutput({ session: SESSION }, tmp.path)

    const last = await RequestCapture.read(SESSION, 3, tmp.path)
    expect(last).toMatchObject({ step: 3, body: { marker: 3 } })
    expect(output).toEqual({ code: 0, stdout: JSON.stringify(last, null, 2), stderr: "" })
    expect(output.stdout).toContain('\n  "sessionID": ')
  })

  test("prints the step that --step names", async () => {
    await using tmp = await tmpdir()
    await captureSteps(tmp.path, SESSION, 3)

    const output = await requestOutput({ session: SESSION, step: 2 }, tmp.path)

    expect(output.code).toBe(0)
    expect(output.stderr).toBe("")
    expect(JSON.parse(output.stdout)).toMatchObject({ sessionID: SESSION, step: 2, body: { marker: 2 } })
  })

  test("says which steps exist when --step is not among them, and exits 1", async () => {
    await using tmp = await tmpdir()
    await captureSteps(tmp.path, SESSION, 3)

    for (const step of [9, 0, 4]) {
      expect(await requestOutput({ session: SESSION, step }, tmp.path)).toEqual({
        code: 1,
        stdout: "",
        stderr: `Step ${step} not found; captured steps: 1..3`,
      })
    }
  })

  test("says how to record requests when the session has none, and exits 1", async () => {
    await using tmp = await tmpdir()
    await captureSteps(tmp.path, SESSION, 1)

    expect(await requestOutput({ session: "ses_none" }, tmp.path)).toEqual({
      code: 1,
      stdout: "",
      stderr: "No captured requests for session ses_none. Set GRAPHAGENT_DEBUG_REQUESTS=1 to record them.",
    })
    // A --step does not change that: there is nothing to pick from.
    expect((await requestOutput({ session: "ses_none", step: 1 }, tmp.path)).code).toBe(1)
    expect((await requestOutput({ session: "ses_none" }, path.join(tmp.path, "no-such-dir"))).code).toBe(1)
  })

  test("removes sessions idle for over 7 days before it looks", async () => {
    await using tmp = await tmpdir()
    await captureSteps(tmp.path, SESSION, 2)
    const old = new Date(Date.now() - 8 * DAY)
    for (const name of await fs.readdir(path.join(tmp.path, SESSION))) {
      await fs.utimes(path.join(tmp.path, SESSION, name), old, old)
    }

    const output = await requestOutput({ session: SESSION }, tmp.path)

    expect(output.code).toBe(1)
    expect(output.stderr).toBe(
      `No captured requests for session ${SESSION}. Set GRAPHAGENT_DEBUG_REQUESTS=1 to record them.`,
    )
    expect(await fs.readdir(tmp.path)).toEqual([])
  })

  test("never reads outside the capture directory, whatever the session argument", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "captures")
    await fs.mkdir(dir)
    await captureSteps(tmp.path, "outside", 1)

    const output = await requestOutput({ session: "../outside" }, dir)

    expect(output.code).toBe(1)
    expect(output.stdout).toBe("")
    expect(output.stderr).toBe(
      "No captured requests for session ../outside. Set GRAPHAGENT_DEBUG_REQUESTS=1 to record them.",
    )
  })

  test("reports a listed step whose file cannot be read, and exits 1", async () => {
    await using tmp = await tmpdir()
    await captureSteps(tmp.path, SESSION, 1)
    await fs.writeFile(path.join(tmp.path, SESSION, "0002.json"), "{ torn")

    expect(await requestOutput({ session: SESSION }, tmp.path)).toEqual({
      code: 1,
      stdout: "",
      stderr: `Step 2 of session ${SESSION} could not be read.`,
    })
    expect((await requestOutput({ session: SESSION, step: 1 }, tmp.path)).code).toBe(0)
  })
})

describe("graphagent debug request", () => {
  cliIt.live(
    "prints a captured request, and fails with the documented messages and exit code 1",
    ({ graphagent, home }) =>
      Effect.gen(function* () {
        // The subprocess keeps its data directory under the fixture home (XDG_DATA_HOME).
        const dir = path.join(home, ".local/share", APP_NAME, "debug-requests")
        yield* Effect.promise(() => captureSteps(dir, SESSION, 2))

        const last = yield* graphagent.spawn(["debug", "request", SESSION])
        graphagent.expectExit(last, 0, "debug request")
        expect(JSON.parse(last.stdout)).toMatchObject({ sessionID: SESSION, step: 2, body: { marker: 2 } })
        expect(last.stdout).toBe(`${JSON.stringify(JSON.parse(last.stdout), null, 2)}${EOL}`)

        const first = yield* graphagent.spawn(["debug", "request", SESSION, "--step", "1"])
        graphagent.expectExit(first, 0, "debug request --step 1")
        expect(JSON.parse(first.stdout)).toMatchObject({ step: 1, body: { marker: 1 } })

        const missingStep = yield* graphagent.spawn(["debug", "request", SESSION, "--step", "9"])
        graphagent.expectExit(missingStep, 1, "debug request --step 9")
        expect(missingStep.stdout).toBe("")
        expect(missingStep.stderr).toContain("Step 9 not found; captured steps: 1..2")

        const none = yield* graphagent.spawn(["debug", "request", "ses_none"])
        graphagent.expectExit(none, 1, "debug request unknown session")
        expect(none.stdout).toBe("")
        expect(none.stderr).toContain(
          "No captured requests for session ses_none. Set GRAPHAGENT_DEBUG_REQUESTS=1 to record them.",
        )
      }),
    180_000,
  )

  // The whole chain through the real engine: the flag in the environment, the x-session-id header the engine sets,
  // the redaction, and the viewer reading back what a real `run` sent.
  cliIt.live(
    "a run with GRAPHAGENT_DEBUG_REQUESTS=1 records its requests under its session, redacted",
    ({ llm, graphagent, home }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const run = yield* graphagent.run("say captured hi", { env: { GRAPHAGENT_DEBUG_REQUESTS: "1" } })
        graphagent.expectExit(run, 0, "run with capture")

        const root = path.join(home, ".local/share", APP_NAME, "debug-requests")
        const sessions = yield* Effect.promise(() => fs.readdir(root))
        expect(sessions.length).toBeGreaterThan(0)
        expect(sessions).not.toContain("_unattributed")
        const captured = yield* Effect.promise(async () =>
          (
            await Promise.all(
              sessions.map(async (session) =>
                RequestCapture.list(session, root).then((steps) => steps.map((step) => ({ session, step }))),
              ),
            )
          ).flat(),
        )
        const records = yield* Effect.promise(() =>
          Promise.all(captured.map(({ session, step }) => RequestCapture.read(session, step, root))),
        )
        expect(records.length).toBeGreaterThan(0)
        for (const [index, record] of records.entries()) {
          expect(record).toMatchObject({
            sessionID: captured[index]?.session,
            step: captured[index]?.step,
            method: "POST",
            headers: { authorization: "[REDACTED]", "x-session-id": captured[index]?.session },
          })
          expect(record?.url).toEndWith("/chat/completions")
        }
        expect(JSON.stringify(records.map((record) => record?.body))).toContain("say captured hi")
        expect(JSON.stringify(records)).not.toContain("test-key")

        const first = captured[0]
        const shown = yield* graphagent.spawn(["debug", "request", first.session, "--step", String(first.step)])
        graphagent.expectExit(shown, 0, "debug request after a run")
        expect(JSON.parse(shown.stdout)).toMatchObject({ sessionID: first.session, step: first.step })
        expect(shown.stdout).not.toContain("test-key")
      }),
    180_000,
  )

  cliIt.live(
    "a run without the flag writes nothing",
    ({ llm, graphagent, home }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const run = yield* graphagent.run("say plain hi")
        graphagent.expectExit(run, 0, "run without capture")

        const root = path.join(home, ".local/share", APP_NAME, "debug-requests")
        const exists = yield* Effect.promise(() =>
          fs.stat(root).then(
            () => true,
            () => false,
          ),
        )
        expect(exists).toBe(false)
      }),
    180_000,
  )
})
