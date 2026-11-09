import { HEADER_PREFIX } from "@graphagent/core/brand"
import { WorkspaceV2 } from "@graphagent/core/workspace"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { Session } from "@/session/session"
import { getWorkspaceRouteSessionID, isLocalWorkspaceRoute } from "@/server/shared/workspace-routing"
import { NotFoundError } from "@/storage/storage"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"

// Query fields this middleware reads from the URL. Spread into every
// endpoint query schema in groups that apply WorkspaceRoutingMiddleware,
// otherwise HttpApi rejects requests carrying these params with 400.
// HttpApiMiddleware in effect-smol cannot declare query params today —
// remove this once upstream supports middleware-declared query schemas.
export const WorkspaceRoutingQueryFields = {
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
}

export const WorkspaceRoutingQuery = Schema.Struct(WorkspaceRoutingQueryFields)

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

function selectedWorkspaceID(url: URL, sessionWorkspaceID?: WorkspaceV2.ID): WorkspaceV2.ID | undefined {
  const workspaceParam = url.searchParams.get("workspace")
  return sessionWorkspaceID ?? (workspaceParam ? WorkspaceV2.ID.make(workspaceParam) : undefined)
}

function defaultDirectory(request: HttpServerRequest.HttpServerRequest, url: URL): string {
  return url.searchParams.get("directory") || request.headers[`${HEADER_PREFIX}directory`] || process.cwd()
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
    const workspaceID = selectedWorkspaceID(url, session?.workspaceID)
    const workspace = yield* resolveWorkspace(workspaceID)

    if (workspaceID && workspace === undefined) {
      return RequestPlan.MissingWorkspace({ workspaceID })
    }

    if (workspace !== undefined && !shouldStayOnControlPlane(request, url)) {
      return yield* planWorkspaceRequest(workspace)
    }

    return RequestPlan.Local({
      directory: session?.directory || defaultDirectory(request, url),
      workspaceID,
    })
  })
}

function routeWorkspace<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
  plan: RequestPlan,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, Workspace.Service> {
  return RequestPlan.$match(plan, {
    MissingWorkspace: ({ workspaceID }) => Effect.succeed(missingWorkspaceResponse(workspaceID)),
    Local: ({ directory, workspaceID }) =>
      effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory, workspaceID }))),
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
    return yield* routeWorkspace(effect, plan)
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
