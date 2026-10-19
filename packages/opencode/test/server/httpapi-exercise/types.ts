import type { Duration, Effect } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Project } from "../../../src/project/project"
import type { Worktree } from "../../../src/worktree"
import type { SessionID } from "../../../src/session/schema"
export const OpenApiMethods = ["get", "post", "put", "delete", "patch"] as const
export const Methods = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const

export type Method = (typeof Methods)[number]
export type OpenApiMethod = (typeof OpenApiMethods)[number]
export type Mode = "effect" | "coverage" | "auth"
export type Comparison = "none" | "status" | "json"
export type CaptureMode = "full" | "stream"
export type AuthPolicy = "protected" | "public" | "public-bypass" | "ticket-bypass"
export type ProjectOptions = { git?: boolean; config?: Partial<ConfigV1.Info>; llm?: boolean }
export type OpenApiSpec = { paths?: Record<string, Partial<Record<OpenApiMethod, unknown>>> }
export type JsonObject = Record<string, unknown>

export type Options = {
  mode: Mode
  include: string | undefined
  startAt: string | undefined
  stopAt: string | undefined
  failOnMissing: boolean
  failOnSkip: boolean
  scenarioTimeout: Duration.Duration
  progress: boolean
  trace: boolean
  /** Progress heartbeat for the out-of-process watchdog (CI only). */
  heartbeat?: (label: string) => void
}

export type RequestSpec = {
  path: string
  headers?: Record<string, string>
  body?: unknown
}

export type FollowupRequestSpec = RequestSpec & { method: Method }

export type CallResult = {
  status: number
  contentType: string
  body: unknown
  text: string
  timedOut: boolean
}

export type BackendApp = {
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

/** Effect-native helpers available while setting up and asserting a scenario. */
export type ScenarioContext = {
  directory: string | undefined
  headers: (extra?: Record<string, string>) => Record<string, string>
  request: (input: FollowupRequestSpec) => Effect.Effect<CallResult>
  file: (name: string, content: string) => Effect.Effect<void>
  session: (input?: { title?: string; parentID?: SessionID; model?: { id: string; providerID: string } }) => Effect.Effect<SessionInfo>
  sessionGet: (sessionID: SessionID) => Effect.Effect<SessionInfo | undefined>
  project: () => Effect.Effect<Project.Info>
  message: (sessionID: SessionID, input?: { text?: string }) => Effect.Effect<MessageSeed>
  messages: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts[]>
  todos: (sessionID: SessionID, todos: TodoInfo[]) => Effect.Effect<void>
  goal: (sessionID: SessionID, goalText: string, maxTurns?: number) => Effect.Effect<void>
  worktree: (input?: { name?: string }) => Effect.Effect<Worktree.Info>
  worktreeRemove: (directory: string) => Effect.Effect<void>
  llmText: (value: string) => Effect.Effect<void>
  llmWait: (count: number) => Effect.Effect<void>
  tuiRequest: (request: { path: string; body: unknown }) => Effect.Effect<void>
  /** Create a DAG workflow owned by sessionID with the given node configs. Returns the dagID. */
  dag: (input: { sessionID: SessionID; title?: string; nodes: DagNodeSeed[] }) => Effect.Effect<DagWorkflowInfo>
  /** Fail a seeded DAG node through the Dag service (projects error_class on the wire). */
  dagFailNode: (dagID: string, nodeID: string, reason: string, errorClass: "timeout" | "exec_failed" | "verdict_fail") => Effect.Effect<void>
  dagAgentMessage: (dagID: string, nodeID: string, ownerSessionID: SessionID) => Effect.Effect<void>
  /** Create a DAG workflow under a different project in the shared database. */
  foreignDag: (input: { title?: string; nodes: DagNodeSeed[] }) => Effect.Effect<DagWorkflowInfo>
}

/** Scenario context after `.seeded(...)`; `state` preserves the seed return type in the DSL. */
export type SeededContext<S> = ScenarioContext & {
  state: S
}

export type Scenario = ActiveScenario | TodoScenario
export type ActiveScenario = {
  kind: "active"
  method: Method
  path: string
  name: string
  project: ProjectOptions | undefined
  seed: (ctx: ScenarioContext) => Effect.Effect<unknown>
  request: (ctx: ScenarioContext, state: unknown) => RequestSpec
  authProbe: RequestSpec | undefined
  expect: (ctx: ScenarioContext, state: unknown, result: CallResult) => Effect.Effect<void>
  compare: Comparison
  capture: CaptureMode
  mutates: boolean
  reset: boolean
  auth: AuthPolicy
}

export type BuilderState<S> = {
  method: Method
  path: string
  name: string
  project: ProjectOptions | undefined
  seed: (ctx: ScenarioContext) => Effect.Effect<S>
  request: (ctx: SeededContext<S>) => RequestSpec
  authProbe: RequestSpec | undefined
  capture: CaptureMode
  mutates: boolean
  reset: boolean
  auth: AuthPolicy
}

export type TodoScenario = {
  kind: "todo"
  method: Method
  path: string
  name: string
  reason: string
}

export type Result =
  | { status: "pass"; scenario: ActiveScenario }
  | { status: "fail"; scenario: ActiveScenario; message: string }
  | { status: "skip"; scenario: TodoScenario }

export type SessionInfo = { id: SessionID; title: string; parentID?: SessionID }
export type TodoInfo = { content: string; status: string; priority: string }
export type MessageSeed = { info: SessionV1.User; part: SessionV1.TextPart }

/** Minimal node declaration for DAG test fixtures. */
export type DagNodeSeed = {
  id: string
  name: string
  worker_type: string
  depends_on: string[]
  required: boolean
}

/** Result of creating a DAG workflow fixture. */
export type DagWorkflowInfo = { dagID: string; sessionID: SessionID }
