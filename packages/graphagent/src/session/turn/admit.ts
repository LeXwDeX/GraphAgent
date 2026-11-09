// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import type { DagMessages } from "@graphagent/core/dag/messages"
import type { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { Logging } from "@graphagent/core/observability/logging"
import { ToolBudget } from "@graphagent/core/session/tool-budget"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Deferred, Effect, Exit, Fiber, Option, type Scope } from "effect"
import { HOOK_REWAKE_SENTINEL, SettingsHook, type TriggerResult } from "@/hook"
import { HookModelMetrics } from "@/hook/model-metrics"
import { HookSessionContext } from "@/hook/session-context"
import type { HookStartContext } from "@/hook/start-context"
import { HookTranscript } from "@/hook/transcript"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import type { SessionAttention } from "@/notification/attention"
import type { Skill } from "@/skill"
import type { Goal } from "@/goal/goal"
import type { Config } from "@/config/config"
import { Filesystem } from "@/util/filesystem"
import { SessionAbortReason } from "../abort-reason"
import { SessionCancellation } from "../cancellation"
import { MessageID, PartID, type SessionID } from "../schema"
import type { SessionAutomationLease } from "../automation-lease"
import type { Session } from "../session"
import type { SessionRevert } from "../revert"
import type { SessionRunState } from "../run-state"
import type { SessionStatus } from "../status"
import {
  dropReverted,
  originFor,
  type AdmissionCommit,
  type AdmissionOptions,
  type Interface as TurnsInterface,
  type ModelBaseline,
  type TurnOrigin,
} from "../turns"
import type { Interface, PromptError, PromptInput } from "../prompt"
import type { CreateUserMessage, PrepareApi } from "./prepare"

export interface AdmitDeps {
  readonly sessions: Session.Interface
  readonly status: SessionStatus.Interface
  readonly state: SessionRunState.Interface
  readonly revert: SessionRevert.Interface
  readonly config: Config.Interface
  readonly scope: Scope.Scope
  readonly db: Database.Interface["db"]
  readonly promptLocks: KeyedMutex.KeyedMutex<SessionID>
  readonly followupAdmissions: typeof SessionCancellation.admissions
  readonly settingsHook: SettingsHook.Interface | undefined
  readonly startContext: HookStartContext.Interface | undefined
  readonly hookSkills: Skill.Interface | undefined
  readonly attention: SessionAttention.Interface | undefined
  readonly goal: Goal.Interface | undefined
  readonly agentMessages: DagMessages.Interface | undefined
  readonly activateAgentHooks: (session: Session.Info, name?: string) => Effect.Effect<void>
  readonly createUserMessage: CreateUserMessage
  readonly budgetState: (sessionID: SessionID) => Effect.Effect<{
    active?: ToolBudget.Budget
    pending: Map<MessageID, ToolBudget.Budget>
  }>
  readonly restoreModelContext: PrepareApi["restoreModelContext"]
  readonly resume: Interface["resume"]
  /** Late-bound so the turns service can depend on this admission layer. */
  readonly turns: () => TurnsInterface
}

export function makeAdmit(deps: AdmitDeps) {
  const {
    sessions,
    status,
    state,
    revert,
    config,
    scope,
    db,
    promptLocks,
    followupAdmissions,
    settingsHook,
    startContext,
    hookSkills,
    attention,
    goal,
    agentMessages,
    activateAgentHooks,
    createUserMessage,
    budgetState,
    restoreModelContext,
    resume,
    turns,
  } = deps

  // Cancellation owns the durable followup cleanup even when the target
  // instance is not loaded: the session row is global, so this must not be
  // skipped by the instance-routing no-op.
  const clearPendingHookInput = Effect.fnUntraced(function* (sessionID: SessionID, snapshot: string | undefined) {
    if (snapshot === undefined) return
    yield* db
      .transaction(
        () =>
          Effect.gen(function* () {
            const target = yield* sessions.get(sessionID).pipe(Effect.option)
            if (Option.isNone(target) || JSON.stringify(target.value.metadata?.hookPendingInput) !== snapshot) return
            const metadata = { ...target.value.metadata }
            delete metadata.hookPendingInput
            yield* sessions.setMetadata(
              { sessionID, metadata },
              (current) => JSON.stringify(current.metadata?.hookPendingInput) === snapshot,
            )
          }),
        { behavior: "immediate" },
      )
      .pipe(
        Effect.catchCause((cause) => Effect.logWarning("session cancel followup cleanup failed", { sessionID, cause })),
      )
  })

  const pauseGoalForCancel = Effect.fnUntraced(function* (sessionID: SessionID) {
    // GOAL-TURN-SCOPE (ESC semantics): ESC on a goal-driven turn means "stop
    // working on the goal", not just "stop this turn". Without this, the idle
    // event after cancel re-enters afterIdle, shouldPreempt returns false (the
    // last user message is the /goal command itself, necessarily older than
    // this turn's assistant output), and the judge auto-resurrects the goal
    // with a continuation the user just tried to abort. Pause instead.
    if (goal && (yield* goal.isTurnDriven(sessionID))) {
      yield* goal.pauseForUserCancel(sessionID, "用户中断（ESC）— /goal resume 继续").pipe(Effect.ignore)
    }
  })

  const cancelImpl = Effect.fnUntraced(function* (sessionID: SessionID) {
    yield* Logging.backgroundDebug("lifecycle.session.cancel", { source: "session.prompt.cancel", sessionID })
    yield* Effect.logInfo("cancel", { "session.id": sessionID })
    if (agentMessages) {
      const context = yield* InstanceState.context
      const identity = { projectID: context.project.id, directory: context.directory, sessionID }
      const input = yield* agentMessages.revisions(identity)
      if (input.ok && input.value.snapshotID)
        yield* agentMessages.markStopped(identity, input.value.snapshotID, "cancelled")
      yield* agentMessages.discardPending(identity, "cancelled")
    }
    yield* state.cancelBackground(sessionID, true)
  })

  const cancel = Effect.fn("SessionPrompt.cancel")(function* (
    sessionID: SessionID,
    options?: { readonly reason?: SessionAbortReason.Info },
  ) {
    // ESC's epoch bump and rewake-generation reset live in one place
    // (`Turns.beginCancel`); every other cancel action stays here.
    const cancellation = yield* turns().beginCancel(sessionID)
    const abort = options?.reason
    let transferred = false
    let waiters: Array<Fiber.Fiber<void>> = []
    const release = () => {
      if (abort) SessionAbortReason.clear(sessionID, abort)
      cancellation.finish()
    }
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const pendingSnapshot = Deferred.makeUnsafe<string | undefined>()
        const action = cancellation.previous.pipe(
          Effect.andThen(
            followupAdmissions.cancel(
              sessionID,
              Effect.gen(function* () {
                const pending = yield* Deferred.await(pendingSnapshot)
                yield* clearPendingHookInput(sessionID, pending)
                if (abort) SessionAbortReason.set(sessionID, abort)
                const target = yield* sessions.get(sessionID).pipe(Effect.option)
                const current = yield* InstanceRef
                const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
                const store = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
                const provideIfLoaded = store?.provideIfLoaded
                const pause =
                  Option.isSome(target) && current && provideIfLoaded
                    ? provideIfLoaded({ directory: target.value.directory }, pauseGoalForCancel(sessionID)).pipe(
                        Effect.asVoid,
                      )
                    : pauseGoalForCancel(sessionID)
                const pauseExit = yield* pause.pipe(Effect.exit)
                cancellation.finishGoalCancel()
                if (Exit.isFailure(pauseExit))
                  yield* Effect.logWarning("session cancel goal pause failed", { sessionID })
                const local =
                  Option.isSome(target) && current && provideIfLoaded
                    ? provideIfLoaded({ directory: target.value.directory }, cancelImpl(sessionID)).pipe(Effect.asVoid)
                    : cancelImpl(sessionID)
                const owners = Effect.forEach(
                  cancellation.targets,
                  (owner) =>
                    Effect.gen(function* () {
                      const stop =
                        owner.directory && provideIfLoaded
                          ? provideIfLoaded({ directory: owner.directory }, owner.cancel).pipe(
                              Effect.tap((result) =>
                                Option.isNone(result)
                                  ? Effect.logWarning("session cancel owner unavailable", {
                                      sessionID,
                                      directory: owner.directory,
                                    })
                                  : Effect.void,
                              ),
                              Effect.asVoid,
                            )
                          : owner.cancel
                      const fiber = yield* stop.pipe(Effect.forkIn(scope, { startImmediately: true }))
                      const result = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("3 seconds"))
                      if (Option.isNone(result) || Exit.isFailure(result.value))
                        yield* Effect.logWarning("session cancel owner did not settle", {
                          sessionID,
                          directory: owner.directory,
                        })
                      return Option.isNone(result) ? fiber : undefined
                    }),
                  { concurrency: "unbounded" },
                )
                const origin =
                  Option.isSome(target) &&
                  current &&
                  Filesystem.resolve(current.directory) !== Filesystem.resolve(target.value.directory)
                    ? state.cancelBackground(sessionID, true)
                    : Effect.void
                const [localExit, originExit, pendingOwners] = yield* Effect.all(
                  [local.pipe(Effect.exit), origin.pipe(Effect.exit), owners],
                  {
                    concurrency: "unbounded",
                  },
                )
                if (Exit.isFailure(localExit) || Exit.isFailure(originExit))
                  yield* Effect.logWarning("session cancel local cleanup failed", { sessionID })
                const unsettled = pendingOwners.filter((fiber) => fiber !== undefined)
                waiters = unsettled
              }),
            ),
          ),
        )
        const { InstanceStore: Store } = yield* Effect.promise(() => import("@/project/instance-store"))
        const store = Option.getOrUndefined(yield* Effect.serviceOption(Store.Service))
        const fiber = yield* action.pipe(Effect.forkIn(scope, { startImmediately: true }))
        const read = yield* sessions.get(sessionID).pipe(Effect.option, Effect.exit)
        if (Exit.isFailure(read)) {
          yield* Deferred.succeed(pendingSnapshot, undefined)
          yield* Fiber.await(fiber)
          return yield* read
        }
        const target = read.value
        yield* Deferred.succeed(
          pendingSnapshot,
          Option.isSome(target) ? JSON.stringify(target.value.metadata?.hookPendingInput) : undefined,
        )
        if (Option.isSome(target) && store?.provideIfLoaded) {
          const loaded = yield* store.provideIfLoaded({ directory: target.value.directory }, Effect.void)
          if (Option.isNone(loaded) && InstanceState.isClosing(Filesystem.resolve(target.value.directory))) {
            yield* clearPendingHookInput(sessionID, JSON.stringify(target.value.metadata?.hookPendingInput))
            const completed = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("1 second"))
            if (Option.isNone(completed)) {
              yield* Fiber.await(fiber).pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    Effect.forEach(waiters, Fiber.await, { concurrency: "unbounded", discard: true }),
                  ),
                ),
                Effect.ensuring(Effect.sync(release)),
                Effect.forkIn(scope, { startImmediately: false }),
              )
              transferred = true
              return
            }
          }
        }
        yield* Fiber.join(fiber)
        if (waiters.length) {
          yield* Effect.forEach(waiters, Fiber.await, { concurrency: "unbounded", discard: true }).pipe(
            Effect.ensuring(Effect.sync(release)),
            Effect.forkIn(scope, { startImmediately: false }),
          )
          transferred = true
        }
      }).pipe(
        Effect.onInterrupt(() => Effect.forEach(waiters, Fiber.await, { concurrency: "unbounded", discard: true })),
      ),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (!transferred) release()
        }),
      ),
    )
  }, Effect.uninterruptible)

  // Re-validates the rewake token carried by an async Stop-hook rewake.
  // Returns false when the chain was reset (session cancel, newer user
  // prompt, SessionEnd) after the callback's own completion check; the
  // committed message parts are then marked ignored so nothing stale stays
  // model-visible, and the caller must not run the turn. No-op for plain
  // prompts and non-Stop async rewakes (no token).
  const fenceRewake = Effect.fn("SessionPrompt.fenceRewake")(function* (
    sessionID: SessionID,
    options: AdmissionOptions | undefined,
    message: SessionV1.WithParts,
  ) {
    if (!settingsHook?.validateRewakeToken || options?.rewakeToken === undefined) return true
    if (yield* settingsHook.validateRewakeToken(sessionID, options.rewakeToken)) return true
    yield* Effect.logWarning("rewake token stale after commit", { "session.id": sessionID })
    for (const part of message.parts) {
      if (part.type === "text" && !part.ignored) {
        yield* sessions.updatePart({ ...part, ignored: true } satisfies SessionV1.TextPart)
      }
    }
    yield* sessions.touch(sessionID)
    return false
  })

  // SessionStart(source: "resume"): fires once, on the first prompt admission of a top-level
  // session this instance did not create (SessionLifecycle.create marks created sessions as
  // started) that already has earlier messages — e.g. a session reopened after a restart.
  // Empty sessions and child sessions never fire. Returns the contexts to inject; hook failures
  // never fail the prompt. No hook configured → trigger short-circuits, so cost is one Set lookup
  // plus a one-row message read per session per instance.
  const resumeContexts = Effect.fn("SessionPrompt.resumeContexts")(function* (target: {
    id: SessionID
    parentID?: SessionID
  }) {
    if (!startContext || !settingsHook || target.parentID) return [] as string[]
    if (!(yield* startContext.claimResume(target.id))) return [] as string[]
    const prior = yield* sessions.messages({ sessionID: target.id, limit: 1 }).pipe(Effect.orDie)
    if (prior.length === 0) return [] as string[]
    const current = yield* sessions.get(target.id).pipe(Effect.orDie)
    yield* restoreModelContext(target.id)
    const history = yield* HookTranscript.history(
      target.id,
      yield* sessions.messages({ sessionID: target.id }).pipe(Effect.orDie),
    )
    const metrics = yield* HookModelMetrics.forSession({
      source: "resume",
      sessionID: target.id,
      title: current.title,
      titleSource: current.metadata?.hookTitleSource,
      model: current.model,
      agent: current.agent,
      history,
    })
    const result = yield* settingsHook
      .trigger(
        {
          event: "SessionStart",
          source: "resume",
          // Child sessions never reach here (checked above): report DAG mode read-only.
          ...(current.dagMode !== undefined ? { dagMode: current.dagMode } : {}),
          ...metrics,
        },
        { sessionID: target.id },
      )
      .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
    const instance = yield* InstanceState.context
    const skills = hookSkills
    yield* HookSessionContext.applyStart({
      session: { id: target.id, directory: instance.directory },
      sessions,
      settings: settingsHook,
      result,
      reloadSkills: skills?.reload(),
    })
    yield* SettingsHook.landSystemMessages(result, { sessionID: target.id })
    return (result.additionalContexts ?? []).filter((ctx) => ctx.length > 0)
  })

  const admitPrompt = Effect.fn("SessionPrompt.admitPrompt")(function* (
    input: PromptInput,
    persistAdmission?: Effect.Effect<void>,
    options?: AdmissionOptions,
    commitAdmission?: AdmissionCommit,
    modelBaseline?: ModelBaseline,
  ) {
    const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    // Reverted turns disappear with the messages the cleanup removes.
    yield* dropReverted({ db, sessions }, session)
    yield* revert.cleanup(session)
    yield* activateAgentHooks(session, input.agent)

    // SettingsHook: UserPromptSubmit — gives hooks a chance to block or modify the turn.
    // Runs BEFORE the prompt is persisted: a blocked prompt (e.g. a secret scanner)
    // must never be stored as model-visible history (Claude Code erases it from
    // context). Loop guard (hook-async-rewake): skip hooks for rewake prompts (those
    // whose text starts with HOOK_REWAKE_SENTINEL) to prevent hook → rewake → hook loops.
    let hookAdditionalContexts: string[] = []
    let hookResult: TriggerResult | undefined
    const promptText = input.parts.map((p: any) => (p.type === "text" ? p.text : "")).join("\n")
    const isRewake = promptText.startsWith(HOOK_REWAKE_SENTINEL)
    // Refuse a stale rewake before anything is committed. Cancel stays
    // lock-free; the post-commit fence below covers cancels that land while
    // admission is suspended inside hook callbacks.
    if (settingsHook?.validateRewakeToken && isRewake && options?.rewakeToken !== undefined) {
      const tokenValid = yield* settingsHook.validateRewakeToken(input.sessionID, options.rewakeToken)
      if (!tokenValid) {
        yield* Effect.logWarning("rewake token stale before admission", { "session.id": input.sessionID })
        // Record the discard in the transcript (`ignored` keeps it out of
        // model input) so the refusal is observable, then stop without work.
        const message = yield* createUserMessage(
          {
            ...input,
            parts: [
              {
                type: "text",
                text: "[Hook stopped] async hook result discarded (session cancelled or superseded)",
                ignored: true,
              },
            ],
          },
          persistAdmission,
          commitAdmission,
          modelBaseline,
        )
        yield* sessions.touch(input.sessionID)
        return { message, run: false as const }
      }
    }
    // CC's `prompt_id` names the prompt being submitted, but the message row is
    // only persisted after UserPromptSubmit has run. Allocate the identity now
    // and reuse it below, so the envelope and the transcript name the same
    // message. A caller-supplied id (queued/follow-up prompts) wins.
    const promptMessageID = input.messageID ?? MessageID.ascending()
    if (settingsHook && !isRewake && options?.internalDelegation !== true) {
      // session_title is present only for a title the user or a hook chose, never for a generated one.
      const titled = session.metadata?.hookTitleSource === "custom" && session.title ? session.title : undefined
      hookResult = yield* settingsHook
        .trigger(
          {
            event: "UserPromptSubmit",
            prompt: promptText,
            ...(titled !== undefined ? { sessionTitle: titled } : {}),
            // Child sessions do not report DAG mode; a top-level session reports it read-only.
            ...(session.parentID === undefined && session.dagMode !== undefined ? { dagMode: session.dagMode } : {}),
          },
          { sessionID: input.sessionID, promptID: promptMessageID },
        )
        .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
      hookAdditionalContexts = hookResult.additionalContexts ?? []
    }

    if (hookResult?.sessionTitle !== undefined) {
      yield* sessions.setTitle({ sessionID: input.sessionID, title: hookResult.sessionTitle })
    }
    if (hookResult && (hookResult.blocked || hookResult.preventContinuation)) {
      const reason = hookResult.stopReason ?? hookResult.blocked?.reason ?? "Hook requested stop"
      // The submitted parts are replaced by one user-visible notice. `ignored`
      // keeps it out of model input (and makes the message no model work
      // boundary); it is not synthetic so clients render it in the transcript.
      // The block message ends with the submitted text unless the hook set suppressOriginalPrompt. This changes
      // only the message: the text stays in local storage either way and never reaches the model.
      const original = hookResult.suppressOriginalPrompt === true ? "" : `\n\nOriginal prompt: ${promptText}`
      const message = yield* createUserMessage(
        {
          ...input,
          messageID: promptMessageID,
          parts: [{ type: "text", text: `[Hook stopped] ${reason}${original}`, ignored: true }],
        },
        persistAdmission,
        commitAdmission,
        modelBaseline,
      )
      yield* sessions.touch(input.sessionID)
      // systemMessages are logged only: nothing about a blocked prompt reaches the model.
      yield* SettingsHook.landSystemMessages(hookResult, { sessionID: input.sessionID })
      if (agentMessages) {
        const ctx = yield* InstanceState.context
        yield* agentMessages.discardPending(
          { projectID: ctx.project.id, directory: ctx.directory, sessionID: input.sessionID },
          "hook_blocked",
        )
      }
      return { message, run: false as const }
    }

    // Evaluated before the prompt is persisted so "earlier messages" excludes this turn.
    // Rewake prompts are internal re-entries into a live session and never claim resume.
    const resumeTexts = isRewake ? [] : yield* resumeContexts(session)

    const message = yield* createUserMessage(
      { ...input, messageID: promptMessageID },
      persistAdmission,
      commitAdmission,
      modelBaseline,
    )
    yield* sessions.touch(input.sessionID)

    // The token was validated before admission, but cancel can land while
    // the hook callbacks above suspend. A committed stale rewake is
    // stripped from model input (parts ignored) and never starts a run.
    if (isRewake && options?.rewakeToken !== undefined) {
      if (!(yield* fenceRewake(input.sessionID, options, message))) {
        return { message, run: false as const }
      }
    }

    if (hookResult) {
      // Land UserPromptSubmit systemMessages (logged always; injected as synthetic
      // parts so the model sees them — no silent drop).
      yield* SettingsHook.landSystemMessages(hookResult, {
        sessionID: input.sessionID,
        inject: (text) =>
          sessions.updatePart({
            id: PartID.ascending(),
            messageID: message.info.id,
            sessionID: input.sessionID,
            type: "text",
            text,
            synthetic: true,
          } satisfies SessionV1.TextPart),
      })
    }

    // SettingsHook: drain HookStartContext queued by SessionStart hooks (only if not blocked)
    let startContextTexts: string[] = []
    if (startContext) {
      startContextTexts = [...(yield* startContext.consume(input.sessionID))]
    }

    for (const ctx of [...resumeTexts, ...startContextTexts, ...hookAdditionalContexts]) {
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.info.id,
        sessionID: input.sessionID,
        type: "text",
        text: ctx,
        synthetic: true,
      } satisfies SessionV1.TextPart)
    }

    const permissions: PermissionV1.Rule[] = []
    for (const [t, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
    }

    if (!options?.continueToolBudget) {
      const state = yield* budgetState(input.sessionID)
      state.pending.set(message.info.id, ToolBudget.create((yield* config.get()).maxToolCalls))
    }

    return { message, run: input.noReply !== true }
  })

  const promptImpl = Effect.fnUntraced(function* (
    input: PromptInput,
    options?: AdmissionOptions,
    commitAdmission?: AdmissionCommit,
    modelBaseline?: ModelBaseline,
    origin: TurnOrigin = originFor(options),
  ) {
    if (attention) yield* attention.input(input.sessionID)
    if (
      !options?.skipHookStart &&
      !options?.continueToolBudget &&
      input.noReply !== true &&
      input.hookMode !== "interactive"
    ) {
      const { sessionID, ...followup } = input
      const initial = yield* resume(
        {
          sessionID,
          model: input.model,
          agent: input.agent,
          variant: input.variant,
          hookMode: "noninteractive",
          initialOnly: true,
          followup: { kind: "prompt", ...followup },
        },
        options?.internalDelegation ? { internalDelegation: true } : undefined,
      )
      if (initial) return initial
    }
    const started = yield* turns().start(input, {
      origin,
      when: "now",
      admissionOptions: options,
      commitAdmission,
      modelBaseline,
    })
    return yield* started.wait
  })
  const prompt: Interface["prompt"] = Effect.fn("SessionPrompt.prompt")(function* (input, options) {
    // Plain prompts never carry an admission commit; the internal command
    // path calls promptImpl directly so its cancellation fence stays typed.
    return yield* promptImpl(input, options).pipe(
      Effect.catchTag("SessionConversationHookBlocked", (error) => Effect.die(error)),
    )
  })

  const withIdle: Interface["withIdle"] = Effect.fn("SessionPrompt.withIdle")(
    <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>) =>
      promptLocks.withLock(sessionID)(
        Effect.gen(function* () {
          if ((yield* status.get(sessionID)).type !== "idle") return Option.none()
          return Option.some(yield* work)
        }),
      ),
  )

  // Thin wrapper: the two-phase idle protocol lives in `Turns.prepare`, which
  // keeps the pre-PR8 activation/abort contract used by `admitIfIdle`.
  const prepareIfIdle: Interface["prepareIfIdle"] = Effect.fn("SessionPrompt.prepareIfIdle")(function* (
    input: PromptInput,
    persistAdmission?: Effect.Effect<void>,
    options?: AdmissionOptions,
    request?: ReturnType<typeof SessionCancellation.request>,
  ) {
    return yield* turns().prepare(input, options, persistAdmission, request)
  })

  // Thin wrapper: idle admission is `Turns.start(when: "idle")`.
  const promptIfIdle: Interface["promptIfIdle"] = Effect.fn("SessionPrompt.promptIfIdle")(
    (input: PromptInput, options?: AdmissionOptions) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const started = yield* restore(
            turns()
              .start(input, { origin: originFor(options), when: "idle", admissionOptions: options })
              .pipe(Effect.catchTag("SessionConversationHookBlocked", (error) => Effect.die(error))),
          )
          if (started.admission.kind === "skipped_busy") return Option.none()
          return Option.some(yield* restore(started.wait))
        }),
      ),
  )

  return {
    cancel,
    prompt,
    withIdle,
    prepareIfIdle,
    promptIfIdle,
    admitPrompt,
    resumeContexts,
    promptImpl,
    fenceRewake,
  }
}

export function admitIfIdle(
  service: Interface,
  automation: SessionAutomationLease.Interface,
  token: SessionAutomationLease.Token,
  input: PromptInput,
  options?: AdmissionOptions,
  persistAdmission?: Effect.Effect<void>,
): Effect.Effect<Option.Option<Effect.Effect<SessionV1.WithParts>>, PromptError> {
  return Effect.suspend(() => {
    const request = SessionCancellation.request(input.sessionID)
    // Goal cancellation may need this lease, so wait before taking it.
    return request.wait.pipe(
      Effect.andThen(
        automation.handoff(
          token,
          Effect.suspend(() =>
            request.valid()
              ? service.prepareIfIdle(input, persistAdmission, options, request)
              : Effect.succeed(Option.none()),
          ),
        ),
      ),
      Effect.ensuring(Effect.sync(() => request.release())),
    )
  })
}

export * as Admit from "./admit"
