import * as Tool from "./tool"
import DESCRIPTION from "./submit_result.txt"
import { Effect, Option, Schema } from "effect"
import { validatePayloadAsync, getCaptureSnapshot } from "@/dag/runtime/capture"
import { persistValidatedCapture } from "@/dag/runtime/final-response"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { InstanceState } from "@/effect/instance-state"

const id = "submit_result"

export const Parameters = Schema.Struct({
  payload: Schema.Unknown.annotate({
    description:
      "JSON value matching the node's declared output_schema (object, array, string, number, boolean, or null).",
  }),
})

type Metadata = { captured?: boolean }

export const SubmitResultTool = Tool.define<typeof Parameters, Metadata, never>(
  id,
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const storeOpt = yield* Effect.serviceOption(DagStore.Service)
          if (Option.isNone(storeOpt)) {
            return {
              title: "submit_result not applicable",
              output: "submit_result is not available in this session.",
              metadata: {} as Metadata,
            }
          }
          const result = yield* Effect.promise((signal) =>
            validatePayloadAsync(ctx.sessionID, params.payload, AbortSignal.any([signal, ctx.abort])),
          )
          if (!result.ok) {
            if (result.notAvailable) {
              return {
                title: "submit_result not applicable",
                output:
                  "submit_result has no effect in this session — it is only for DAG workflow child sessions that declared an output_schema.",
                metadata: {} as Metadata,
              }
            }
            return {
              title: "submit_result validation failed",
              output: `Validation failed: ${result.error}. Please correct the payload and call submit_result again.`,
              metadata: {} as Metadata,
            }
          }
          let snapshotID = getCaptureSnapshot(ctx.sessionID)
          const messages = yield* Effect.serviceOption(DagMessages.Service)
          let caller: DagMessages.Caller | undefined
          let guard: Omit<DagMessages.Guard, "snapshotID" | "close"> | undefined
          if (Option.isSome(messages)) {
            const instance = yield* InstanceState.context
            caller = { projectID: instance.project.id, directory: instance.directory, sessionID: ctx.sessionID }
            const identity = yield* messages.value.revisions(caller)
            if (!identity.ok || identity.value.endpoint.kind !== "node")
              return {
                title: "submit_result not applicable",
                output: "This session is not a current DAG node attempt.",
                metadata: {},
              }
            const snapshot = yield* messages.value.snapshotForTurn(caller, ctx.messageID)
            if (!snapshot.ok || !snapshot.value)
              return {
                title: "submit_result input unavailable",
                output:
                  "This tool call has no recorded input snapshot. Consume current agent input before submitting a result.",
                metadata: {},
              }
            snapshotID = snapshot.value.id
            const endpoint = identity.value.endpoint
            guard = {
              workflowID: endpoint.workflowID!,
              nodeID: endpoint.nodeID!,
              attemptID: endpoint.attemptID!,
            }
          }
          const captured = yield* persistValidatedCapture({
            store: storeOpt.value,
            sessionID: ctx.sessionID,
            validated: result,
            abort: ctx.abort,
            snapshotID,
            caller,
            guard,
          })
          if (!captured.ok)
            return {
              title: "submit_result input changed",
              output: Option.isSome(messages)
                ? `Submission was not captured (${captured.reason}). Consume the current agent input before submitting an updated result. Previously completed tools remain recorded; do not repeat their writes.`
                : "Submission was not captured because its capture slot changed or validation was cancelled.",
              metadata: {},
            }
          return {
            title: "Structured output submitted",
            output: "submit_result succeeded. Your structured output has been captured.",
            metadata: { captured: true } as Metadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
