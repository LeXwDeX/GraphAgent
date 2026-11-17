// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Part } from "@graphagent/sdk"
import { Main } from "../../../src/routes/session"
import { assistantMessage, textPart, userMessage, type MessageEntry } from "../../fixture/session-records"
import { json } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor, type MountOptions } from "../dag-mode-harness"

// A session route can name a message (#1058 7: the toast of a finished background run brings the user to the report the
// server added, drawn as its result card). The view carries the jump out once the session is loaded, takes the request
// off the route, and a message that draws nothing takes the jump to the end of the transcript.

const ROOT = "ses_jump_root"
const CHILD = "ses_jump_child"

const HEAD = "HEAD-QUESTION"
const MID = "MID-QUESTION"
const TAIL = "TAIL-ANSWER"

const id = (ordinal: number) => `msg_jump_${String(ordinal).padStart(3, "0")}`
const MID_ID = id(21)
const REPORT_ID = id(42)

/** A long transcript: a question at the head, one in the middle, answers between, the report of a run, a last answer. */
function transcript(sessionID: string): MessageEntry[] {
  const entries: MessageEntry[] = []
  let ordinal = 0
  let question = ""
  const ask = (text: string) => {
    question = id(ordinal)
    entries.push({
      info: userMessage(question, sessionID, ordinal),
      parts: [textPart(question, sessionID, `prt_${question}`, text)],
    })
    ordinal++
  }
  const answer = (text: string) => {
    const messageID = id(ordinal)
    entries.push({
      info: assistantMessage(messageID, sessionID, question, ordinal),
      parts: [textPart(messageID, sessionID, `prt_${messageID}`, text)],
    })
    ordinal++
  }
  ask(`${HEAD}: where do we start?`)
  for (let index = 0; index < 20; index++) answer(`Answer ${index}\nsecond line\nthird line\nfourth line`)
  ask(`${MID}: what did the review find?`)
  for (let index = 20; index < 40; index++) answer(`Answer ${index}\nsecond line\nthird line\nfourth line`)
  // A user message whose only text is synthetic and carries no `backgroundResult`: it draws nothing.
  const report = id(ordinal)
  expect(report).toBe(REPORT_ID)
  const synthetic: Part = {
    ...textPart(report, sessionID, `prt_${report}`, "<task_result>done</task_result>"),
    synthetic: true,
  }
  entries.push({ info: userMessage(report, sessionID, ordinal), parts: [synthetic] })
  ordinal++
  answer(`${TAIL}: the review found nothing.`)
  return entries
}

const CARD = "CARD-REVIEW"
const CARD_ID = id(21)

/**
 * A long transcript with the report of a finished background run in its middle, as the server writes it: a user
 * message whose synthetic text carries `metadata.backgroundResult`, drawn as the run's result card.
 */
function cardTranscript(sessionID: string): MessageEntry[] {
  const entries: MessageEntry[] = []
  let ordinal = 0
  const question = id(ordinal)
  entries.push({
    info: userMessage(question, sessionID, ordinal),
    parts: [textPart(question, sessionID, `prt_${question}`, `${HEAD}: where do we start?`)],
  })
  ordinal++
  const answer = (text: string) => {
    const messageID = id(ordinal)
    entries.push({
      info: assistantMessage(messageID, sessionID, question, ordinal),
      parts: [textPart(messageID, sessionID, `prt_${messageID}`, text)],
    })
    ordinal++
  }
  for (let index = 0; index < 20; index++) answer(`Answer ${index}\nsecond line\nthird line\nfourth line`)
  const report = id(ordinal)
  expect(report).toBe(CARD_ID)
  const result: Part = {
    ...textPart(
      report,
      sessionID,
      `prt_${report}`,
      [
        `<task id="${CHILD}" state="completed">`,
        `<summary>Background task completed: ${CARD}</summary>`,
        "<task_result>",
        "The review found nothing.",
        "</task_result>",
        "</task>",
      ].join("\n"),
    ),
    synthetic: true,
    metadata: {
      backgroundResult: {
        childSessionID: CHILD,
        initiator: "agent",
        title: CARD,
        status: "completed",
        startedAt: 1_000,
        endedAt: 66_000,
      },
    },
  }
  entries.push({ info: userMessage(report, sessionID, ordinal), parts: [result] })
  ordinal++
  for (let index = 20; index < 40; index++) answer(`Answer ${index}\nsecond line\nthird line\nfourth line`)
  answer(`${TAIL}: the review found nothing.`)
  return entries
}

async function mountJump(extra: Partial<MountOptions> = {}, build: (sessionID: string) => MessageEntry[] = transcript) {
  const messages = build(ROOT)
  expect(messages[21]?.info.id).toBe(MID_ID)
  return mountRoute({
    route: { type: "session", sessionID: ROOT },
    view: () => <Main />,
    frame: true,
    height: 30,
    sessions: [
      sessionFixture(ROOT, { title: "main" }),
      sessionFixture(CHILD, { parentID: ROOT, title: "check (@explore subagent)", time: { created: 5, updated: 6 } }),
    ],
    handler: (url) => (url.pathname === `/session/${ROOT}/message` ? json(messages) : undefined),
    ...extra,
  })
}

type Harness = Awaited<ReturnType<typeof mountJump>>

const plain = (harness: Harness) => JSON.parse(JSON.stringify(harness.route().data))
const atEnd = (frame: string) => frame.includes(TAIL) && !frame.includes(HEAD) && !frame.includes(MID)
const atMiddle = (frame: string) => frame.includes(MID) && !frame.includes(HEAD) && !frame.includes(TAIL)

/** `session.first` and `session.last`, which the prompt's focus does not take from a modified key. */
const toTop = (harness: Harness) => harness.app.mockInput.pressKey("g", { ctrl: true })
const toEnd = (harness: Harness) => harness.app.mockInput.pressKey("g", { ctrl: true, meta: true })

test("a route that names a message scrolls to it, takes the request off the route, and scrolls again when asked again", async () => {
  const harness = await mountJump()
  try {
    // A session opens at its end.
    await harness.waitForFrame((frame) => frame.includes(TAIL), "the end of the transcript")

    harness.route().navigate({ type: "session", sessionID: ROOT, messageID: MID_ID })
    await harness.waitForFrame(atMiddle, "the message in the middle")
    expect(plain(harness)).toEqual({ type: "session", sessionID: ROOT })

    toEnd(harness)
    await harness.waitForFrame(atEnd, "the end again")
    // The same message, asked for a second time: nothing on the route has changed since, and it scrolls all the same.
    harness.route().navigate({ type: "session", sessionID: ROOT, messageID: MID_ID })
    await harness.waitForFrame(atMiddle, "the message in the middle, a second time")
    expect(plain(harness)).toEqual({ type: "session", sessionID: ROOT })
  } finally {
    await harness.dispose()
  }
})

test("from another session of the tree the jump is the last scroll: neither the load nor the snap to the end undoes it", async () => {
  const harness = await mountJump({ route: { type: "session", sessionID: CHILD } })
  try {
    // The sub-agent view is up, and the main session's messages are in the store, as they are for any ancestor.
    await waitFor(() => (harness.sync().data.message[ROOT]?.length ?? 0) > 0)
    await harness.settle()
    expect(await harness.frame()).not.toContain(TAIL)

    harness.route().navigate({ type: "session", sessionID: ROOT, messageID: MID_ID })
    await harness.waitForFrame(atMiddle, "the message in the middle of the main session")
    expect(plain(harness)).toEqual({ type: "session", sessionID: ROOT })

    // The snap to the end that a switch of session schedules is not taken for a request that names a message.
    await Bun.sleep(300)
    await harness.settle()
    expect(atMiddle(await harness.frame())).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("a message that draws nothing takes the jump to the end of the transcript", async () => {
  const harness = await mountJump()
  try {
    await harness.waitForFrame((frame) => frame.includes(TAIL), "the end of the transcript")
    toTop(harness)
    await harness.waitForFrame((frame) => frame.includes(HEAD) && !frame.includes(TAIL), "the head of the transcript")

    harness.route().navigate({ type: "session", sessionID: ROOT, messageID: REPORT_ID })
    await harness.waitForFrame(atEnd, "the end of the transcript")
    expect(plain(harness)).toEqual({ type: "session", sessionID: ROOT })

    // A message the session does not have is the same.
    toTop(harness)
    await harness.waitForFrame((frame) => frame.includes(HEAD) && !frame.includes(TAIL), "the head again")
    harness.route().navigate({ type: "session", sessionID: ROOT, messageID: "msg_jump_missing" })
    await harness.waitForFrame(atEnd, "the end once more")
  } finally {
    await harness.dispose()
  }
})

test("the report of a background run lands on its result card", async () => {
  const harness = await mountJump({}, cardTranscript)
  const atCard = (frame: string) => frame.includes(CARD) && !frame.includes(HEAD) && !frame.includes(TAIL)
  try {
    await harness.waitForFrame((frame) => frame.includes(TAIL), "the end of the transcript")
    toTop(harness)
    await harness.waitForFrame((frame) => frame.includes(HEAD) && !frame.includes(TAIL), "the head of the transcript")

    harness.route().navigate({ type: "session", sessionID: ROOT, messageID: CARD_ID })
    await harness.waitForFrame(atCard, "the result card")
    expect(plain(harness)).toEqual({ type: "session", sessionID: ROOT })

    // Asked for again from the end, it lands on the card again.
    toEnd(harness)
    await harness.waitForFrame(atEnd, "the end again")
    harness.route().navigate({ type: "session", sessionID: ROOT, messageID: CARD_ID })
    await harness.waitForFrame(atCard, "the result card, a second time")
  } finally {
    await harness.dispose()
  }
})
