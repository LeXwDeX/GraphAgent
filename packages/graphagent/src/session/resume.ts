// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import type { SessionAdmission } from "@graphagent/core/session/admission"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Effect, Option, Schema } from "effect"
import type { HookLifecycle } from "@/hook/lifecycle"
import type { HookStartContext } from "@/hook/start-context"
import { SessionCancellation } from "./cancellation"
import { ChildAdmission } from "./child/admission"
import type { ChildRunCredential } from "./child/types"
import type { SessionLocks } from "./locks"
import { MessageV2 } from "./message-v2"
import type { Interface, PromptError } from "./prompt"
import { HookPendingInput, type CommandInput } from "./prompt-input"
import type { SessionRunState } from "./run-state"
import { MessageID, type SessionID } from "./schema"
import type { Session } from "./session"
import type { Admit } from "./turn/admit"
import { originFor, type Interface as TurnsInterface, type TurnExecution, type TurnOrigin } from "./turns"

export class NoPendingHookInput extends Schema.TaggedError<NoPendingHookInput>()("NoPendingHookInput", {
  message: Schema.String,
}) {}

export interface ResumeDeps {
  readonly sessions: Session.Interface
  readonly state: SessionRunState.Interface
  readonly database: Database.Interface
  readonly hookLifecycle: HookLifecycle.Interface | undefined
  readonly startContext: HookStartContext.Interface | undefined
  readonly locks: SessionLocks
  readonly followupAdmissions: typeof SessionCancellation.admissions
  readonly admit: Pick<ReturnType<typeof Admit.makeAdmit>, "prompt" | "admitPrompt" | "resumeContexts">
  /** Late-bound: the command service is built after resume, and calls it back. */
  readonly command: (
    input: CommandInput,
    options: { readonly skipHookStart: true },
  ) => Effect.Effect<SessionV1.WithParts, PromptError>
  /** Late-bound so resume can start a turn through the turns service built after it. */
  readonly turns: () => TurnsInterface
  readonly runTurn: (sessionID: SessionID) => Effect.Effect<TurnExecution>
  readonly lastAssistant: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>
}

/**
 * Hook-followup resume of the prompt service (Issue #1019, PR-b). Moved
 * verbatim out of `prompt.ts`: `resume` registers a followup admission owner,
 * opens the run request before the prompt lock, and starts the deferred or
 * initial-hook turn; `finishPendingInput` then runs the saved followup.
 */
export function makeResume(deps: ResumeDeps) {
  const {
    sessions,
    state,
    database,
    hookLifecycle,
    startContext,
    locks,
    followupAdmissions,
    admit,
    command,
    turns,
    runTurn,
    lastAssistant,
  } = deps
  const { promptLocks, withRunRequest } = locks
  // A cancel also fences followups started by a different layer graph.
  const cancelEpoch = SessionCancellation.epoch

  const pendingMessageID = (metadata: Session.Info["metadata"]) => {
    const saved = (metadata ?? {}).hookPendingInput
    if (typeof saved !== "object" || saved === null || !("messageID" in saved)) return undefined
    return typeof saved.messageID === "string" ? saved.messageID : undefined
  }
  const writePendingInput = Effect.fnUntraced(function* (
    sessionID: SessionID,
    pending: typeof HookPendingInput.Type | undefined,
    guard?: (current: Session.Info) => boolean,
  ) {
    const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
    const metadata = { ...current.metadata }
    if (pending) metadata.hookPendingInput = pending
    else delete metadata.hookPendingInput
    // The guard runs inside setMetadata, after any delayed commit barrier, so
    // a cancel that lands while this write is queued still wins.
    yield* sessions.setMetadata({ sessionID, metadata }, guard)
  })
  const pendingInput = (metadata: Session.Info["metadata"]) =>
    metadata?.hookPendingInput === undefined
      ? Effect.succeed(undefined)
      : Schema.decodeUnknownEffect(HookPendingInput)(metadata.hookPendingInput).pipe(
          Effect.mapError(
            () =>
              new NoPendingHookInput({
                message:
                  "The saved hook followup has an unsupported or corrupt format. Inspect it before resubmitting.",
              }),
          ),
        )
  const finishPendingInput = Effect.fnUntraced(function* (
    sessionID: SessionID,
    completed: SessionV1.WithParts | null,
    epoch: number,
    credential?: ChildRunCredential,
  ) {
    if (
      !completed ||
      completed.info.role !== "assistant" ||
      completed.info.error ||
      completed.info.finish === "tool_deferred" ||
      completed.info.finish === "tool_deferred_unavailable"
    )
      return completed
    return yield* followupAdmissions
      .run(sessionID, (commit) =>
        Effect.gen(function* () {
          const pending = yield* promptLocks.withLock(sessionID)(
            commit(
              Effect.gen(function* () {
                if (cancelEpoch(sessionID) !== epoch) return undefined
                const item = yield* pendingInput((yield* sessions.get(sessionID).pipe(Effect.orDie)).metadata)
                if (!item) return undefined
                const recorded = yield* MessageV2.exists({
                  sessionID,
                  messageID: item.messageID,
                }).pipe(Effect.provideService(Database.Service, database), Effect.orDie)
                if (recorded) {
                  yield* writePendingInput(sessionID, undefined, (current) => {
                    const saved = pendingMessageID(current.metadata)
                    return saved === undefined || saved === item.messageID
                  })
                  return undefined
                }
                // A crash after claiming a command may have happened before its message was
                // recorded. Preserve that uncertain outcome instead of repeating side effects.
                if (item.phase === "started")
                  return yield* new NoPendingHookInput({
                    message:
                      "The saved followup was already started but has no recorded message. Inspect the session before resubmitting it.",
                  })
                yield* writePendingInput(sessionID, { ...item, phase: "started" }, (current) => {
                  return cancelEpoch(sessionID) === epoch && pendingMessageID(current.metadata) === item.messageID
                })
                // The guard can only skip the write; confirm the claim survived
                // before running the pending followup.
                const claimed = yield* pendingInput((yield* sessions.get(sessionID).pipe(Effect.orDie)).metadata)
                if (!claimed || claimed.phase !== "started" || claimed.messageID !== item.messageID) return undefined
                return item
              }),
            ),
          )
          if (!pending) return completed
          const shared = { sessionID, messageID: pending.messageID, hookMode: "noninteractive" as const }
          return yield* (
            pending.input.kind === "command"
              ? command({ ...pending.input, ...shared }, { skipHookStart: true })
              : admit.prompt(
                  { ...pending.input, ...shared },
                  {
                    skipHookStart: true,
                    ...(pending.internalDelegation ? { internalDelegation: true as const } : {}),
                  },
                  // A delegation's saved followup is the prompt of the run that saved it: it runs under that credential.
                  pending.internalDelegation && credential ? { credential } : undefined,
                )
          ).pipe(
            Effect.ensuring(
              promptLocks.withLock(sessionID)(
                Effect.gen(function* () {
                  const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
                  const saved = yield* pendingInput(current.metadata).pipe(Effect.option)
                  if (Option.isNone(saved) || saved.value?.messageID !== pending.messageID) return
                  const recorded = yield* MessageV2.exists({
                    sessionID,
                    messageID: pending.messageID,
                  }).pipe(Effect.provideService(Database.Service, database), Effect.orDie)
                  if (recorded)
                    yield* writePendingInput(sessionID, undefined, (current) => {
                      return pendingMessageID(current.metadata) === pending.messageID
                    })
                }),
              ),
            ),
          )
        }),
      )
      .pipe(Effect.catchTag("SessionConversationHookBlocked", () => Effect.succeed(completed)))
  })

  const resume: Interface["resume"] = Effect.fn("SessionPrompt.resume")(function* (input, options) {
    const epoch = cancelEpoch(input.sessionID)
    // Register the owner before waiting on the prompt lock. Cancel then fences
    // a followup that has not reached the lock yet, and a resume started after
    // cancel returns registers a fresh owner as a new request.
    const result = followupAdmissions
      .run(
        input.sessionID,
        (commit): Effect.Effect<Effect.Effect<SessionV1.WithParts | null>, PromptError | SessionAdmission.Blocked> =>
          withRunRequest(input.sessionID, (request, witness) =>
            locks.withPromptLock(witness, input.sessionID, () =>
              Effect.gen(function* () {
                if (!request.valid()) return yield* Effect.interrupt
                const target = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
                const contexts = yield* admit.resumeContexts(target)
                if (startContext) for (const context of contexts) yield* startContext.append(input.sessionID, context)
                const initial =
                  input.hookMode !== "interactive" && hookLifecycle
                    ? yield* hookLifecycle.consumeInitial(input.sessionID)
                    : undefined
                const users = yield* MessageV2.recentUsers({ sessionID: input.sessionID, limit: 1 }).pipe(
                  Effect.provideService(Database.Service, database),
                  Effect.orDie,
                )
                const initialTurn = !!initial && users.length === 0
                const latest = Option.getOrUndefined(
                  yield* sessions
                    .findMessage(input.sessionID, (message) => message.info.role === "assistant")
                    .pipe(Effect.orDie),
                )
                const deferred = latest?.parts.some(
                  (part) => part.type === "tool" && part.state.status === "pending" && part.state.deferred,
                )
                const saved = yield* pendingInput(target.metadata)
                if (!initialTurn && !deferred && !saved) {
                  if (input.initialOnly) return Effect.succeed<SessionV1.WithParts | null>(null)
                  return yield* new NoPendingHookInput({
                    message: "No initial hook message or deferred tool call is pending",
                  })
                }
                if (input.followup) {
                  if (saved)
                    return yield* new NoPendingHookInput({
                      message: "A supplied followup is already saved for this session",
                    })
                  yield* commit(
                    writePendingInput(
                      input.sessionID,
                      {
                        version: 1,
                        messageID: input.followup.messageID ?? MessageID.ascending(),
                        phase: "pending",
                        input: input.followup,
                        ...(options?.internalDelegation ? { internalDelegation: true } : {}),
                      },
                      (current) =>
                        cancelEpoch(input.sessionID) === epoch && pendingMessageID(current.metadata) === undefined,
                    ),
                  )
                }
                if (initialTurn) {
                  const admitted = yield* admit
                    .admitPrompt(
                      {
                        ...input,
                        parts: [{ type: "text", text: initial }],
                        hookMode: input.hookMode ?? "noninteractive",
                      },
                      undefined,
                      options?.internalDelegation ? { internalDelegation: true } : undefined,
                      undefined,
                      undefined,
                      options?.credential,
                    )
                    .pipe(Effect.catchTag("SessionConversationHookBlocked", (error) => Effect.die(error)))
                  if (!admitted.run) return Effect.succeed<SessionV1.WithParts | null>(admitted.message)
                } else if (input.hookMode) {
                  const user = users[0]?.info
                  if (user?.role === "user" && user.hookMode !== input.hookMode)
                    yield* sessions.updateMessage({ ...user, hookMode: input.hookMode })
                }
                if (!initialTurn && !deferred) return lastAssistant(input.sessionID)
                // Fork the runner under the same commit lock as the owner check:
                // a cancel cannot land between the check and the fork. Wait outside
                // the prompt lock; the loop machine claims it for its snapshot.
                const origin: TurnOrigin = options?.internalDelegation
                  ? originFor(options, options.credential)
                  : input.followup?.kind === "command"
                    ? { kind: "user", via: "command" }
                    : { kind: "user", via: "prompt" }
                const handle = turns().begin(input.sessionID, origin)
                return yield* commit(
                  Effect.gen(function* () {
                    const result = yield* state.ensureRunningHandle(
                      input.sessionID,
                      lastAssistant(input.sessionID),
                      turns()
                        .track(
                          handle,
                          ChildAdmission.observe("loop", { id: input.sessionID }, options?.credential).pipe(
                            Effect.andThen(runTurn(input.sessionID)),
                          ),
                        )
                        .pipe(Effect.map((turn) => turn.message)),
                      request,
                    )
                    // Same settlement as `loop`: a join drops this request's
                    // tracked work before it can write or settle a row.
                    yield* turns().watch(handle, result)
                    return result
                  }),
                )
              }),
            ),
          ),
      )
      .pipe(
        Effect.flatten,
        Effect.catchTag("SessionConversationHookBlocked", (error) =>
          Effect.fail(new NoPendingHookInput({ message: error.reason })),
        ),
      )
    return yield* finishPendingInput(input.sessionID, yield* result, epoch, options?.credential)
  })

  return { resume }
}
