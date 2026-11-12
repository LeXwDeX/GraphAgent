import { HEADER_PREFIX } from "@graphagent/core/brand"
import { WorkspaceV2 } from "@graphagent/core/workspace"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { getWorkspaceRouteSessionID, isLocalWorkspaceRoute } from "@/server/shared/workspace-routing"
import { NotFoundError } from "@/storage/storage"
import { Context, Data, Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"

// Directory and workspace addressing is header-only. Requests carrying the
// retired `directory` / `workspace` query parameters are still accepted by
// HttpApi (unknown query fields are ignored) but never select a location.
type RequestPlan = Data.TaggedEnum<{
  MissingWorkspace: { readonly workspaceID: WorkspaceV2.ID }
  Local: { readonly directory: string; readonly workspaceID?: WorkspaceV2.ID }
}>
const RequestPlan = Data.taggedEnum<RequestPlan>()

export class WorkspaceRouteContext extends Context.Service<
  WorkspaceRouteContext,
  {
    readonly directory: string
    readonly workspaceID?: WorkspaceV2.ID
    /**
     * Session row read for routing, when the URL addresses one that exists.
     * Carried so later middleware can decide on `parentID` without re-reading.
     * It comes from URL parsing, so it is a hint: a decision that must hold for
     * every spelling of the URL re-derives the target from the router's params.
     */
    readonly session?: { readonly id: SessionID; readonly parentID?: SessionID }
  }
>()("@graphagent/ExperimentalHttpApiWorkspaceRouteContext") {}

export class WorkspaceRoutingMiddleware extends HttpApiMiddleware.Service<
  WorkspaceRoutingMiddleware,
  {
    provides: WorkspaceRouteContext
    requires: Session.Service
  }
>()("@graphagent/ExperimentalHttpApiWorkspaceRouting") {}

function requestURL(request: HttpServerRequest.HttpServerRequest): URL {
  return new URL(request.url, "http://localhost")
}

function selectedWorkspaceID(
  request: HttpServerRequest.HttpServerRequest,
  sessionWorkspaceID?: WorkspaceV2.ID,
): WorkspaceV2.ID | undefined {
  const workspaceHeader = request.headers[`${HEADER_PREFIX}workspace`]
  return sessionWorkspaceID ?? (workspaceHeader ? WorkspaceV2.ID.make(workspaceHeader) : undefined)
}

function defaultDirectory(request: HttpServerRequest.HttpServerRequest): string {
  return request.headers[`${HEADER_PREFIX}directory`] || process.cwd()
}

function shouldStayOnControlPlane(request: HttpServerRequest.HttpServerRequest, url: URL): boolean {
  return isLocalWorkspaceRoute(request.method, url.pathname)
}

function resolveWorkspace(
  id: WorkspaceV2.ID | undefined,
): Effect.Effect<Workspace.Info | void, never, Workspace.Service> {
  if (!id) return Effect.void
  return Workspace.Service.use((workspace) => workspace.get(id))
}

function missingWorkspaceResponse(id: WorkspaceV2.ID): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text(`Workspace not found: ${id}`, {
    status: 500,
    contentType: "text/plain; charset=utf-8",
  })
}

function planWorkspaceRequest(workspace: Workspace.Info): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    const target = yield* WorkspaceAdapterRuntime.target(workspace)
    return RequestPlan.Local({ directory: target.directory, workspaceID: workspace.id })
  })
}

function planRequest(
  request: HttpServerRequest.HttpServerRequest,
  session?: Session.Info,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    const url = requestURL(request)
    const workspaceID = selectedWorkspaceID(request, session?.workspaceID)
    const workspace = yield* resolveWorkspace(workspaceID)

    if (workspaceID && workspace === undefined) {
      return RequestPlan.MissingWorkspace({ workspaceID })
    }

    if (workspace !== undefined && !shouldStayOnControlPlane(request, url)) {
      return yield* planWorkspaceRequest(workspace)
    }

    return RequestPlan.Local({
      directory: session?.directory || defaultDirectory(request),
      workspaceID,
    })
  })
}

function routeWorkspace<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
  plan: RequestPlan,
  session?: Session.Info,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, Workspace.Service> {
  return RequestPlan.$match(plan, {
    MissingWorkspace: ({ workspaceID }) => Effect.succeed(missingWorkspaceResponse(workspaceID)),
    Local: ({ directory, workspaceID }) =>
      effect.pipe(
        Effect.provideService(
          WorkspaceRouteContext,
          WorkspaceRouteContext.of({
            directory,
            workspaceID,
            ...(session ? { session: { id: session.id, parentID: session.parentID } } : {}),
          }),
        ),
      ),
  })
}

function routeHttpApiWorkspace<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  Session.Service | Workspace.Service | HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const sessionID = getWorkspaceRouteSessionID(requestURL(request))
    const session = sessionID
      ? yield* Session.Service.use((svc) => svc.get(sessionID)).pipe(
          Effect.catchIf(
            (error): error is NotFoundError => NotFoundError.isInstance(error),
            () => Effect.succeed(undefined),
          ),
          Effect.catchDefect(() => Effect.succeed(undefined)),
        )
      : undefined
    const plan = yield* planRequest(request, session)
    return yield* routeWorkspace(effect, plan, session)
  })
}

export const workspaceRoutingLayer = Layer.effect(
  WorkspaceRoutingMiddleware,
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    return WorkspaceRoutingMiddleware.of((effect) =>
      routeHttpApiWorkspace(effect).pipe(Effect.provideService(Workspace.Service, workspace)),
    )
  }),
)
