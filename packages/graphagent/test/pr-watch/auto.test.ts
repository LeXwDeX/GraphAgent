// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { PrWatchPoller } from "@/pr-watch/poller"
import { afterTool, createdRequest } from "@/pr-watch/auto"
import { it } from "../lib/effect"

/**
 * #1071 PR4: a successful `gh pr create` registers a durable watch from the
 * tool pipeline's own PostToolUse seam — no user hook. Recognition uses the
 * completed command, its exit code, and the URL the command printed.
 */

const URL = "https://github.com/acme/widgets/pull/42"

const poller = () => {
  const registered: PrWatchPoller.RegisterInput[] = []
  const service: PrWatchPoller.Interface = {
    register: (input) =>
      Effect.sync(() => {
        registered.push(input)
        return { id: "watch_auto", created: true }
      }),
    query: () => Effect.succeed([]),
    cancel: () => Effect.succeed(undefined),
    retireSession: () => Effect.succeed(0),
    pollOnce: () => Effect.succeed(0),
    recoverOnce: () => Effect.succeed(0),
    init: () => Effect.void,
  }
  return { registered, layer: Layer.succeed(PrWatchPoller.Service, service) }
}

describe("gh pr create recognition", () => {
  test("extracts the request URL a successful create printed", () => {
    expect(createdRequest("gh pr create --fill", 0, `Creating...\n${URL}\n`)).toMatchObject({ url: URL })
    expect(
      createdRequest("cd repo && gh  pr  create --title x", 0, `warning: unused\n${URL}\n<shell_metadata>`),
    ).toMatchObject({ url: URL })
  })

  test("rejects failures, other tools and commands without a URL", () => {
    expect(createdRequest("gh pr create --fill", 1, URL)).toBeUndefined()
    expect(createdRequest("gh pr view", 0, URL)).toBeUndefined()
    expect(createdRequest("echo done", 0, URL)).toBeUndefined()
    expect(createdRequest("git commit -m 'gh pr create'", 0, "no url here")).toBeUndefined()
    expect(createdRequest("gh pr create", 0, "https://example.com/not-a-request")).toBeUndefined()
    expect(createdRequest(undefined, 0, URL)).toBeUndefined()
    expect(createdRequest("gh pr create", undefined, URL)).toBeUndefined()
  })

  test("only recognises the command position, not quoted argument text", () => {
    // The words are data for printf: the command that runs is printf, not gh.
    expect(createdRequest(`printf '%s\\n' 'gh pr create' '${URL}'`, 0, `${URL}\n`)).toBeUndefined()
    expect(createdRequest(`echo 'gh pr create ${URL}'`, 0, `${URL}\n`)).toBeUndefined()
    expect(createdRequest(`bash -c 'gh pr create --fill'`, 0, `${URL}\n`)).toBeUndefined()
    // An unterminated quote makes the command shape ambiguous.
    expect(createdRequest(`gh pr create --title 'unterminated`, 0, `${URL}\n`)).toBeUndefined()
  })
})

describe("automatic watch registration", () => {
  it.effect("registers a successful create in a root session", () =>
    Effect.gen(function* () {
      const h = poller()
      yield* afterTool({
        toolID: "bash",
        command: "gh pr create --fill",
        exit: 0,
        output: `${URL}\n`,
        sessionID: "ses_root",
        parentID: undefined,
      }).pipe(Effect.provide(h.layer))
      expect(h.registered).toHaveLength(1)
      expect(h.registered[0]).toMatchObject({ sessionID: "ses_root", request: { url: URL, provider: "github" } })
    }),
  )

  it.effect("does not register a failed create", () =>
    Effect.gen(function* () {
      const h = poller()
      yield* afterTool({
        toolID: "bash",
        command: "gh pr create --fill",
        exit: 1,
        output: `${URL}\n`,
        sessionID: "ses_root",
        parentID: undefined,
      }).pipe(Effect.provide(h.layer))
      expect(h.registered).toHaveLength(0)
    }),
  )

  it.effect("never registers from a child session or another tool", () =>
    Effect.gen(function* () {
      const h = poller()
      yield* afterTool({
        toolID: "bash",
        command: "gh pr create --fill",
        exit: 0,
        output: `${URL}\n`,
        sessionID: "ses_child",
        parentID: "ses_parent",
      }).pipe(Effect.provide(h.layer))
      yield* afterTool({
        toolID: "task",
        command: "gh pr create --fill",
        exit: 0,
        output: `${URL}\n`,
        sessionID: "ses_root",
        parentID: undefined,
      }).pipe(Effect.provide(h.layer))
      expect(h.registered).toHaveLength(0)
    }),
  )

  it.effect("degrades to a no-op when the poller is absent", () =>
    Effect.gen(function* () {
      yield* afterTool({
        toolID: "bash",
        command: "gh pr create --fill",
        exit: 0,
        output: `${URL}\n`,
        sessionID: "ses_root",
        parentID: undefined,
      })
    }),
  )
})