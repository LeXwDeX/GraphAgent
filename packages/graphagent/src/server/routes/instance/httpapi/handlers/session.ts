import { InstanceRef } from "@/effect/instance-ref"
import { SessionAttention } from "@/notification/attention"
import type { SessionAttentionInput } from "@graphagent/schema/session-attention"
import { LocalPermissionStartup } from "@/permission/local-startup"
import { Logging } from "@graphagent/core/observability/logging"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { SessionV1 } from "@graphagent/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { SessionLifecycle } from "@/session/lifecycle"
import { ClientSessions } from "@/session/client-sessions"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { DagStore } from "@graphagent/core/dag/store"
import { DEFAULT_WORKFLOW_CONFIG } from "@/dag/dag"
import { DagModeStatus } from "@/dag/mode-status"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { Goal } from "@/goal/goal"
import { SessionHooks, type SessionHookCommand } from "@/hook/session-hooks"
import { SettingsHook, type HookEvent } from "@/hook"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NamedError } from "@graphagent/core/util/error"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/http-api"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  ResumePayload,
  SetModelPayload,
  QueuedMessageDeletePayload,
  QueuedMessageEditPayload,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
  SessionHookAddPayload,
} from "../groups/session"
import { ConflictError, InvalidRequestError, PermissionNotFoundError, notFound } from "../errors"
import * as SessionError from "./session-errors"

const promptError = (error: unknown) =>
  error instanceof SessionPrompt.ModelSwitchBlocked || error instanceof SessionPrompt.NoPendingHookInput
    ? new InvalidRequestError({ name: "InvalidRequestError", data: { message: error.message } })
    : new HttpApiError.BadRequest({})

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const lifecycle = yield* SessionLifecycle.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const runState = yield* SessionRunState.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const goalSvc = yield* Goal.Service
    const sessionHooks = yield* SessionHooks.Service
    const settingsHooks = yield* SettingsHook.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const configSvc = yield* Config.Service
    const agents = yield* Agent.Service
    const providers = yield* Provider.Service
    const dagStore = yield* DagStore.Service
    const scope = yield* Scope.Scope

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const instance = yield* InstanceRef
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : instance?.directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    // #1013 (C1 PR5): read-only DAG mode status for the session. Availability
    // mirrors E4's degradation conditions; usage follows E4's accounting
    // (input + cache write + output + reasoning, cache read reported apart).
    const dagMode = Effect.fn("SessionHttpApi.dagMode")(function* (ctx: { params: { sessionID: SessionID } }) {
      const info = yield* requireSession(ctx.params.sessionID)
      const [globalConfig, mergedConfig] = yield* Effect.all([configSvc.getGlobal(), configSvc.get()])

      const agentInfo = info.agent
        ? yield* agents.get(info.agent)
        : yield* agents.defaultInfo().pipe(Effect.catch(() => Effect.succeed(undefined)))
      const policy = agentInfo ? yield* agents.permissionPolicy(agentInfo.name) : undefined
      const startDenied = policy
        ? Permission.disabledByPolicy(
            ["workflow"],
            policy.native,
            Permission.merge(policy.rules, info.permission ?? []),
          ).has("workflow")
        : false

      let modelRef: { providerID: ProviderV2.ID; modelID: ModelV2.ID } | undefined
      if (info.model) modelRef = { providerID: info.model.providerID, modelID: info.model.id }
      else if (agentInfo?.model) modelRef = { providerID: agentInfo.model.providerID, modelID: agentInfo.model.modelID }
      else modelRef = yield* providers.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      const model = modelRef
        ? yield* providers
            .getModel(modelRef.providerID, modelRef.modelID)
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined

      const workerCatalog = yield* agents.list().pipe(Effect.catch(() => Effect.succeed([])))
      const unavailableReason = DagModeStatus.unavailableReason({
        workflowToolDisabled: mergedConfig.tools?.workflow === false,
        startDenied,
        modelToolCalling: model?.capabilities.toolcall,
        hasWorker: workerCatalog.some((agent) => agent.mode === "subagent" || agent.mode === "all"),
      })

      const childSessionIDs = new Set<string>()
      for (const workflow of yield* dagStore.listBySession(info.id)) {
        for (const node of yield* dagStore.getNodes(workflow.id)) {
          if (node.childSessionId) childSessionIDs.add(node.childSessionId)
        }
      }
      const usages: DagModeStatus.TokenUsage[] = []
      for (const childSessionID of childSessionIDs) {
        const child = yield* session
          .get(SessionID.make(childSessionID))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (child?.tokens) usages.push(child.tokens)
      }
      const usage = DagModeStatus.sumUsage(usages)

      let running = 0
      for (const workflow of yield* dagStore.listWorkflows()) {
        running += (yield* dagStore.getRunningNodes(workflow.id)).length
      }

      return {
        mode: info.dagMode ?? "off",
        defaultMode: globalConfig.dag?.mode ?? "off",
        availability: unavailableReason ? ("unavailable" as const) : ("available" as const),
        unavailableReason,
        budget: {
          tokens: info.dagBudgetTokens ?? globalConfig.dag?.budget?.tokens ?? null,
          used: usage.used,
          usedCacheRead: usage.usedCacheRead,
          warnRatio: globalConfig.dag?.budget?.warn_ratio ?? DagModeStatus.DEFAULT_BUDGET_WARN_RATIO,
        },
        limits: {
          concurrency: globalConfig.dag?.concurrency ?? DEFAULT_WORKFLOW_CONFIG.maxConcurrency,
          maxTotalNodes: globalConfig.dag?.max_total_nodes ?? DEFAULT_WORKFLOW_CONFIG.maxTotalNodes,
          running,
        },
        quality: null,
      }
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const goal = Effect.fn("SessionHttpApi.goal")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      const state = yield* goalSvc.load(ctx.params.sessionID)
      // Goal.clear deletes the row outright, so a missing row means "no goal".
      // (done is also transient in practice — auto-cleared after the completion
      // message is emitted — so the only states returned are active / paused.)
      // 404 keeps the response schema honest: a 200 body always carries Goal.
      if (!state) return yield* Effect.fail(notFound(`No goal for session: ${ctx.params.sessionID}`))
      return Goal.toPublic(state)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* session
        .messagesPage({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        })
        .pipe(
          Effect.catchTags({
            SessionInvalidCursor: () => Effect.fail(new HttpApiError.BadRequest({})),
            NotFoundError: (error) => Effect.fail(notFound(error.message)),
          }),
        )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (
      payload?: Session.CreateInput,
      options?: SessionLifecycle.CreateOptions,
    ) {
      const created = yield* lifecycle.create(payload, options)
      ClientSessions.touch({ sessionID: created.id, directory: created.directory })
      return created
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const approved = LocalPermissionStartup.take(ctx.request.source)
      const localGrant =
        approved && permissionSvc.grantHookBypass
          ? LocalPermissionStartup.once(permissionSvc.grantHookBypass)
          : undefined
      const createLocal = (payload?: Session.CreateInput) => create(payload, { localGrant })
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* createLocal()

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* createLocal(payload)
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID))
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      return yield* SessionError.mapStorageNotFound(
        session.applyUpdate({ sessionID: ctx.params.sessionID, ...ctx.payload }),
      )
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      const forked = yield* SessionError.mapStorageNotFound(
        session.fork({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload?.messageID,
        }),
      )
      ClientSessions.touch({ sessionID: forked.id, directory: forked.directory })
      return forked
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* Logging.backgroundDebug("lifecycle.session.cancel", {
        source: "http.session.abort",
        sessionID: ctx.params.sessionID,
      })
      yield* promptSvc.cancel(ctx.params.sessionID)
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc
        .command({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return true
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      ClientSessions.touch({ sessionID: ctx.params.sessionID, directory: current.directory })
      yield* SessionError.mapStorageNotFound(
        promptSvc.summarize({
          sessionID: ctx.params.sessionID,
          providerID: ctx.payload.providerID,
          modelID: ctx.payload.modelID,
          auto: ctx.payload.auto,
        }),
      )
      return true
    })

    // Text that names a registered command routes through SessionPrompt.submit
    // so headless entrypoints get the same Command.Event.Executed lifecycle
    // (incl. project init stamping) as the TUI; a registry miss falls through
    // to a plain prompt turn, preserving existing text-prompt semantics.
    const grantLocalStartup = Effect.fn("SessionHttpApi.grantLocalStartup")(function* (sessionID: SessionID) {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (LocalPermissionStartup.take(request.source, sessionID) && permissionSvc.grantHookBypass)
        yield* permissionSvc.grantHookBypass(sessionID)
    })

    const submit = Effect.fn("SessionHttpApi.submit")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const approved = LocalPermissionStartup.take(request.source, ctx.params.sessionID)
      const instance = yield* InstanceRef
      if (instance) ClientSessions.touch({ sessionID: ctx.params.sessionID, directory: instance.directory })
      return yield* promptSvc.submit(
        { ...ctx.payload, sessionID: ctx.params.sessionID },
        { localGrant: approved && permissionSvc.grantHookBypass !== undefined },
      )
    })

    const setModel = Effect.fn("SessionHttpApi.setModel")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SetModelPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* promptSvc
        .setModel({ ...ctx.payload, sessionID: ctx.params.sessionID })
        .pipe(Effect.mapError(promptError))
    })

    const attention = Effect.fn("SessionHttpApi.attention")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: SessionAttentionInput
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      const instance = yield* InstanceRef
      const service = yield* SessionAttention.Service
      const accepted = yield* service.updateFor(ctx.params.sessionID, ctx.payload, {
        instanceDirectory: instance?.directory,
        sessionDirectory: current.directory,
      })
      if (!accepted) return yield* Effect.fail(notFound("Session not found in this directory"))
      return true
    })
    const resume = Effect.fn("SessionHttpApi.resume")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ResumePayload.Type
    }) {
      yield* grantLocalStartup(ctx.params.sessionID)
      const current = yield* requireSession(ctx.params.sessionID)
      ClientSessions.touch({ sessionID: ctx.params.sessionID, directory: current.directory })
      return yield* promptSvc
        .resume({ ...ctx.payload, sessionID: ctx.params.sessionID })
        .pipe(Effect.mapError(promptError))
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const message = yield* submit(ctx).pipe(Effect.mapError(promptError))
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* submit(ctx).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("prompt_async failed", { sessionID: ctx.params.sessionID, cause })
            yield* events.publish(Session.Event.Error, {
              sessionID: ctx.params.sessionID,
              error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* grantLocalStartup(ctx.params.sessionID)

      const current = yield* requireSession(ctx.params.sessionID)
      ClientSessions.touch({ sessionID: ctx.params.sessionID, directory: current.directory })
      return yield* promptSvc
        .command({ ...ctx.payload, sessionID: ctx.params.sessionID })
        .pipe(Effect.mapError(promptError))
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      ClientSessions.touch({ sessionID: ctx.params.sessionID, directory: current.directory })
      return yield* SessionError.mapBusy(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }))
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }))
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              name: "PermissionNotFoundError",
              data: {
                requestID: String(error.requestID),
                message: `Permission request not found: ${error.requestID}`,
              },
            }),
          ),
        ),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removeMessage(ctx.params)
      return true
    })

    const mapQueuedMessageError = (error: SessionPrompt.QueuedMessageError) => {
      if (error._tag === "QueuedMessageNotFound") return notFound(`Message not found: ${error.messageID}`)
      if (error._tag === "QueuedMessageInvalid") return new HttpApiError.BadRequest({})
      return new ConflictError({ name: "ConflictError", data: { message: error.message, resource: error.kind } })
    }

    const editQueuedMessage = Effect.fn("SessionHttpApi.editQueuedMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
      payload: typeof QueuedMessageEditPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* promptSvc
        .editQueuedMessage({ ...ctx.params, ...ctx.payload })
        .pipe(Effect.mapError(mapQueuedMessageError))
    })

    const deleteQueuedMessage = Effect.fn("SessionHttpApi.deleteQueuedMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
      payload: typeof QueuedMessageDeletePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* promptSvc
        .deleteQueuedMessage({ ...ctx.params, ...ctx.payload })
        .pipe(Effect.mapError(mapQueuedMessageError))
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* session.updatePart(payload)
    })

    const hookAdd = Effect.fn("SessionHttpApi.hookAdd")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SessionHookAddPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // Non-empty hooks[] guard → 4xx. event/type membership is already enforced
      // by the payload's literal schemas; this completes the validation contract.
      if (ctx.payload.hooks.length === 0) return yield* new HttpApiError.BadRequest({})
      // Per-entry guards: a command hook must carry a runnable command line
      // (blank-only strings would spawn nothing), and timeout is a positive
      // seconds multiplier — negative values time the request out immediately,
      // and 0 silently falls back to the default instead of meaning "no timeout".
      const invalidEntry = ctx.payload.hooks.some(
        (hook) =>
          (hook.type === "command" && !(hook.command ?? "").trim()) ||
          (hook.timeout !== undefined && hook.timeout <= 0),
      )
      if (invalidEntry) return yield* new HttpApiError.BadRequest({})
      const id = yield* sessionHooks
        .add(ctx.params.sessionID, {
          event: ctx.payload.event as HookEvent,
          matcher: ctx.payload.matcher,
          hooks: ctx.payload.hooks as SessionHookCommand[],
          once: ctx.payload.once,
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return { id }
    })

    const hookList = Effect.fn("SessionHttpApi.hookList")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* sessionHooks.listAll(ctx.params.sessionID)
    })

    const hookRemove = Effect.fn("SessionHttpApi.hookRemove")(function* (ctx: {
      params: { sessionID: SessionID; hookID: string }
    }) {
      yield* requireSession(ctx.params.sessionID)
      // remove() is idempotent — a missing id is a no-op, so DELETE always succeeds.
      yield* sessionHooks.remove(ctx.params.sessionID, ctx.params.hookID)
    })

    const hookCancel = Effect.fn("SessionHttpApi.hookCancel")(function* (ctx: {
      params: { sessionID: SessionID; hookID: string }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const cancelled = settingsHooks.cancel
        ? yield* settingsHooks.cancel(ctx.params.sessionID, ctx.params.hookID)
        : false
      return { cancelled }
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("dagMode", dagMode)
      .handle("children", children)
      .handle("todo", todo)
      .handle("goal", goal)
      .handle("hookAdd", hookAdd)
      .handle("hookList", hookList)
      .handle("hookRemove", hookRemove)
      .handle("hookCancel", hookCancel)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("init", init)
      .handle("summarize", summarize)
      .handle("setModel", setModel)
      .handle("resume", resume)
      .handle("attention", attention)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("editQueuedMessage", editQueuedMessage)
      .handle("deleteQueuedMessage", deleteQueuedMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
  }),
)
