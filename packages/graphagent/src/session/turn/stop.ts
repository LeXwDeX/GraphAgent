// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { DagMessages } from "@graphagent/core/dag/messages"
import type { DagStore } from "@graphagent/core/dag/store"
import type { SessionV1 } from "@graphagent/core/v1/session"
import type { BackgroundJob } from "@/background/job"
import { SettingsHook, type TriggerResult } from "@/hook"
import type { HookLifecycle } from "@/hook/lifecycle"
import { HookTurnContext } from "@/hook/turn-context"
import { Effect } from "effect"
import { ChildRegistry } from "../child/registry"
import { MessageID, PartID, type SessionID } from "../schema"
import type { Session } from "../session"
import type { Decide } from "./decide"

/**
 * Effectful Stop-hook phase of a completed turn (Issue #1019, PR7).
 *
 * The pure decision stays in `decide.ts`. This module only gathers the effectful
 * policy inputs, runs the hook, and writes its feedback, so the loop can call
 * `decide` between those phases. Statement order and side effects match the
 * pre-refactor `stopAttempt` block.
 */

export function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

export interface StopDeps {
  readonly sessions: Session.Interface
  readonly settingsHook: SettingsHook.Interface | undefined
  readonly hookLifecycle: HookLifecycle.Interface | undefined
  readonly agentMessages: DagMessages.Interface | undefined
  readonly backgroundJobs: BackgroundJob.Interface
  readonly workflowStore: DagStore.Interface
}

export interface StopPolicyInput {
  readonly sessionID: SessionID
  readonly session: Session.Info
  readonly error: SessionV1.Assistant["error"]
}

export interface StopPolicyResolution {
  readonly policy: Decide.StopPolicy
  /** The owner (task subagent or DAG) delivers Stop itself; this loop must not run it. */
  readonly ownerDefersStop: boolean
}

export interface RunStopHooksInput {
  readonly sessionID: SessionID
  readonly session: Session.Info
  readonly identity: DagMessages.Caller
  readonly lastUser: SessionV1.User
  readonly lastAssistant: SessionV1.Assistant | undefined
  readonly lastAssistantMsg: SessionV1.WithParts | undefined
  readonly event: Decide.StopHookEvent
  readonly error: SessionV1.Assistant["error"]
  readonly stopHookActive: boolean
}

export interface StopFeedbackInput {
  readonly sessionID: SessionID
  readonly lastUser: SessionV1.User
  readonly result: TriggerResult
  readonly continuing: boolean
}

const EMPTY_TRIGGER: TriggerResult = { additionalContexts: [], systemMessages: [] }

function makePolicyResolver(deps: StopDeps) {
  const { settingsHook, hookLifecycle } = deps
  return Effect.fnUntraced(function* (input: StopPolicyInput) {
    const event: Decide.StopHookEvent = input.error ? "StopFailure" : input.session.parentID ? "SubagentStop" : "Stop"
    // Main-agent Stop does not fire for a foreground task-tool subagent's clean
    // exit: task.ts fires SubagentStop (and drives its continuation) for it.
    // task.ts fails a child that ended in error or was cancelled without
    // SubagentStop, so StopFailure still fires for those. Only a session whose
    // active run is a foreground task's is skipped (`ChildRegistry.delegateStop`);
    // any other child still fires Stop. DAG owners defer their one notification
    // until the whole attempt settles.
    const ownerDefersStop =
      !input.error &&
      (ChildRegistry.delegateStop(input.sessionID) ||
        (hookLifecycle !== undefined && (yield* hookLifecycle.isChildStopDelegated(input.sessionID))))
    return { policy: { event, enabled: settingsHook !== undefined }, ownerDefersStop }
  })
}

function makeHookRunner(deps: StopDeps) {
  const { settingsHook, agentMessages, backgroundJobs, workflowStore } = deps
  return Effect.fnUntraced(function* (input: RunStopHooksInput) {
    if (!settingsHook) return EMPTY_TRIGGER
    const lastAssistantMessage =
      input.lastAssistantMsg?.parts
        .filter((part): part is SessionV1.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("") || undefined
    const failureDetail =
      input.error && "message" in input.error.data && typeof input.error.data.message === "string"
        ? input.error.data.message
        : undefined
    const stopPayload =
      input.event === "StopFailure"
        ? ({
            event: "StopFailure",
            stopHookActive: input.stopHookActive,
            ...HookTurnContext.failure(input.error, failureDetail),
          } as const)
        : input.event === "SubagentStop" && input.session.parentID
          ? ({
              event: "SubagentStop",
              stopHookActive: input.stopHookActive,
              lastAssistantMessage,
              agentID: input.sessionID,
              agentType: input.lastUser.agent,
              backgroundTasks: yield* HookTurnContext.backgroundTasks(input.session.parentID, {
                jobs: backgroundJobs,
                workflows: workflowStore,
              }),
              sessionCrons: [],
            } as const)
          : ({
              event: "Stop",
              stopHookActive: input.stopHookActive,
              lastAssistantMessage,
              backgroundTasks: yield* HookTurnContext.backgroundTasks(input.sessionID, {
                jobs: backgroundJobs,
                workflows: workflowStore,
              }),
              sessionCrons: [],
            } as const)
    const stopResult = yield* settingsHook
      .trigger(stopPayload, {
        sessionID: input.session.parentID && !input.error ? input.session.parentID : input.sessionID,
      })
      .pipe(Effect.catch(() => Effect.succeed(EMPTY_TRIGGER)))
    const prevented = stopResult.preventContinuation === true
    // `continue:false` ends the turn, so its stopReason can never be model
    // feedback. Land it as a user-visible notice.
    if (prevented && stopResult.stopReason && !stopResult.systemMessages.includes(stopResult.stopReason))
      yield* SettingsHook.landSystemMessages(
        { additionalContexts: [], systemMessages: [stopResult.stopReason] },
        { sessionID: input.sessionID },
      )
    if (prevented && agentMessages) {
      const snapshot =
        input.lastAssistant && (yield* agentMessages.snapshotForTurn(input.identity, input.lastAssistant.id))
      if (snapshot?.ok && snapshot.value) {
        yield* agentMessages.markStopped(input.identity, snapshot.value.id, "hook_blocked")
      }
      yield* agentMessages.discardPending(input.identity, "hook_blocked")
    }
    return stopResult
  })
}

function makeFeedbackWriter(deps: StopDeps) {
  const { sessions } = deps
  return Effect.fnUntraced(function* (input: StopFeedbackInput) {
    // Consume Stop-hook outputs so nothing is silently dropped. On a
    // continuation they go into a new synthetic user message AFTER the
    // assistant reply (block reason last, so the request ends with the
    // instruction to continue). On exit they are recorded on the turn's user
    // message (model-visible next prompt).
    const feedback: string[] = [...(input.result.additionalContexts ?? [])]
    yield* SettingsHook.landSystemMessages(input.result, {
      sessionID: input.sessionID,
      inject: (message) => Effect.sync(() => feedback.push(message)),
    })
    if (input.continuing && input.result.blocked) feedback.push(input.result.blocked.reason || "Continue.")
    const target = input.continuing ? MessageID.ascending() : input.lastUser.id
    if (target !== input.lastUser.id) {
      yield* sessions.updateMessage({
        id: target,
        sessionID: input.sessionID,
        role: "user",
        agent: input.lastUser.agent,
        model: input.lastUser.model,
        format: input.lastUser.format,
        system: input.lastUser.system,
        tools: input.lastUser.tools,
        time: { created: Date.now() },
      })
    }
    for (const text of feedback) {
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: target,
        sessionID: input.sessionID,
        type: "text",
        text,
        synthetic: true,
      } satisfies SessionV1.TextPart)
    }
  })
}

export function makeStop(deps: StopDeps) {
  return {
    resolvePolicy: makePolicyResolver(deps),
    runStopHooks: makeHookRunner(deps),
    applyStopFeedback: makeFeedbackWriter(deps),
  }
}

export * as Stop from "./stop"
