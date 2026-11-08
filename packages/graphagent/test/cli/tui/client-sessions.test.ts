import { beforeEach, expect, test } from "bun:test"
import { ClientSessions } from "@/session/client-sessions"

beforeEach(() => ClientSessions.clear())

test("touch records sessions in insertion order", () => {
  ClientSessions.touch({ sessionID: "ses_a", directory: "/one" })
  ClientSessions.touch({ sessionID: "ses_b", directory: "/two" })

  expect(ClientSessions.list()).toEqual([
    { sessionID: "ses_a", directory: "/one" },
    { sessionID: "ses_b", directory: "/two" },
  ])
})

test("touch replaces the directory of an existing session without reordering", () => {
  ClientSessions.touch({ sessionID: "ses_a", directory: "/one" })
  ClientSessions.touch({ sessionID: "ses_b", directory: "/two" })
  ClientSessions.touch({ sessionID: "ses_a", directory: "/moved" })

  expect(ClientSessions.list()).toEqual([
    { sessionID: "ses_a", directory: "/moved" },
    { sessionID: "ses_b", directory: "/two" },
  ])
})

test("move updates the destination directory", () => {
  ClientSessions.touch({ sessionID: "ses_a", directory: "/one" })
  ClientSessions.move({ sessionID: "ses_a", directory: "/two" })

  expect(ClientSessions.list()).toEqual([{ sessionID: "ses_a", directory: "/two" }])
})

test("clear removes every session", () => {
  ClientSessions.touch({ sessionID: "ses_a", directory: "/one" })
  ClientSessions.clear()

  expect(ClientSessions.list()).toEqual([])
})
