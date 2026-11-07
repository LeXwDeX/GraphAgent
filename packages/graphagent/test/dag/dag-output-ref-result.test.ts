// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- tool-level
// probes deliberately mirror dag-rev-view-status.test.ts: mocked service
// layers and row fixtures use `as never`-style shims (mock objects implement
// only the interface slice the scenario exercises). The shims are type-only;
// converting them would fork the template's shape without changing behavior.
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Train B probe B-p3 — workflow tool `result` action seam
 * (workflows/dag-engine-optimization.md, v1.0.15 ledger, decision B3).
 *
 * The `result` action is how the parent agent reads a durable node output.
 * For a node whose submit-time capture recorded a file_ref in captured_output,
 * the action must return the durable pointer — content_ref + summary (first
 * ~200 chars, captured at submit time) + path — instead of paging raw text;
 * the parent agent fetches content itself with the read tool. Inline outputs
 * (legacy strings and output_schema payloads) keep the existing paged read
 * verbatim — no migration, no shape change for them.
 *
 * RED on the unmodified engine: the result action never inspects
 * captured_output and pages the raw output string, so the content_ref field
 * is absent and the summary is missing.
 */
import { describe, expect } from "bun:test"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { Cause, Effect, Layer } from "effect"
import { commitOutputFileRef } from "@/dag/runtime/output-ref"
import { DagStore } from "@opencode-ai/core/dag/store"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Event } from "@opencode-ai/schema/event"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Skill } from "@/skill"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WorkflowTool } from "@/tool/workflow"
import { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

const projectID = ProjectV2.ID.make("project_test")

const refPath = path.join(os.tmpdir(), "dag-ref-result", "report.md")
const refRecord = {
  kind: "file_ref" as const,
  content_ref: refPath,
  path: refPath,
  size: 4096,
  sha256: "0".repeat(64),
  summary: "Report summary captured at submit time",
}
const refRow = {
  id: "node_ref",
  workflowId: "dag_output_ref",
  name: "Report node",
  workerType: "build",
  status: "completed",
  required: true,
  dependsOn: [],
  modelId: null,
  modelProviderId: null,
  childSessionId: null,
  output: refPath,
  capturedOutput: refRecord,
  errorReason: null,
  errorClass: null,
  deadlineMs: null,
  wakeEligible: false,
  wakeReported: false,
  replanAttempts: 0,
  timeoutExtensions: 0,
  escalationPending: false,
  superseded: false,
  seq: 1,
  startedAt: 1,
  completedAt: 2,
  timeCreated: 1,
  timeUpdated: 2,
}
const inlineRow = {
  ...refRow,
  id: "node_inline",
  name: "Inline node",
  output: "plain inline output",
  capturedOutput: null,
  seq: 2,
}
const rows = [refRow, inlineRow]

const storeImpl = {
  getWorkflow: (id: string) =>
    Effect.succeed(
      id === "dag_output_ref"
        ? {
            id,
            projectId: projectID,
            sessionId: "ses_ref_parent",
            directory: null,
            title: "Output ref workflow",
            status: "completed",
            config: "{}",
            seq: 2,
            wakeReported: true,
            graphRev: 1,
            startedAt: 1,
            completedAt: 2,
            timeCreated: 1,
            timeUpdated: 2,
          }
        : undefined,
    ),
  getNodes: () => Effect.succeed(rows),
  getCurrentNodes: () => Effect.succeed(rows),
  getNode: (workflowID: string, nodeID: string) =>
    Effect.succeed(rows.find((node) => node.workflowId === workflowID && node.id === nodeID)),
}

const dag = Dag.layer.pipe(
  Layer.provide(Layer.mock(DagStore.Service, storeImpl)),
  Layer.provide(Layer.mock(EventV2Bridge.Service, {
    publish: (definition, data) =>
      Effect.succeed({ id: Event.ID.create(), type: definition.type, data }),
  })),
)

const runtime = testEffect(
  Layer.mergeAll(
    Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "build",
          mode: "all",
          permission: [],
          options: {},
          description: "",
          prompt: "",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          tools: {},
          hooks: {},
        }),
      list: () => Effect.succeed([]),
    }),
    Layer.mock(Skill.Service, { all: () => Effect.succeed([]) }),
    Layer.mock(Truncate.Service, {
      output: (content) => Effect.succeed({ content, truncated: false }),
    }),
    Layer.mock(Question.Service, { ask: () => Effect.succeed([]) }),
    Layer.mock(Provider.Service, {
      list: () => Effect.succeed({}),
      getModel: (providerID, modelID) => Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID })),
    }),
    dag,
    Layer.mock(Session.Service, {
      get: (id: Parameters<Session.Interface["get"]>[0]) =>
        Effect.succeed({
          id,
          slug: "output-ref",
          projectID,
          directory: process.cwd(),
          parentID: undefined,
          title: "Output ref",
          version: "test",
          time: { created: 0, updated: 0 },
          model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
        } satisfies Session.Info),
    }),
  ),
)

function toolContext() {
  return {
    sessionID: SessionID.make("ses_ref_parent"),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  } satisfies Tool.Context
}

describe("workflow tool result — file-ref view (Train B, B-p3)", () => {
  for (const corrupt of [false, true]) {
    runtime.effect(`verifies managed receipts at the result boundary (corrupt=${corrupt})`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dag-result-managed-"))),
        (directory) => Effect.gen(function* () {
          const source = path.join(directory, "report.md")
          yield* Effect.promise(() => fs.writeFile(source, `result boundary ${directory}`))
          const ref = yield* commitOutputFileRef(source, {
            workflow_id: "dag_output_ref", node_id: "node_managed", child_session_id: "ses-managed", replan_attempt: 0,
          })
          if (!ref) throw new Error("missing managed receipt")
          return yield* Effect.acquireUseRelease(
            Effect.sync(() => rows.push({ ...refRow, id: "node_managed", output: ref.path, capturedOutput: ref })),
            () => Effect.gen(function* () {
              yield* Effect.promise(() => fs.unlink(source))
              if (corrupt) {
                yield* Effect.promise(() => fs.chmod(ref.path, 0o600))
                yield* Effect.promise(() => fs.unlink(ref.path))
              }
              const info = yield* WorkflowTool
              const workflow = yield* info.init()
              const result = yield* Effect.exit(workflow.execute(
                { params: { action: "result", workflow_id: Dag.ID.make("dag_output_ref"), node_id: Dag.NodeID.make("node_managed") } },
                toolContext(),
              ))
              if (corrupt) {
                expect(result._tag).toBe("Failure")
                if (result._tag === "Failure") expect(Cause.pretty(result.cause)).toContain("Managed DAG artifact unavailable")
              } else {
                expect(result._tag).toBe("Success")
                if (result._tag === "Success") expect(JSON.parse(result.value.output)).toEqual(expect.objectContaining({
                  path: ref.path, storage: "managed-v1", artifact_status: "committed", provenance: ref.provenance,
                }))
              }
            }),
            () => Effect.gen(function* () {
              rows.splice(rows.findIndex((row) => row.id === "node_managed"), 1)
              yield* Effect.promise(() => fs.rm(path.dirname(ref.path), { recursive: true, force: true }))
            }),
          )
        }),
        (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
      ),
    )
  }

  runtime.effect("result returns content_ref + summary + path for a captured file ref", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        { params: { action: "result", workflow_id: Dag.ID.make("dag_output_ref"), node_id: Dag.NodeID.make("node_ref") } },
        toolContext(),
      )
      const parsed = JSON.parse(result.output)
      expect(parsed).toEqual(expect.objectContaining({
        workflow_id: "dag_output_ref",
        node_id: "node_ref",
        status: "completed",
        content_ref: refPath,
        path: refPath,
        summary: "Report summary captured at submit time",
        size: 4096,
        sha256: "0".repeat(64),
        truncated: false,
        next_cursor: null,
      }))
      expect(parsed.content).toBeUndefined()
    }),
  )

  runtime.effect("result keeps the paged inline read verbatim for legacy outputs", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        { params: { action: "result", workflow_id: Dag.ID.make("dag_output_ref"), node_id: Dag.NodeID.make("node_inline") } },
        toolContext(),
      )
      const parsed = JSON.parse(result.output)
      expect(parsed).toEqual(expect.objectContaining({
        workflow_id: "dag_output_ref",
        node_id: "node_inline",
        status: "completed",
        content: "plain inline output",
        truncated: false,
        next_cursor: null,
      }))
      expect(parsed.content_ref).toBeUndefined()
    }),
  )
})
