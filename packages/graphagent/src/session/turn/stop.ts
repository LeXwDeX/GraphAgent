import type { DagMessages } from "@graphagent/core/dag/messages"
import type { DagStore } from "@graphagent/core/dag/store"
import type { SessionV1 } from "@graphagent/core/v1/session"
import type { BackgroundJob } from "@/background/job"
import { SettingsHook, type TriggerResult } from "@/hook"
import type { HookLifecycle } from "@/hook/lifecycle"
import { TaskSubagents } from "@/hook/task-subagents"
import { HookTurnContext } from "@/hook/turn-context"
import { Effect } from "effect"
import { MessageV2 } from "../message-v2"
import { MessageID, PartID, type SessionID } from "../schema"
import type { Session } from "../session"
import type { SessionSummary } from "../summary"

export function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

export interface StopDeps {
  readonly sessions: Session.Interface
  readonly summary: SessionSummary.Interface
  readonly settingsHook: SettingsHook.Interface | undefined
  readonly hookLifecycle: HookLifecycle.Interface | undefined
  readonly agentMessages: DagMessages.Interface | undefined
  readonly backgroundJobs: BackgroundJob.Interface
  readonly workflowStore: DagStore.Interface
}

export interface StopAttemptInput {
  readonly sessionID: SessionID
  readonly session: Session.Info
  readonly identity: DagMessages.Caller
  readonly lastUser: SessionV1.User
  readonly lastAssistant: SessionV1.Assistant | undefined
  readonly lastAssistantMsg: SessionV1.WithParts | undefined
  readonly turnUserID: MessageID | undefined
  readonly turnError: SessionV1.Assistant["error"]
  readonly turnStopped: boolean
  readonly forceContinue: boolean
  readonly agentInputBlocked: boolean
  readonly agentBoundaryApproved: boolean
  readonly stopHookBlocked: boolean
  readonly stopContinuationCount: number
  readonly stopHookContinuationCap: number
}

export type StopKind = "proceed" | "continue" | "exit"

export interface StopAttemptResult {
  readonly kind: StopKind
  readonly forceContinue: boolean
  readonly turnStopped: boolean
  readonly agentBoundaryApproved: boolean
  readonly stopHookBlocked: boolean
  readonly stopContinuationCount: number
}

export function makeStop(deps: StopDeps) {
  const { sessions, summary, settingsHook, hookLifecycle, agentMessages, backgroundJobs, workflowStore } = deps

  const stopAttempt = Effect.fn("SessionPrompt.stopAttempt")(function* (input: StopAttemptInput) {
    const { sessionID, session, identity, lastUser, lastAssistant, lastAssistantMsg, turnUserID, turnError } = input
    const agentInputBlocked = input.agentInputBlocked
    const stopHookContinuationCap = input.stopHookContinuationCap
    let forceContinue = input.forceContinue
    let turnStopped = input.turnStopped
    let agentBoundaryApproved = input.agentBoundaryApproved
    let stopHookBlocked = input.stopHookBlocked
    let stopContinuationCount = input.stopContinuationCount
    const done = (kind: StopKind): StopAttemptResult => ({
      kind,
      forceContinue,
      turnStopped,
      agentBoundaryApproved,
      stopHookBlocked,
      stopContinuationCount,
    })

    // Some providers return "stop" even when the assistant message contains
    // tool calls. Keep the loop running so tool results can be sent back to
    // the model, but ignore cleanup-marked interrupted orphans.
    const hasToolCalls =
      lastAssistantMsg?.parts.some(
        (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
      ) ?? false

    if (
      turnStopped ||
      (lastAssistant?.finish &&
        !["tool-calls"].includes(lastAssistant.finish) &&
        !hasToolCalls &&
        MessageV2.before(lastUser, lastAssistant))
    ) {
      const orphan = lastAssistantMsg?.parts.find(
        (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
      )
      if (orphan) {
        yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
          "session.id": sessionID,
          messageID: lastAssistant?.id,
          tool: orphan.tool,
          callID: orphan.callID,
        })
      }
      // Stop-hook continuation: when forceContinue is set (a prior Stop hook
      // blocked), skip the Stop exit for one iteration so another model turn
      // runs; reset the flag so that turn can finish and Stop normally.
      if (forceContinue && !agentInputBlocked) {
        forceContinue = false
        turnStopped = false
      } else {
        yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
        let agentContinuationPrevented = false
        // Main-agent Stop does not fire for a foreground task-tool subagent's
        // clean exit: task.ts fires SubagentStop (and drives its continuation)
        // for it. task.ts fails a child that ended in error or was cancelled
        // without SubagentStop, so StopFailure still fires for those. Only
        // positively registered sessions are skipped; any other child
        // (SDK-created or background task) still fires Stop. DAG owners
        // defer their one notification until the whole attempt settles.
        const taskSubagentCleanExit =
          !turnError &&
          (TaskSubagents.delegateStop(sessionID) ||
            (hookLifecycle && (yield* hookLifecycle.isChildStopDelegated(sessionID))))
        // SettingsHook: Stop on clean turn exit, StopFailure when it ended in error.
        if (settingsHook && !taskSubagentCleanExit) {
          const lastAssistantMessage =
            lastAssistantMsg?.parts
              .filter((part): part is SessionV1.TextPart => part.type === "text")
              .map((part) => part.text)
              .join("") || undefined
          const stopPayload = turnError
            ? ({
                event: "StopFailure",
                stopHookActive: stopHookBlocked,
                ...HookTurnContext.failure(
                  turnError,
                  "message" in turnError.data && typeof turnError.data.message === "string"
                    ? turnError.data.message
                    : undefined,
                ),
              } as const)
            : session.parentID
              ? ({
                  event: "SubagentStop",
                  stopHookActive: stopHookBlocked,
                  lastAssistantMessage,
                  agentID: sessionID,
                  agentType: lastUser.agent,
                  backgroundTasks: yield* HookTurnContext.backgroundTasks(session.parentID, {
                    jobs: backgroundJobs,
                    workflows: workflowStore,
                  }),
                  sessionCrons: [],
                } as const)
              : ({
                  event: "Stop",
                  stopHookActive: stopHookBlocked,
                  lastAssistantMessage,
                  backgroundTasks: yield* HookTurnContext.backgroundTasks(sessionID, {
                    jobs: backgroundJobs,
                    workflows: workflowStore,
                  }),
                  sessionCrons: [],
                } as const)
          const stopResult = yield* settingsHook
            .trigger(stopPayload, {
              sessionID: session.parentID && !turnError ? session.parentID : sessionID,
            })
            .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult)))
          agentContinuationPrevented = stopResult.preventContinuation === true
          // `continue:false` ends the turn, so its stopReason can never be
          // model feedback. Land it as a user-visible notice.
          if (
            agentContinuationPrevented &&
            stopResult.stopReason &&
            !stopResult.systemMessages.includes(stopResult.stopReason)
          )
            yield* SettingsHook.landSystemMessages(
              { additionalContexts: [], systemMessages: [stopResult.stopReason] },
              { sessionID },
            )
          if (agentContinuationPrevented && agentMessages) {
            const input = lastAssistant && (yield* agentMessages.snapshotForTurn(identity, lastAssistant.id))
            if (input?.ok && input.value) yield* agentMessages.markStopped(identity, input.value.id, "hook_blocked")
            yield* agentMessages.discardPending(identity, "hook_blocked")
          }
          // Stop-hook block → drive another model turn. The next Stop then carries
          // stop_hook_active=true so a well-behaved hook stops blocking (anti-loop).
          // Capped by CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (default MAX_STOP_CONTINUATIONS)
          // so a hook that ignores the signal can't loop forever; at the limit we
          // log.warn and force a normal exit.
          const continuing =
            !agentInputBlocked &&
            !turnError &&
            stopResult.blocked !== undefined &&
            !stopResult.preventContinuation &&
            stopContinuationCount < stopHookContinuationCap
          // Consume Stop-hook outputs so nothing is silently dropped. On a
          // continuation they go into a new synthetic user message AFTER the
          // assistant reply (block reason last, so the request ends with the
          // instruction to continue — mirrors task.ts SubagentStop). On exit they
          // are recorded on the turn's user message (model-visible next prompt).
          const feedback: string[] = [...(stopResult.additionalContexts ?? [])]
          yield* SettingsHook.landSystemMessages(stopResult, {
            sessionID,
            inject: (message) => Effect.sync(() => feedback.push(message)),
          })
          if (continuing && stopResult.blocked) feedback.push(stopResult.blocked.reason || "Continue.")
          const target = continuing ? MessageID.ascending() : lastUser.id
          if (target !== lastUser.id) {
            yield* sessions.updateMessage({
              id: target,
              sessionID,
              role: "user",
              agent: lastUser.agent,
              model: lastUser.model,
              format: lastUser.format,
              system: lastUser.system,
              tools: lastUser.tools,
              time: { created: Date.now() },
            })
          }
          for (const text of feedback) {
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: target,
              sessionID,
              type: "text",
              text,
              synthetic: true,
            } satisfies SessionV1.TextPart)
          }
          if (!agentInputBlocked && !turnError && stopResult.blocked !== undefined && !stopResult.preventContinuation) {
            if (continuing) {
              stopContinuationCount++
              stopHookBlocked = true
              forceContinue = true
              return done("continue")
            }
            yield* Effect.logWarning("Stop hook continuation limit reached; forcing exit", {
              "session.id": sessionID,
              limit: stopHookContinuationCap,
            })
          }
        }
        if (!agentInputBlocked && !agentContinuationPrevented && !turnError && agentMessages) {
          const incoming = yield* agentMessages.revisions(identity)
          if (incoming.ok && incoming.value.queued > 0) {
            agentBoundaryApproved = true
            turnStopped = false
            return done("continue")
          }
        }
        if (turnUserID) yield* summary.summarizeTurn({ sessionID, userMessageIDs: [turnUserID] }).pipe(Effect.ignore)
        return done("exit")
      }
    }

    return done("proceed")
  })

  return { stopAttempt }
}

export * as Stop from "./stop"
