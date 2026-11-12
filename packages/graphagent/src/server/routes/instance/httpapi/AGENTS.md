# HttpApi Route Patterns

Use `HttpApiBuilder.group(...)` for normal HTTP endpoints, including streaming HTTP responses such as server-sent events. Handlers should yield stable services once while building the handler layer, then close over those services in endpoint implementations.

```ts
export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service

    return handlers.handle("list", () => session.list())
  }),
)
```

For SSE endpoints, stay in `HttpApiBuilder.group(...)` and return `HttpServerResponse.stream(...)` from the handler. Annotate the endpoint success schema with `HttpApiSchema.asText({ contentType: "text/event-stream" })` so OpenAPI documents the stream content type.

Use `HttpApiBuilder.group(...)` with `handleRaw(...)` for declared endpoints that need the raw request or response. This keeps endpoint middleware, routing context, and OpenAPI metadata on one typed route tree.

Use raw `HttpRouter.use(...)` only for routes outside the declared API surface, such as a catch-all UI fallback.

Avoid `Effect.provide(SomeLayer)` inside request handlers or raw route callbacks. Stable layers should be provided once at the application/layer boundary, not rebuilt or scoped per request.

Avoid `HttpRouter.provideRequest(...)` unless the dependency is intentionally request-level. Prefer `HttpRouter.use(...)` for stable app services.

Use `Effect.provideService(...)` in middleware only for request-derived context, such as `WorkspaceRouteContext`, `InstanceRef`, or `WorkspaceRef`. Do not use it to smuggle stable services through request effects when they can be yielded at layer construction.

Public JSON errors should be explicit `Schema.Error` contracts declared on each endpoint. Use built-in `HttpApiError.*` classes only when their empty/tagged body is the intended wire shape; for SDK-visible errors with messages, define an API error schema such as `ApiNotFoundError` and fail with that exact declared error. Keep domain and storage services free of HttpApi types, and translate expected domain errors at the handler boundary.

When adding middleware, declare endpoint-contract middleware on the owning `HttpApiGroup` and provide its implementation layer at the assembly boundary in `server.ts`. Keep router middleware for truly raw fallback routes or global transport policy.

Child sessions are read-only over HTTP (#1026). Every non-GET endpoint in the `session` group is denied by default for a session with a `parentID` and fails with `ChildSessionReadOnlyError` (409); the allowlist lives in `middleware/child-session-guard.ts`. A new write endpoint that targets a session, inside or outside the group (a `sessionID` in the payload included), must either be guarded (group middleware or `assertSessionWritable`) or be added to the allowlist, and the classification table in `test/server/httpapi-child-readonly.test.ts` updated in the same change. The reflection test fails on an unclassified endpoint.
