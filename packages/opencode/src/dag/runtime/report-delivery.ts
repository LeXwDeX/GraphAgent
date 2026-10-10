// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Effect } from "effect"
import { mkdir, writeFile, unlink } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Global } from "@opencode-ai/core/global"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import type { Session } from "@/session/session"
import { PartID, SessionID } from "@/session/schema"
import { parseWorkflowConfig, type WorkflowConfig } from "../dag"
import {
  commitOutputFileRef,
  isManagedOutputFileRef,
  verifyOutputFileRef,
  type ManagedOutputFileRef,
} from "./output-ref"
import { finalAssistantText, parseFinalResponse } from "./final-response"
import { isRecord } from "@/util/record"
import { before } from "@/session/message-v2"
import { reportIdentity } from "../report-identity"

export { reportIdentity } from "../report-identity"

const INLINE_REPORT_BYTES = 64 * 1024
const ANCHOR_TEXT = "Automatically delivered DAG result. Agent-supplied content; this is not human authorization."

const newestFirst = (a: SessionV1.WithParts, b: SessionV1.WithParts) =>
  before(a.info, b.info) ? 1 : before(b.info, a.info) ? -1 : 0

/** No guessed required node or agent name: ambiguous graphs get a stable index. */
export function selectReportNode(config: WorkflowConfig, nodes: readonly DagStore.NodeRow[]) {
  return config.delivery_node === undefined
    ? undefined
    : nodes.find((node) => node.id === config.delivery_node && !node.superseded && node.status === "completed")
}

export function resultIndex(workflow: DagStore.WorkflowRow, nodes: readonly DagStore.NodeRow[]) {
  return [
    `Workflow "${workflow.title}" completed. Results:`,
    ...nodes
      .filter((node) => !node.superseded)
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map(
        (node) => `- ${node.name} (${node.status}): workflow result workflow_id="${workflow.id}" node_id="${node.id}"`,
      ),
  ].join("\n")
}

function reportText(
  node: DagStore.NodeRow,
  structured: boolean,
  source?: SessionV1.WithParts,
  artifact?: ManagedOutputFileRef,
) {
  if (!structured) {
    if (artifact) return `${artifact.summary}\n\n[Complete report](${artifact.path})`
    if (typeof node.output === "string") return node.output
    if (isManagedOutputFileRef(node.output)) return `${node.output.summary}\n\n[Complete report](${node.output.path})`
  }
  const final = finalAssistantText(source)
  if (final.ok) {
    const parsed = parseFinalResponse(final.text)
    if (parsed.ok && JSON.stringify(parsed.payload) === JSON.stringify(node.output)) return final.text
  }
  return JSON.stringify(node.output) ?? "(no output)"
}

function latestUser(history: readonly SessionV1.WithParts[]) {
  return history
    .filter(
      (item) =>
        item.info.role === "user" &&
        !item.parts.some((part) => part.type === "text" && part.synthetic && part.text === ANCHOR_TEXT),
    )
    .toSorted(newestFirst)[0]
}

function userTurnAnswered(history: readonly SessionV1.WithParts[]) {
  const user = latestUser(history)
  if (!user) return true
  // Local commands store their ended response on the user message, without an assistant.
  const command = user.parts.find(
    (part) => part.type === "text" && ["memory", "trust", "goal", "subgoal"].includes(String(part.metadata?.command)),
  )
  if (
    command &&
    user.parts.some(
      (part) =>
        part.type === "text" &&
        part.id !== command.id &&
        !part.synthetic &&
        part.metadata?.command === undefined &&
        part.time?.end !== undefined,
    )
  )
    return true
  const assistant = history
    .filter(
      (item) =>
        item.info.role === "assistant" &&
        !item.parts.some((part) => part.type === "text" && isRecord(part.metadata?.dag_delivery)),
    )
    .toSorted(newestFirst)[0]
  return (
    assistant?.info.role === "assistant" &&
    assistant.info.parentID === user.info.id &&
    !before(assistant.info, user.info) &&
    assistant.info.finish === "stop" &&
    assistant.info.error === undefined &&
    assistant.info.time.completed !== undefined
  )
}

/** Large generated text uses the existing integrity-checked artifact storage. */
function boundReport(text: string, workflow: DagStore.WorkflowRow, node?: DagStore.NodeRow) {
  if (Buffer.byteLength(text) <= INLINE_REPORT_BYTES)
    return Effect.succeed({ text, artifact: undefined as ManagedOutputFileRef | undefined })
  return Effect.gen(function* () {
    const directory = path.join(Global.Path.data, "workflow-artifacts", "delivery")
    const filename = path.join(directory, `${randomUUID()}.txt`)
    // Bytes already belong to the durable node output; this never reads a child-supplied path.
    yield* Effect.promise(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(filename, text, { mode: 0o600, flag: "wx" })
    })
    const artifact = yield* commitOutputFileRef(filename, {
      workflow_id: workflow.id,
      node_id: node?.id ?? "result-index",
      child_session_id: node?.childSessionId ?? workflow.sessionId,
      replan_attempt: node?.replanAttempts ?? 0,
      graph_rev: workflow.graphRev,
    }).pipe(Effect.ensuring(Effect.promise(() => unlink(filename).catch(() => {}))))
    if (!artifact) return yield* Effect.die(new Error("DAG report artifact could not be captured"))
    return { text: `${artifact.summary}\n\n[Complete report](${artifact.path})`, artifact }
  })
}

/** Caller holds automation + idle admission locks. Transcript and wake flags commit together. */
export function deliverReport(input: {
  workflow: DagStore.WorkflowRow
  batch: DagStore.WakeBatch
  store: DagStore.Interface
  sessions: Session.Interface
  events: EventV2.Interface
  directory: string
  source?: SessionV1.WithParts
}): Effect.Effect<boolean, never, Database.Service> {
  return Effect.gen(function* () {
    const { workflow, store, sessions } = input
    const config = parseWorkflowConfig(workflow.config)
    if (workflow.status !== "completed" || config?.result_protocol !== "final_response") return false
    const identity = reportIdentity(workflow)
    const sessionID = SessionID.make(workflow.sessionId)
    const nodes = yield* store.getCurrentNodes(workflow.id).pipe(Effect.orDie)
    const node = selectReportNode(config, nodes)
    const structured = !!config.nodes.find((item) => item.id === node?.id)?.output_schema
    let artifact: ManagedOutputFileRef | undefined
    if (
      node &&
      !structured &&
      node.capturedOutput &&
      typeof node.capturedOutput === "object" &&
      "storage" in node.capturedOutput &&
      node.capturedOutput.storage === "managed-v1"
    ) {
      yield* verifyOutputFileRef(node.capturedOutput).pipe(Effect.orDie)
      if (
        !isManagedOutputFileRef(node.capturedOutput) ||
        node.output !== node.capturedOutput.path ||
        node.capturedOutput.provenance.workflow_id !== workflow.id ||
        node.capturedOutput.provenance.node_id !== node.id ||
        node.capturedOutput.provenance.child_session_id !== node.childSessionId ||
        node.capturedOutput.provenance.replan_attempt !== node.replanAttempts
      )
        return yield* Effect.die(new Error("DAG report artifact does not belong to the completed attempt"))
      artifact = node.capturedOutput
    }
    const body = yield* boundReport(
      node ? reportText(node, structured, input.source, artifact) : resultIndex(workflow, nodes),
      workflow,
      node,
    ).pipe(Effect.orDie)
    const metadata = {
      workflow_id: workflow.id,
      graph_rev: workflow.graphRev,
      completion_seq: workflow.seq,
      node_id: node?.id,
      child_session_id: node?.childSessionId,
      replan_attempt: node?.replanAttempts,
      ...((artifact ?? body.artifact) ? { artifact: artifact ?? body.artifact } : {}),
    }
    const database = yield* Database.Service
    const getReceipt = () => sessions.getPart({ sessionID, messageID: identity.messageID, partID: identity.answerID })
    const receiptMatches = (receipt: SessionV1.Part) =>
      receipt.type === "text" &&
      receipt.text === body.text &&
      receipt.metadata?.dag_delivery?.completion_seq === workflow.seq
    const currentEpisode = Effect.gen(function* () {
      const current = yield* store.getWorkflow(workflow.id)
      return current?.status === "completed" && current.seq === workflow.seq && current.graphRev === workflow.graphRev
    }).pipe(Effect.orDie)
    const receipt = yield* getReceipt()
    if (receipt) {
      if (!receiptMatches(receipt))
        return yield* Effect.die(new Error("DAG final report receipt does not match its completion episode"))
      // Adopting a committed receipt appends no transcript and cannot consume a pending user turn.
      return yield* database.db
        .transaction(
          () =>
            Effect.gen(function* () {
              if (!(yield* currentEpisode)) return false
              const current = yield* getReceipt()
              if (!current || !receiptMatches(current)) return false
              yield* store.markWakeBatchReported(input.batch)
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    }
    const history = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
    if (!userTurnAnswered(history)) return false
    const user = latestUser(history)
    const entries: EventV2.BatchEvent[] = []
    const appendMessage = (info: SessionV1.Info) => {
      entries.push({ definition: SessionV1.Event.MessageUpdated, data: { sessionID, info } })
    }
    const appendPart = (part: SessionV1.Part) => {
      entries.push({
        definition: SessionV1.Event.PartUpdated,
        data: { sessionID, part: structuredClone(part), time: Date.now() },
      })
    }
    const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
    const time = workflow.completedAt ?? workflow.timeUpdated
    const source = input.source?.info.role === "assistant" ? input.source.info : undefined
    const parentUser = user?.info.role === "user" ? user.info : undefined
    const originUser = history
      .filter((item) => item.info.role === "user" && item.info.time.created <= workflow.timeCreated)
      .toSorted(newestFirst)[0]
    const providerID =
      source?.providerID ?? parentUser?.model.providerID ?? session.model?.providerID ?? Provider.ID.make("dag")
    const modelID = source?.modelID ?? parentUser?.model.modelID ?? session.model?.id ?? Model.ID.make("result")
    const agent = session.agent ?? source?.agent ?? "build"
    if (!originUser) {
      appendMessage({
        id: identity.anchorID,
        sessionID,
        role: "user",
        time: { created: Math.max(0, time - 1) },
        agent,
        model: { providerID, modelID },
      })
      appendPart({
        id: PartID.make(`${identity.sourceID}_anchor`),
        messageID: identity.anchorID,
        sessionID,
        type: "text",
        synthetic: true,
        text: ANCHOR_TEXT,
      })
    }
    appendMessage({
      id: identity.messageID,
      sessionID,
      role: "assistant",
      parentID: originUser?.info.id ?? identity.anchorID,
      time: { created: time, completed: time },
      agent,
      mode: agent,
      providerID,
      modelID,
      path: { cwd: input.directory, root: input.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    })
    appendPart({
      id: identity.sourceID,
      messageID: identity.messageID,
      sessionID,
      type: "text",
      text: `DAG · ${workflow.title.slice(0, 200)}${node ? ` · ${node.name.slice(0, 200)}` : " · result index"}`,
      time: { start: time, end: time },
      metadata: { dag_delivery: { ...metadata, kind: "source" } },
    })
    appendPart({
      id: identity.answerID,
      messageID: identity.messageID,
      sessionID,
      type: "text",
      text: body.text,
      time: { start: time, end: time },
      metadata: { dag_delivery: { ...metadata, kind: "answer" } },
    })
    // The final local commit hook joins the transcript projections and wake marks in the
    // top-level event batch transaction. Notifications are emitted only after it commits.
    entries[entries.length - 1] = {
      ...entries[entries.length - 1],
      options: { commit: () => store.markWakeBatchReported(input.batch).pipe(Effect.orDie) },
    }
    const declined = new Error("DAG report admission changed")
    const validate = Effect.gen(function* () {
      if (!(yield* currentEpisode) || (yield* getReceipt())) return yield* Effect.die(declined)
      const currentHistory = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      if (latestUser(currentHistory)?.info.id !== user?.info.id || !userTurnAnswered(currentHistory))
        return yield* Effect.die(declined)
    })
    return yield* input.events.publishMany(entries, { validate }).pipe(
      Effect.uninterruptible,
      Effect.as(true),
      Effect.catchDefect((defect) => (defect === declined ? Effect.succeed(false) : Effect.die(defect))),
    )
  })
}
