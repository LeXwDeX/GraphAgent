import { HEADER_PREFIX } from "@graphagent/core/brand"
import { WorkspaceV2 } from "@graphagent/core/workspace"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { Session } from "@/session/session"
import type { SessionRole } from "@/session/role"
import { getWorkspaceRouteSessionID, isLocalWorkspaceRoute } from "@/server/shared/workspace-routing"
import { NotFoundError } from "@/storage/storage"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"

const WORKSPACE_HEADER = `${HEADER_PREFIX}workspace`

// Directory and workspace addressing is header-only. Requests carrying the
// retired `directory` / `workspace` query parameters are still accepted by
// HttpApi (unknown query fields are ignored) but never select a location.
type RequestPlan = Data.TaggedEnum<{
  MalformedWorkspace: { readonly header: string }
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
     * Carried so later middleware can tell whether it is a child (`SessionRole.isChild`) without re-reading.
     * It comes from URL parsing, so it is a hint: a decision that must hold for
     * every spelling of the URL re-derives the target from the router's params.
     */
    readonly session?: SessionRole.Ref
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

// A session carries its own workspace and it wins, so the header counts only when the session names none.
// The header is untrusted text; `planRequest` checks that it is a workspace ID before using it.
function workspaceHeader(
  request: HttpServerRequest.HttpServerRequest,
  sessionWorkspaceID?: WorkspaceV2.ID,
): string | undefined {
  return sessionWorkspaceID === undefined ? request.headers[WORKSPACE_HEADER] || undefined : undefined
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

// The envelope a rejected param or query gets (middleware/schema-error.ts), so clients read one 400 shape.
function malformedWorkspaceResponse(header: string): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(
    { name: "BadRequest", data: { message: `Expected a workspace ID in the ${header} header`, kind: "Headers" } },
    { status: 400 },
  )
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
    const header = workspaceHeader(request, session?.workspaceID)
    // A header that is not a workspace ID selects nowhere. Running the request in the default location instead
    // could change the wrong place, so it is refused (#1552).
    if (header !== undefined && !Schema.is(WorkspaceV2.ID)(header)) {
      return RequestPlan.MalformedWorkspace({ header: WORKSPACE_HEADER })
    }
    const workspaceID = session?.workspaceID ?? header
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
    MalformedWorkspace: ({ header }) => Effect.succeed(malformedWorkspaceResponse(header)),
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
