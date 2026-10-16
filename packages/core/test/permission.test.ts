import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Exit, Schema, Context, Scope } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionHookScope } from "@opencode-ai/core/permission/hook-scope"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionTurnHooks } from "@opencode-ai/core/session/turn-hooks"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const sessions = SessionV2.layer.pipe(
  Layer.provide(LocationServiceMap.layer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
)
const layer = PermissionV2.locationLayer.pipe(
  Layer.provideMerge(Database.defaultLayer),
  Layer.provideMerge(SessionStore.defaultLayer),
  Layer.provideMerge(EventV2.defaultLayer),
  Layer.provideMerge(current),
  Layer.provideMerge(sessions),
  Layer.provideMerge(SessionExecution.noopLayer),
  Layer.provideMerge(PermissionSaved.defaultLayer),
)
const it = testEffect(layer)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function waitForRequest() {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion()).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const denied = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(denied).toBeInstanceOf(PermissionV2.DeniedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
})

function hookScope(input: Partial<PermissionHookScope.State> = {}): PermissionHookScope.State {
  return {
    input: { path: "src/index.ts" },
    confirmed: false,
    hooks: {
      policy: () => Effect.succeed({ rules: [] }),
      request: () => Effect.succeed({ behavior: "allow" }),
      confirm: () => Effect.die("unused"),
    },
    ...input,
  }
}

it.effect("hook allow cannot override a native deny", () =>
  Effect.gen(function* () {
    yield* setup([{ action: "read", resource: "*", effect: "deny" }])
    const service = yield* PermissionV2.Service
    let requests = 0
    const scope = hookScope({ preDecision: "allow" })
    scope.hooks.policy = () => Effect.succeed({ rules: [{ action: "read", resource: "*", effect: "allow" }] })
    scope.hooks.request = () =>
      Effect.sync(() => {
        requests++
        return { behavior: "allow" as const }
      })
    const exit = yield* service
      .assert(assertion())
      .pipe(Effect.provideService(PermissionHookScope.Service, scope), Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(scope.denied).toBe(true)
    expect(requests).toBe(0)
    expect(yield* service.list()).toEqual([])
  }),
)
it.effect("hook force ask retains a real user confirmation despite allow", () =>
  Effect.gen(function* () {
    yield* setup([{ action: "read", resource: "*", effect: "allow" }])
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const off = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, Schema.decodeUnknownSync(PermissionV2.Request)(event.data)).pipe(Effect.asVoid)
        : Effect.void,
    )
    const scope = hookScope({ preDecision: "ask" })
    const run = yield* service
      .assert(assertion())
      .pipe(Effect.provideService(PermissionHookScope.Service, scope), Effect.forkChild)
    const request = yield* Deferred.await(asked)
    expect(scope.confirmed).toBe(false)
    yield* service.reply({ requestID: request.id, reply: "once" })
    yield* Fiber.join(run)
    expect(scope.confirmed).toBe(true)
    yield* off
  }),
)
it.effect("permission callback policy updates are rechecked before allow", () =>
  Effect.gen(function* () {
    yield* setup()
    const service = yield* PermissionV2.Service
    const scope = hookScope()
    let denied = false
    scope.hooks.policy = () =>
      Effect.succeed({ rules: denied ? [{ action: "read", resource: "*", effect: "deny" }] : [] })
    scope.hooks.request = () =>
      Effect.sync(() => {
        denied = true
        return { behavior: "allow" as const }
      })
    const exit = yield* service
      .assert(assertion())
      .pipe(Effect.provideService(PermissionHookScope.Service, scope), Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(scope.denied).toBe(true)
    expect(yield* service.list()).toEqual([])
  }),
)

for (const blocked of ["policy", "request"] as const)
  it.effect(`cancels a blocked hook ${blocked} without releasing its hook`, () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask" }])
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const hooks = hookScope()
      const wait = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      if (blocked === "policy") hooks.hooks.policy = () => wait.pipe(Effect.as({ rules: [] }))
      else hooks.hooks.request = () => wait.pipe(Effect.as({ behavior: "allow" as const }))
      const permission = yield* PermissionV2.Service
      const fiber = yield* permission
        .assert(assertion())
        .pipe(Effect.provideService(PermissionHookScope.Service, hooks), Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* permission.list()).toEqual([])
    }),
  )

it.effect("host-authorized bypass skips ordinary asks but retains configured deny", () =>
  Effect.gen(function* () {
    yield* setup([{ action: "read", resource: "*", effect: "ask" }])
    const permissions = yield* PermissionV2.Service
    const scope = hookScope()
    scope.hooks.policy = () => Effect.succeed({ mode: "bypassPermissions", rules: [] })
    scope.hooks.request = () => Effect.die("bypass must not run ordinary permission hook")
    yield* permissions.assert(assertion()).pipe(Effect.provideService(PermissionHookScope.Service, scope))
    expect(yield* permissions.list()).toEqual([])
    yield* (yield* AgentV2.Service).transform((draft) =>
      draft.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
      }),
    )
    expect(
      Exit.isFailure(
        yield* permissions
          .assert(assertion())
          .pipe(Effect.provideService(PermissionHookScope.Service, scope), Effect.exit),
      ),
    ).toBe(true)
  }),
)

it.effect("a host-authorized bypass update takes effect after the current permission hook", () =>
  Effect.gen(function* () {
    yield* setup([{ action: "read", resource: "*", effect: "ask" }])
    let authorizedMode = false
    const scope = hookScope()
    scope.hooks.policy = () => Effect.succeed({ mode: authorizedMode ? "bypassPermissions" : undefined, rules: [] })
    scope.hooks.request = () =>
      Effect.sync(() => {
        authorizedMode = true
        return { behavior: "allow" as const }
      })
    const permissions = yield* PermissionV2.Service
    yield* permissions.assert(assertion()).pipe(Effect.provideService(PermissionHookScope.Service, scope))
    expect(authorizedMode).toBe(true)
    expect(yield* permissions.list()).toEqual([])
  }),
)

it.effect("pending permission host is cancelled on reply and interrupted confirmation", () =>
  Effect.gen(function* () {
    yield* setup([{ action: "read", resource: "*", effect: "ask" }])
    const permissions = yield* PermissionV2.Service
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const host = SessionTurnHooks.Service.of({
      permissionPending: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
      displayMode: (_, mode) => Effect.succeed({ enabled: false, mode }),
      display: ({ delta }) => Effect.succeed(delta),
      postToolBatch: () => Effect.succeed({}),
      stop: () => Effect.succeed({}),
      stopFailure: () => Effect.void,
    })
    const asked = yield* permissions.ask(assertion()).pipe(Effect.provideService(SessionTurnHooks.Service, host))
    yield* Deferred.await(started)
    yield* permissions.reply({ requestID: asked.id, reply: "reject" })
    yield* Deferred.await(stopped)
    const confirming = yield* permissions.confirm!(assertion()).pipe(
      Effect.provideService(SessionTurnHooks.Service, host),
      Effect.forkChild,
    )
    yield* Effect.yieldNow
    yield* Fiber.interrupt(confirming)
    expect(yield* permissions.list()).toEqual([])
  }),
)

it.effect("directory permission scope disposes a pending notification observer", () =>
  Effect.gen(function* () {
    yield* setup([{ action: "read", resource: "*", effect: "ask" }])
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const host = SessionTurnHooks.Service.of({
      permissionPending: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
      displayMode: (_, mode) => Effect.succeed({ enabled: false, mode }),
      display: ({ delta }) => Effect.succeed(delta),
      postToolBatch: () => Effect.succeed({}),
      stop: () => Effect.succeed({}),
      stopFailure: () => Effect.void,
    })
    yield* Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(Layer.fresh(PermissionV2.layer), scope)
        const permissions = Context.get(context, PermissionV2.Service)
        yield* permissions.confirm!(assertion()).pipe(
          Effect.provideService(SessionTurnHooks.Service, host),
          Effect.forkChild,
        )
        yield* Deferred.await(started)
        yield* Scope.close(scope, Exit.void)
      }),
    )
    yield* Deferred.await(stopped)
    expect(yield* Deferred.isDone(stopped)).toBe(true)
  }),
)
