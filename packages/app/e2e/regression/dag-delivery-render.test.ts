import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/DagDeliveryRender"
const projectID = "proj_dag_delivery_render"
const sessionID = "ses_dag_delivery_render"
const requestID = "msg_dag_delivery_request"
const deliveryID = "msg_dag_delivery_generated"
const followupID = "msg_dag_delivery_followup"
const sourceID = "prt_dag_delivery_source"
const answerID = "prt_dag_delivery_answer"
const followupTextID = "prt_dag_delivery_followup_text"
const title = "DAG delivery render"
const sourceText = "DAG · Release workflow · final-report"
const answerText = "DAG DELIVERY BODY: the release report is ready."
const followupText = "FOLLOWUP USER TURN remains visible."

const messages = [
  {
    info: {
      id: requestID,
      sessionID,
      role: "user",
      time: { created: 10 },
    },
    parts: [{ id: "prt_dag_delivery_request", sessionID, messageID: requestID, type: "text", text: "run workflow" }],
  },
  {
    info: {
      id: deliveryID,
      sessionID,
      parentID: requestID,
      role: "assistant",
      agent: "build",
      mode: "build",
      modelID: "test-model",
      providerID: "opencode",
      path: { cwd: directory, root: directory },
      time: { created: 20, completed: 20 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [
      {
        id: sourceID,
        sessionID,
        messageID: deliveryID,
        type: "text",
        text: sourceText,
        time: { start: 20, end: 20 },
        metadata: { dag_delivery: { kind: "source", workflow_id: "wf_release", node_id: "final-report" } },
      },
      {
        id: answerID,
        sessionID,
        messageID: deliveryID,
        type: "text",
        text: answerText,
        time: { start: 20, end: 20 },
        metadata: { dag_delivery: { kind: "answer", workflow_id: "wf_release", node_id: "final-report" } },
      },
    ],
  },
  {
    info: {
      id: followupID,
      sessionID,
      role: "user",
      time: { created: 30 },
    },
    parts: [{ id: followupTextID, sessionID, messageID: followupID, type: "text", text: followupText }],
  },
]

test("renders DAG delivery source and answer once, then renders the next user message", async ({ page }) => {
  await mockOpenCodeServer(page, {
    sessions: [
      {
        id: sessionID,
        slug: "dag-delivery-render",
        projectID,
        title,
        directory,
        version: "test",
        time: { created: 10, updated: 30 },
      },
    ],
    provider: { all: [], default: {}, connected: [] },
    directory,
    project: { id: projectID, worktree: directory, sandboxes: [] },
    pageMessages: () => ({ items: messages }),
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const source = page.locator(`[data-timeline-part-id="${sourceID}"]`)
  const answer = page.locator(`[data-timeline-part-id="${answerID}"]`)
  const followup = page.locator(`[data-timeline-part-id="${followupTextID}"]`)
  await expect(source).toHaveCount(1)
  await expect(source).toContainText(sourceText)
  await expect(source).toBeVisible()
  await expect(answer).toHaveCount(1)
  await expect(answer).toContainText(answerText)
  await expect(answer).toBeVisible()
  await expect(followup).toHaveCount(1)
  await expect(followup).toContainText(followupText)
  await expect(followup).toBeVisible()
})
