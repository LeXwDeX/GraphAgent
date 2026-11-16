// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import {
  askedPermission,
  locationHeaders,
  permissionAnswerer,
  type Asked,
  type Location,
} from "../../../src/cli/cmd/run/permission-answer"

/**
 * #1324: a non-interactive `run` answers for its whole session tree, including
 * the nodes that run in another directory (a worktree) and reach it only through
 * the process-wide bus, so the answer must go to the directory that holds the
 * request.
 */

const main = "ses_main"
const request = (sessionID: string, id = `per_${sessionID}`, permission = "bash"): Asked => ({
  id,
  sessionID,
  permission,
  patterns: ["make deploy"],
})

/** The run with a fixed tree: the main session, a node in a worktree and a task below it. */
function run(options: { readonly approveOwn?: boolean; readonly fail?: boolean } = {}) {
  const members = new Set([main, "ses_node", "ses_task"])
  const answers: Array<{ requestID: string; reply: string; location?: Location }> = []
  const said: string[] = []
  const answer = permissionAnswerer({
    sessionID: main,
    tree: { has: async (sessionID) => members.has(sessionID) },
    approveOwn: options.approveOwn ?? false,
    reply: async (requestID, reply, location) => {
      if (options.fail) throw new Error("the server refused the reply")
      answers.push({ requestID, reply, ...(location ? { location } : {}) })
    },
    say: (line) => said.push(line),
  })
  return { answer, answers, said }
}

describe("permissionAnswerer", () => {
  test("the session the run drives is rejected, and the user is told", async () => {
    const { answer, answers, said } = run()
    await answer(request(main))
    expect(answers).toEqual([{ requestID: `per_${main}`, reply: "reject" }])
    expect(said).toEqual(["permission requested: bash (make deploy); auto-rejecting"])
  })

  test("--dangerously-skip-permissions approves the session the run drives, silently", async () => {
    const { answer, answers, said } = run({ approveOwn: true })
    await answer(request(main))
    expect(answers).toEqual([{ requestID: `per_${main}`, reply: "once" }])
    expect(said).toEqual([])
  })

  test("a node and a task below it are rejected, whatever the skip flag says", async () => {
    for (const approveOwn of [false, true]) {
      const { answer, answers, said } = run({ approveOwn })
      await answer(request("ses_node"))
      await answer(request("ses_task"))
      expect(answers.map((entry) => [entry.requestID, entry.reply])).toEqual([
        ["per_ses_node", "reject"],
        ["per_ses_task", "reject"],
      ])
      expect(said).toHaveLength(2)
    }
  })

  test("a session outside the tree is left alone", async () => {
    const { answer, answers, said } = run()
    await answer(request("ses_stranger"))
    expect(answers).toEqual([])
    expect(said).toEqual([])
  })

  test("the answer goes to the directory that holds the request", async () => {
    const { answer, answers } = run()
    const worktree = { directory: "/data/worktree/prj/dag-node", workspace: "wrk_one" }
    await answer(request("ses_node"), worktree)
    expect(answers).toEqual([{ requestID: "per_ses_node", reply: "reject", location: worktree }])
  })

  test("a request that arrives on both paths is answered once, whichever comes first", async () => {
    for (const order of ["stream first", "bus first"] as const) {
      const { answer, answers, said } = run()
      const here = request("ses_node", "per_both")
      const there = { directory: "/data/worktree/prj/dag-node" }
      await Promise.all(
        order === "stream first" ? [answer(here), answer(here, there)] : [answer(here, there), answer(here)],
      )
      expect(answers).toHaveLength(1)
      expect(said).toHaveLength(1)
      // A later request is answered on its own.
      await answer(request("ses_node", "per_next"))
      expect(answers.map((entry) => entry.requestID)).toEqual(["per_both", "per_next"])
    }
  })

  test("a reply that cannot be sent reaches the caller", async () => {
    const { answer } = run({ fail: true })
    const failure = await answer(request("ses_node")).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error && failure.message).toBe("the server refused the reply")
  })
})

describe("askedPermission", () => {
  test("reads the request a permission.asked event carries", () => {
    expect(
      askedPermission({
        id: "per_1",
        sessionID: "ses_1",
        permission: "edit",
        patterns: ["src/a.ts", "src/b.ts"],
        always: ["*"],
        metadata: {},
      }),
    ).toEqual({ id: "per_1", sessionID: "ses_1", permission: "edit", patterns: ["src/a.ts", "src/b.ts"] })
  })

  test("anything else is not a request", () => {
    for (const value of [
      undefined,
      null,
      "per_1",
      [],
      {},
      { id: "per_1", sessionID: "ses_1", permission: "bash" },
      { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: "ls" },
      { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: [1] },
      { id: 1, sessionID: "ses_1", permission: "bash", patterns: [] },
      { id: "per_1", permission: "bash", patterns: [] },
    ])
      expect(askedPermission(value)).toBeUndefined()
  })
})

describe("locationHeaders", () => {
  test("addresses the directory and the workspace the way the server reads them", () => {
    expect(locationHeaders({ directory: "/data/worktree/my project/node", workspace: "wrk_one" })).toEqual({
      "x-graphagent-directory": encodeURIComponent("/data/worktree/my project/node"),
      "x-graphagent-workspace": "wrk_one",
    })
  })

  test("leaves out what is not known", () => {
    expect(locationHeaders({})).toEqual({})
    expect(locationHeaders({ directory: "/repo" })).toEqual({ "x-graphagent-directory": "%2Frepo" })
  })
})
