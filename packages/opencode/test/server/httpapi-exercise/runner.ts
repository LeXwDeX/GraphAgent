import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { Cause, Duration, Effect, Layer, Scope } from "effect"
import { TestLLMServer } from "../../lib/llm-server"

import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import { call, callAuthProbe, disposeApps } from "./backend"
import { original } from "./environment"
import { runtime } from "./runtime"
import type {
  ActiveScenario,
  Options,
  ProjectOptions,
  Result,
  Scenario,
  ScenarioContext,
  SeededContext,
  DagNodeSeed,
} from "./types"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

export function runScenario(options: Options) {
  return (scenario: Scenario) => {
    if (scenario.kind === "todo") return Effect.succeed({ status: "skip", scenario } as Result)
    return runActive(options, scenario).pipe(
      Effect.timeoutOrElse({
        duration: options.scenarioTimeout,
        orElse: () => Effect.die(new Error(`scenario timed out after ${Duration.format(options.scenarioTimeout)}`)),
      }),
      Effect.as({ status: "pass", scenario } as Result),
      Effect.catchCause((cause) => Effect.succeed({ status: "fail" as const, scenario, message: Cause.pretty(cause) })),
      Effect.scoped,
    )
  }
}

function runActive(options: Options, scenario: ActiveScenario) {
  if (options.mode === "auth") return runAuth(scenario)

  return withContext(options, scenario, "shared", (ctx) =>
    Effect.gen(function* () {
      yield* trace(options, scenario, "request start")
      const result = yield* call(scenario, ctx)
      yield* trace(options, scenario, `response ${result.status}`)
      yield* trace(options, scenario, "expect start")
      yield* scenario.expect(ctx, ctx.state, result)
      yield* trace(options, scenario, "expect done")
    }),
  )
}

function runAuth(scenario: ActiveScenario) {
  return Effect.gen(function* () {
    const result = yield* callAuthProbe(scenario, "missing")
    if (scenario.auth === "protected") {
      if (result.status !== 401) throw new Error(`auth expected 401, got ${result.status}`)
      const authed = yield* callAuthProbe(scenario, "valid")
      if (authed.status === 401) throw new Error("auth rejected valid credentials")
      return
    }

    if (result.status === 401) throw new Error("auth expected public access, got 401")
    if (result.timedOut) throw new Error("auth expected public access, probe timed out")
  })
}

function withContext<A, E>(
  options: Options,
  scenario: ActiveScenario,
  label: string,
  use: (ctx: SeededContext<unknown>) => Effect.Effect<A, E>,
) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      yield* trace(options, scenario, `${label} context acquire start`)
      const llm = scenario.project?.llm ? yield* TestLLMServer : undefined
      const project = scenario.project
      const dir = project
        ? yield* Effect.promise(async () => (await runtime()).tmpdir(projectOptions(project, llm?.url)))
        : undefined
      yield* trace(options, scenario, `${label} context acquire done`)
      return { dir, llm }
    }),
    (ctx) =>
      Effect.gen(function* () {
        yield* trace(options, scenario, `${label} tmpdir cleanup start`)
        // Finalizers run uninterruptibly — the scenario timeout cannot break a
        // hung dispose, so the hard cap lives inside the promise itself.
        yield* Effect.promise(() =>
          bounded(`${scenario.name}: tmpdir dispose`, async () => {
            await ctx.dir?.[Symbol.asyncDispose]()
          }),
        )
        yield* trace(options, scenario, `${label} tmpdir cleanup done`)
      }),
  ).pipe(
    Effect.flatMap((context) =>
      Effect.gen(function* () {
        yield* trace(options, scenario, `${label} runtime start`)
        const modules = yield* Effect.promise(() => runtime())
        const scope = yield* Scope.Scope
        const app = yield* Layer.buildWithMemoMap(modules.AppLayer, modules.memoMap, scope)
        yield* trace(options, scenario, `${label} runtime done`)
        const path = context.dir?.path
        const instance = path
          ? yield* trace(options, scenario, `${label} instance load start`).pipe(
              Effect.andThen(
                modules.InstanceStore.Service.use((store) => store.load({ directory: path })).pipe(
                  Effect.provide(app),
                  Effect.catchCause((cause) =>
                    Effect.sleep("100 millis").pipe(
                      Effect.andThen(
                        modules.InstanceStore.Service.use((store) => store.load({ directory: path })).pipe(
                          Effect.provide(app),
                        ),
                      ),
                      Effect.catchCause(() => Effect.failCause(cause)),
                    ),
                  ),
                ),
              ),
              Effect.tap(() => trace(options, scenario, `${label} instance load done`)),
            )
          : undefined
        const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provideService(modules.InstanceRef, instance), Effect.provide(app))
        const directory = () => {
          if (!context.dir?.path) throw new Error("scenario needs a project directory")
          return context.dir.path
        }
        const llm = () => {
          if (!context.llm) throw new Error("scenario needs fake LLM")
          return context.llm
        }
        const base: ScenarioContext = {
          directory: context.dir?.path,
          headers: (extra) => ({
            ...(context.dir?.path ? { "x-opencode-directory": context.dir.path } : {}),
            ...extra,
          }),
          file: (name, content) =>
            Effect.promise(() => {
              return Bun.write(`${directory()}/${name}`, content)
            }).pipe(Effect.asVoid),
          session: (input) =>
            run(
              modules.Session.Service.use((svc) =>
                svc.create({
                  title: input?.title,
                  parentID: input?.parentID,
                  model: input?.model
                    ? { id: ModelV2.ID.make(input.model.id), providerID: ProviderV2.ID.make(input.model.providerID) }
                    : undefined,
                }),
              ),
            ),
          sessionGet: (sessionID) =>
            run(modules.Session.Service.use((svc) => svc.get(sessionID))).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            ),
          project: () =>
            Effect.sync(() => {
              if (!instance) throw new Error("scenario needs a project directory")
              return instance.project
            }),
          message: (sessionID, input) =>
            Effect.gen(function* () {
              const info: SessionV1.User = {
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: "build",
                model: {
                  providerID: ProviderV2.ID.opencode,
                  modelID: ModelV2.ID.make("test"),
                },
              }
              const part: SessionV1.TextPart = {
                id: PartID.ascending(),
                sessionID,
                messageID: info.id,
                type: "text",
                text: input?.text ?? "hello",
              }
              yield* run(
                modules.Session.Service.use((svc) =>
                  Effect.gen(function* () {
                    yield* svc.updateMessage(info)
                    yield* svc.updatePart(part)
                  }),
                ),
              )
              return { info, part }
            }),
          messages: (sessionID) =>
            run(modules.Session.Service.use((svc) => svc.messages({ sessionID }).pipe(Effect.orDie))),
          todos: (sessionID, todos) =>
            run(modules.Todo.Service.use((svc) => svc.update({ sessionID, todos }).pipe(Effect.orDie))),
          goal: (sessionID, goalText, maxTurns) =>
            run(modules.Goal.Service.use((svc) => svc.set(sessionID, goalText, maxTurns))).pipe(Effect.asVoid),
          worktree: (input) => run(modules.Worktree.Service.use((svc) => svc.create(input).pipe(Effect.orDie))),
          worktreeRemove: (directory) =>
            run(modules.Worktree.Service.use((svc) => svc.remove({ directory })).pipe(Effect.ignore)),
          llmText: (value) => Effect.suspend(() => llm().text(value)),
          llmWait: (count) => Effect.suspend(() => llm().wait(count)),
          tuiRequest: (request) => Effect.sync(() => modules.Tui.submitTuiRequest(request)),
          dag: (input) => run(createDagFixture(input.sessionID, input.title, input.nodes)),
          dagFailNode: (dagID, nodeID, reason, errorClass) =>
            run(failDagNodeFixture(dagID, nodeID, reason, errorClass)),
          dagAgentMessage: (dagID, nodeID, ownerSessionID) => run(seedDagAgentMessage(dagID, nodeID, ownerSessionID)),
          foreignDag: (input) => run(createForeignDagFixture(input.title, input.nodes)),
        }
        yield* trace(options, scenario, `${label} seed start`)
        const state = yield* scenario.seed(base)
        yield* trace(options, scenario, `${label} seed done`)
        yield* trace(options, scenario, `${label} use start`)
        const result = yield* use({ ...base, state })
        yield* trace(options, scenario, `${label} use done`)
        return result
      }).pipe(Effect.ensuring(context.llm ? context.llm.reset : Effect.void)),
    ),
    Effect.ensuring(scenario.reset ? resetState : Effect.void),
  )
}

function trace(options: Options, scenario: ActiveScenario, phase: string) {
  return Effect.sync(() => {
    options.heartbeat?.(`${scenario.name}: ${phase}`)
    if (!options.trace) return
    console.log(`[trace] ${scenario.name}: ${phase}`)
  })
}

function projectOptions(
  project: ProjectOptions,
  llmUrl: string | undefined,
): { git?: boolean; config?: Partial<ConfigV1.Info> } {
  if (!project.llm || !llmUrl) return { git: project.git, config: project.config }
  const fake = fakeLlmConfig(llmUrl)
  return {
    git: project.git,
    config: {
      ...fake,
      ...project.config,
      provider: {
        ...fake.provider,
        ...project.config?.provider,
      },
    },
  }
}

function fakeLlmConfig(url: string): Partial<ConfigV1.Info> {
  return {
    model: "test/test-model",
    small_model: "test/test-model",
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
  }
}

const resetState = Effect.promise(async () => {
  const modules = await runtime()
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
  // This runs from Effect.ensuring, i.e. uninterruptibly — a single promise
  // that never resolves here used to hang the whole runner with zero output
  // (the 2026-07-27 CI incident). Bound every step independently so a stuck
  // dispose degrades into a loud warning and the run continues.
  await bounded("disposeApps", () => disposeApps())
  await bounded("disposeAllInstances", () => modules.disposeAllInstances())
  await bounded("resetDatabase", () => modules.resetDatabase())
  await Bun.sleep(25)
})

/**
 * Hard-timeout wrapper for cleanup promises: never rejects, never hangs.
 * On timeout the underlying promise is left behind (there is nothing safe to
 * do with it) and the runner moves on instead of silently freezing.
 */
const CLEANUP_STEP_TIMEOUT_MS = 10_000

export async function bounded(label: string, work: () => Promise<unknown>, ms = CLEANUP_STEP_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms)
  })
  const winner = await Promise.race([
    work().then(
      () => "done" as const,
      (error: unknown) => {
        console.error(`[cleanup] ${label} failed: ${String(error)}`)
        return "done" as const
      },
    ),
    timeout,
  ])
  clearTimeout(timer)
  if (winner === "timeout") {
    console.error(`[cleanup] ${label} exceeded ${ms}ms — forcing continuation (resource may leak)`)
  }
}

/** Fail a seeded DAG node through the Dag service so error_class lands on the wire. */
function failDagNodeFixture(
  dagID: string,
  nodeID: string,
  reason: string,
  errorClass: "timeout" | "exec_failed" | "verdict_fail",
) {
  return Effect.gen(function* () {
    const modules = yield* Effect.promise(() => runtime())
    const dag = yield* modules.Dag.Service
    yield* dag.nodeFailed(dagID, nodeID, reason, errorClass).pipe(Effect.orDie)
  })
}

function seedDagAgentMessage(dagID: string, nodeID: string, ownerSessionID: SessionID) {
  return Effect.gen(function* () {
    const modules = yield* Effect.promise(() => runtime())
    const dag = yield* modules.Dag.Service
    const sessions = yield* modules.Session.Service
    const messages = yield* DagMessages.Service
    const instance = (yield* modules.InstanceRef)!
    const child = yield* sessions.create({ parentID: ownerSessionID, title: "HTTP agent message recipient" })
    yield* dag.nodeQueued(dagID, nodeID).pipe(Effect.orDie)
    yield* dag.nodeStarted(dagID, nodeID, child.id).pipe(Effect.orDie)
    const caller = { projectID: instance.project.id, directory: instance.directory, sessionID: ownerSessionID }
    const endpoint = yield* messages.resolve(caller, dagID, nodeID)
    if (!endpoint.ok) {
      yield* Effect.die(new Error(`message fixture endpoint rejected: ${endpoint.reason}`))
      return
    }
    const accepted = yield* messages.send(caller, {
      workflowID: dagID,
      nodeID,
      attemptID: endpoint.value.attemptID,
      idempotencyKey: "httpapi-message",
      content: "HTTP_MESSAGE_BODY_PRIVATE",
    })
    if (!accepted.ok) yield* Effect.die(new Error(`message fixture rejected: ${accepted.reason}`))
  })
}

/**
 * Create a DAG workflow fixture with mixed node statuses for HTTP happy-path tests.
 * Creates the workflow owned by the session, using the instance's real project ID
 * so the FK constraint on workflow.project_id is satisfied.
 */
function createDagFixture(sessionID: SessionID, title: string | undefined, nodes: DagNodeSeed[]) {
  return Effect.gen(function* () {
    const modules = yield* Effect.promise(() => runtime())
    const dag = yield* modules.Dag.Service
    const project = (yield* modules.InstanceRef)!.project
    const dagID = yield* dag
      .create({
        projectID: project.id,
        sessionID,
        title: title ?? "DAG fixture",
        config: {
          name: title ?? "DAG fixture",
          nodes: nodes.map((n) => ({
            id: n.id,
            name: n.name,
            worker_type: n.worker_type,
            depends_on: n.depends_on,
            required: n.required,
            prompt_template: { inline: n.id },
          })),
        },
      })
      .pipe(Effect.orDie)
    return { dagID, sessionID } as const
  })
}

function createForeignDagFixture(title: string | undefined, nodes: DagNodeSeed[]) {
  return Effect.gen(function* () {
    const modules = yield* Effect.promise(() => runtime())
    const dag = yield* modules.Dag.Service
    const { db } = yield* Database.Service
    const projectID = Project.ID.make("prj_httpapi_foreign")
    const sessionID = SessionID.make("ses_httpapi_foreign")
    yield* db
      .insert(ProjectTable)
      .values({
        id: projectID,
        worktree: AbsolutePath.make("/foreign-httpapi-project"),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: "foreign-httpapi",
        directory: AbsolutePath.make("/foreign-httpapi-project"),
        title: "Foreign HTTP API session",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const dagID = yield* dag
      .create({
        projectID,
        sessionID,
        title: title ?? "Foreign DAG fixture",
        config: {
          name: title ?? "Foreign DAG fixture",
          nodes: nodes.map((item) => ({
            id: item.id,
            name: item.name,
            worker_type: item.worker_type,
            depends_on: item.depends_on,
            required: item.required,
            prompt_template: { inline: item.id },
          })),
        },
      })
      .pipe(Effect.orDie)
    return { dagID, sessionID } as const
  })
}
