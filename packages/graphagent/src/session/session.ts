import { HookModelMetrics } from "@/hook/model-metrics"
import { HookFileWatch } from "@/hook/file-watch"
import { HookConfigChange } from "@/hook/config-change"
import { HookSessionContext } from "@/hook/session-context"
import { HookTranscript } from "@/hook/transcript"
import { Skill } from "@/skill"
import { HookLifecycle } from "@/hook/lifecycle"
import { HookStartContext } from "@/hook/start-context"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Slug } from "@graphagent/core/util/slug"
import { SessionV1 } from "@graphagent/core/v1/session"
import { serviceUse } from "@graphagent/core/effect/service-use"
import path from "path"
import { PROJECT_DIR } from "@graphagent/core/brand"
import { cancelSessionJobs } from "@/background/cancel"
import { BackgroundJob } from "@/background/job"
import { Decimal } from "decimal.js"
import type { ProviderMetadata, Usage } from "@graphagent/llm"
import { InstallationVersion } from "@graphagent/core/installation/version"
import { Database } from "@graphagent/core/database/database"
import { makeRuntime } from "@graphagent/core/effect/runtime"
import { EventV2Bridge } from "@/event-v2-bridge"

import { NotFoundError } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { isNull } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { like } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { or } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { MessageDiffTable, PartTable, SessionTable } from "@graphagent/core/session/sql"
import { SessionProjector } from "@graphagent/core/session/projector"
import { MessageV2 } from "./message-v2"
import type { InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { ProjectV2 } from "@graphagent/core/project"
import { WorkspaceV2 } from "@graphagent/core/workspace"
import { SessionID, MessageID, PartID } from "./schema"

import type { Provider } from "@/provider/provider"
import { Global } from "@graphagent/core/global"
import { assertProjectRootWritable } from "@/project/project-root"
import { Cause, Effect, Layer, Option, Context, Schema, Types } from "effect"
import { NonNegativeInt, optionalOmitUndefined } from "@graphagent/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { SessionMessageID } from "@graphagent/schema/session-message-id"
import { DagBudgetTokens, DagMode } from "@graphagent/schema/dag-mode"
import { Goal } from "@/goal/goal"
import { ExclusiveRegistry } from "./engine-process"
import { SessionStatus } from "./status"
import { Dag } from "@/dag/dag"
import { isWorkflowTerminalStatus } from "@graphagent/core/dag/core/types"
import { landSystemMessages } from "@/hook/trigger-result"
import { ToolSourceLedger } from "./tool-source-ledger"
import { DagMessages } from "@graphagent/core/dag/messages"

const runtime = makeRuntime(Database.Service, Database.defaultLayer)

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

type SessionRow = typeof SessionTable.$inferSelect

export const MAX_SUMMARY_DIFF_BYTES = 256 * 1024

// Byte accounting mirrors the JSON serialization: 2 bytes for the "[]" wrapper,
// +1 per comma separator, so kept output never exceeds MAX_SUMMARY_DIFF_BYTES.
// Entries that do not fit are skipped individually so later, smaller entries
// are still kept.
export function truncateSummaryDiffs(diffs: Snapshot.FileDiff[] | undefined) {
  if (!diffs) return undefined
  let total = 2
  const kept: Snapshot.FileDiff[] = []
  for (const item of diffs) {
    const size = Buffer.byteLength(JSON.stringify(item)) + (kept.length > 0 ? 1 : 0)
    if (total + size > MAX_SUMMARY_DIFF_BYTES) continue
    total += size
    kept.push(item)
  }
  return kept
}

export function fromRow(row: SessionRow): Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
        }
      : undefined
  const revert = row.revert
    ? {
        messageID: MessageID.make(row.revert.messageID),
        partID: row.revert.partID ? PartID.make(row.revert.partID) : undefined,
        snapshot: row.revert.snapshot,
        diff: row.revert.diff,
      }
    : undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    path: row.path ?? undefined,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    agent: row.agent ?? undefined,
    model: row.model
      ? {
          id: ModelV2.ID.make(row.model.id),
          providerID: ProviderV2.ID.make(row.model.providerID),
          variant: row.model.variant,
        }
      : undefined,
    version: row.version,
    summary,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    metadata: row.metadata ?? undefined,
    revert,
    permission: row.permission ? [...row.permission] : undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
    dagMode: row.dag_mode,
    dagBudgetTokens: row.dag_budget_tokens,
  }
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? EmptyTokens).input,
    tokens_output: (info.tokens ?? EmptyTokens).output,
    tokens_reasoning: (info.tokens ?? EmptyTokens).reasoning,
    tokens_cache_read: (info.tokens ?? EmptyTokens).cache.read,
    tokens_cache_write: (info.tokens ?? EmptyTokens).cache.write,
    revert: info.revert
      ? {
          messageID: SessionMessageID.ID.make(info.revert.messageID),
          partID: info.revert.partID,
          snapshot: info.revert.snapshot,
          diff: info.revert.diff,
        }
      : null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
    dag_mode: info.dagMode,
    dag_budget_tokens: info.dagBudgetTokens,
  }
}

function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2], 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

function sessionPath(worktree: string, cwd: string) {
  return path.relative(path.resolve(worktree), cwd).replaceAll("\\", "/")
}

const Summary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optionalOmitUndefined(Schema.Array(Snapshot.FileDiff)),
})

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const EmptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

// Legacy HTTP accepted negative values here. Keep archive timestamps permissive
// while excluding non-finite values that cannot round-trip through JSON.
export const ArchivedTimestamp = Schema.Finite

const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  compacting: optionalOmitUndefined(NonNegativeInt),
  archived: optionalOmitUndefined(ArchivedTimestamp),
})

const Revert = Schema.Struct({
  messageID: MessageID,
  partID: optionalOmitUndefined(PartID),
  snapshot: optionalOmitUndefined(Schema.String),
  diff: optionalOmitUndefined(Schema.String),
})

const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  variant: optionalOmitUndefined(Schema.String),
})

export const Metadata = Schema.Record(Schema.String, Schema.Any)

export const UpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Metadata),
  permission: Schema.optional(PermissionV1.Ruleset),
  time: Schema.optional(
    Schema.Struct({
      archived: Schema.optional(ArchivedTimestamp),
    }),
  ),
})
export type UpdateInput = typeof UpdateInput.Type

/** A message-page cursor that does not decode. Callers map this to their own bad-request shape. */
export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("SessionInvalidCursor", {}) {}

export const Info = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: ProjectV2.ID,
  workspaceID: optionalOmitUndefined(WorkspaceV2.ID),
  directory: Schema.String,
  path: optionalOmitUndefined(Schema.String),
  parentID: optionalOmitUndefined(SessionID),
  summary: optionalOmitUndefined(Summary),
  cost: optionalOmitUndefined(Schema.Finite),
  tokens: optionalOmitUndefined(Tokens),
  title: Schema.String,
  agent: optionalOmitUndefined(Schema.String),
  model: optionalOmitUndefined(Model),
  version: Schema.String,
  metadata: optionalOmitUndefined(Metadata),
  time: Time,
  permission: optionalOmitUndefined(PermissionV1.Ruleset),
  revert: optionalOmitUndefined(Revert),
  dagMode: optionalOmitUndefined(DagMode),
  dagBudgetTokens: optionalOmitUndefined(DagBudgetTokens),
}).annotate({ identifier: "Session" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const CreateInput = Schema.optional(
  Schema.Struct({
    // #1026: child sessions are created only by ChildRun owners (task, DAG
    // spawn) through `Session.Service.create`, never from a public payload.
    // `Never` makes the decoder reject the key with a 400 instead of silently
    // stripping it into a top-level session.
    parentID: Schema.optional(Schema.Never),
    title: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    model: Schema.optional(Model),
    metadata: Schema.optional(Metadata),
    permission: Schema.optional(PermissionV1.Ruleset),
    workspaceID: Schema.optional(WorkspaceV2.ID),
    // #1013 (C1 PR5): DAG mode is chosen at creation time only; PATCH rejects it.
    dagMode: Schema.optional(DagMode),
  }),
)
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

/**
 * Input of `Session.Service.create`, the in-process entry. Unlike the public
 * `CreateInput` payload it carries `parentID` (child sessions) and an explicit
 * `directory`; it never goes through a request schema.
 */
export interface InternalCreateInput {
  parentID?: SessionID
  title?: string
  agent?: string
  model?: Schema.Schema.Type<typeof Model>
  metadata?: typeof Metadata.Type
  permission?: PermissionV1.Ruleset
  workspaceID?: WorkspaceV2.ID
  /** #1013 (C1 PR5): creation-time DAG mode; defaults to "off". */
  dagMode?: "on" | "off"
  /** #943: explicit execution directory; defaults to the ambient instance. */
  directory?: string
}

export const ForkInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export const GetInput = SessionID
export const ChildrenInput = SessionID
export const RemoveInput = SessionID
export const SetTitleInput = Schema.Struct({ sessionID: SessionID, title: Schema.String })
export const SetArchivedInput = Schema.Struct({
  sessionID: SessionID,
  time: Schema.optional(ArchivedTimestamp),
})
export const SetMetadataInput = Schema.Struct({
  sessionID: SessionID,
  metadata: Metadata,
})
export const SetPermissionInput = Schema.Struct({
  sessionID: SessionID,
  permission: PermissionV1.Ruleset,
})
export const SetRevertInput = Schema.Struct({
  sessionID: SessionID,
  revert: Schema.optional(Revert),
  summary: Schema.optional(Summary),
})
export const MessagesInput = Schema.Struct({
  sessionID: SessionID,
  limit: Schema.optional(NonNegativeInt),
})
export type ListInput = {
  directory?: string
  scope?: "project"
  path?: string
  workspaceID?: WorkspaceV2.ID
  roots?: boolean
  start?: number
  search?: string
  limit?: number
}

export const Event = {
  Created: SessionV1.Event.Created,
  Updated: SessionV1.Event.Updated,
  Deleted: SessionV1.Event.Deleted,
  Diff: SessionV1.Event.Diff,
  Error: SessionV1.Event.Error,
}

export function plan(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  const base = instance.project.vcs
    ? path.join(instance.root, PROJECT_DIR, "plans")
    : path.join(Global.Path.data, "plans")
  if (instance.project.vcs) assertProjectRootWritable(instance.root, Global.Path.home)
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

export const getUsage = (input: { model: Provider.Model; usage: Usage; metadata?: ProviderMetadata }) => {
  const safe = (value: number) => {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, value)
  }
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

  const cacheReadInputTokens = safe(input.usage.cacheReadInputTokens ?? 0)
  const cacheWriteInputTokens = safe(
    Number(
      input.usage.cacheWriteInputTokens ??
        input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // google-vertex-anthropic returns metadata under "vertex" key
        // (AnthropicMessagesLanguageModel custom provider key from 'vertex.anthropic.messages')
        input.metadata?.["vertex"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers
  // (including Anthropic/Bedrock which previously excluded them). Always subtract cache
  // tokens to get the non-cached input count for separate cost calculation.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  const total = input.usage.totalTokens

  const tokens = {
    total,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }

  const contextTokens = inputTokens
  const costInfo =
    input.model.cost?.tiers
      ?.filter((item) => item.tier.type === "context" && contextTokens > item.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (input.model.cost?.experimentalOver200K && contextTokens > 200_000
      ? input.model.cost.experimentalOver200K
      : input.model.cost)
  const totalNanoAiu = input.metadata?.["copilot"]?.["totalNanoAiu"]
  return {
    cost:
      typeof totalNanoAiu === "number" && Number.isFinite(totalNanoAiu) && totalNanoAiu >= 0
        ? new Decimal(totalNanoAiu).div(100_000_000_000).toNumber()
        : safe(
            new Decimal(0)
              .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
              .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
              .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
              .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
              // TODO: update models.dev to have better pricing model, for now:
              // charge reasoning tokens at the same rate as output tokens
              .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
              .toNumber(),
          ),
    tokens,
  }
}

export class BusyError extends Schema.TaggedError<BusyError>()("SessionBusyError", {
  sessionID: SessionID,
}) {}

export type NotFound = NotFoundError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<Info[]>
  readonly create: (input?: InternalCreateInput) => Effect.Effect<Info>
  readonly fork: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Info, NotFound>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info, NotFound>
  readonly setTitle: (input: {
    sessionID: SessionID
    title: string
    source?: "custom" | "generated"
  }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number }) => Effect.Effect<void>
  readonly setAgent: (input: { sessionID: SessionID; agent: string; timestamp?: number }) => Effect.Effect<void>
  readonly setModelSelection: (input: {
    sessionID: SessionID
    model: NonNullable<Info["model"]>
    timestamp?: number
  }) => Effect.Effect<void>
  readonly setMetadata: (input: typeof SetMetadataInput.Type, guard?: (current: Info) => boolean) => Effect.Effect<void>
  readonly setPermission: (input: { sessionID: SessionID; permission: PermissionV1.Ruleset }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly readMessageDiff: (messageID: MessageID) => Effect.Effect<Snapshot.FileDiff[]>
  readonly readSessionMessageDiffs: (sessionID: SessionID) => Effect.Effect<ReadonlyMap<MessageID, Snapshot.FileDiff[]>>
  readonly writeMessageDiff: (input: {
    sessionID: SessionID
    messageID: MessageID
    diff: ReadonlyArray<Snapshot.FileDiff>
  }) => Effect.Effect<void>
  readonly deleteMessageDiff: (messageID: MessageID) => Effect.Effect<void>
  readonly setWorkspace: (input: { sessionID: SessionID; workspaceID: Info["workspaceID"] }) => Effect.Effect<void>
  readonly diff: (sessionID: SessionID) => Effect.Effect<Snapshot.FileDiff[]>
  readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<SessionV1.WithParts[], NotFound>
  readonly messagesPage: (input: {
    sessionID: SessionID
    limit: number
    before?: string
  }) => Effect.Effect<{ items: SessionV1.WithParts[]; cursor?: string }, NotFound | InvalidCursor>
  readonly applyUpdate: (input: { sessionID: SessionID } & UpdateInput) => Effect.Effect<Info, NotFound>
  readonly children: (parentID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, NotFound>
  readonly updateMessage: <T extends SessionV1.Info>(msg: T) => Effect.Effect<T>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<SessionV1.Part | undefined>
  readonly updatePart: <T extends SessionV1.Part>(part: T) => Effect.Effect<T>
  /**
   * Publishes one settle batch — message updates followed by their parts — as a
   * single durable transaction. Every entry must belong to the same session.
   * Parts are published without a defensive clone, so callers must pass objects
   * they will not mutate afterwards; message updates keep the existing
   * reference semantics of `updateMessage`.
   */
  readonly settle: (input: {
    readonly messages?: ReadonlyArray<SessionV1.Info>
    readonly parts?: ReadonlyArray<SessionV1.Part>
  }) => Effect.Effect<void>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (msg: SessionV1.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<SessionV1.WithParts>, NotFound>
  /** Reads one user turn — the user message plus its assistant replies — in order. */
  readonly turnMessages: (input: {
    sessionID: SessionID
    userMessageID: MessageID
  }) => Effect.Effect<SessionV1.WithParts[], NotFound>
  /** Looks up message info by id inside one session, without loading parts. */
  readonly getMessageInfos: (input: {
    sessionID: SessionID
    messageIDs: ReadonlyArray<string>
  }) => Effect.Effect<ReadonlyMap<string, SessionV1.Info>>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/Session") {}

export const use = serviceUse(Service)

export type Patch = Omit<Partial<Info>, "time" | "summary" | "revert" | "permission"> & {
  time?: Partial<Info["time"]>
  summary?: Info["summary"] | null
  revert?: Info["revert"] | null
  permission?: Info["permission"] | null
}

export const layer: Layer.Layer<
  Service,
  never,
  | BackgroundJob.Service
  | RuntimeFlags.Service
  | Database.Service
  | EventV2Bridge.Service
  | Goal.Service
  | ExclusiveRegistry.Service
  | Dag.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const database = yield* Database.Service
    const agentMessages = Option.getOrUndefined(yield* Effect.serviceOption(DagMessages.Service))
    const background = yield* BackgroundJob.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    // SettingsHook (for the SessionEnd trigger in remove()) is likewise optional.
    // It is resolved HERE, at construction time, because that is the only point
    // at which a caller-provided SettingsHook mock/layer is in this layer's
    // context (it is consumed by construction and not re-exposed in the runtime
    // output context). The tag is obtained via a DEFERRED dynamic import rather
    // than a top-level `import { SettingsHook }`: the hook barrel pulls in
    // Provider → Plugin → Session, so a static import closes a load-order cycle
    // that surfaces as a TDZ ReferenceError when test entries load goal/hook
    // modules. By construction time the static module graph has settled, so the
    // deferred import resolves to the cached module instantly.
    const { SettingsHook } = yield* Effect.promise(() => import("@/hook"))
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    const hookSkills = Option.getOrUndefined(yield* Effect.serviceOption(Skill.Service))
    const hookLifecycle = Option.getOrUndefined(yield* Effect.serviceOption(HookLifecycle.Service))
    const hookWatch = Option.getOrUndefined(yield* Effect.serviceOption(HookFileWatch.Service))
    const hookConfig = Option.getOrUndefined(yield* Effect.serviceOption(HookConfigChange.Service))
    const hookStart = Option.getOrUndefined(yield* Effect.serviceOption(HookStartContext.Service))
    // GOAL-FP-01-05: goal/dag/lease cleanup used to resolve via
    // Effect.serviceOption(Goal.Service), which yields None in the production
    // AppLayer — Goal.defaultLayer and Session.defaultLayer are
    // Layer.mergeAll siblings (effect/app-runtime.ts) and mergeAll does not
    // cross-provide, so Session's layer context never contained Goal and
    // `opencode session delete` silently skipped the cleanup. The cleanup is
    // NOT optional (delete integrity), so these are now hard layer
    // requirements: typecheck enforces that every composition of Session's
    // layer provides them (defaultLayer self-provides all three below; the
    // node graph lists them in Session.node). No layer cycle exists — Goal,
    // Dag and ExclusiveRegistry defaultLayers are all self-contained and
    // none of them depends on Session.
    const goal = yield* Goal.Service
    const dag = yield* Dag.Service
    const automation = yield* ExclusiveRegistry.Service
    const toolSources = Option.getOrUndefined(yield* Effect.serviceOption(ToolSourceLedger.Service))

    const createNext = Effect.fn("Session.createNext")(function* (input: {
      id?: SessionID
      title?: string
      titleSource?: "custom" | "generated"
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      parentID?: SessionID
      workspaceID?: WorkspaceV2.ID
      directory: string
      path?: string
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
      dagMode?: "on" | "off"
      dagBudgetTokens?: number | null
    }) {
      const ctx = yield* InstanceState.context
      const result: Info = {
        id: SessionID.descending(input.id),
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: ctx.project.id,
        directory: input.directory,
        path: input.path,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        title: input.title ?? (input.parentID ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString(),
        agent: input.agent,
        model: input.model,
        metadata: {
          ...input.metadata,
          engine: "v1",
          hookTitleSource: input.title ? (input.titleSource ?? "custom") : "generated",
        },
        permission: input.permission ? [...input.permission] : undefined,
        cost: 0,
        tokens: EmptyTokens,
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
        dagMode: input.dagMode ?? "off",
        dagBudgetTokens: input.dagBudgetTokens ?? null,
      }
      yield* Effect.logInfo("created", result)

      yield* events.publish(SessionV1.Event.Created, { sessionID: result.id, info: result })

      return result
    })

    const get = Effect.fn("Session.get")(function* (id: SessionID) {
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
      return fromRow(row)
    })

    const list = Effect.fn("Session.list")(function* (input?: ListInput) {
      const ctx = yield* InstanceState.context
      return yield* listByProject(db, {
        projectID: ctx.project.id,
        experimentalWorkspaces: flags.experimentalWorkspaces,
        ...input,
      })
    })

    const children = Effect.fn("Session.children")(function* (parentID: SessionID) {
      const rows = yield* db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.parent_id, parentID)))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
      const callSettings = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service)) ?? settingsHook
      const session = yield* get(sessionID)
      try {
        // `remove` needs to work in all cases, such as broken sessions that
        // run cleanup without instance state.
        const currentInstance = yield* InstanceState.context.pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        const hasInstance = currentInstance !== undefined

        if (hasInstance) yield* cancelSessionJobs(background, sessionID)
        const kids = yield* children(sessionID)
        for (const child of kids) {
          yield* remove(child.id)
        }

        // A deletion ends only the attached top-level client session; child lifetime uses SubagentStop.
        if (!session.parentID && callSettings) {
          const finish = Effect.gen(function* () {
            // The engine materializes the transcript only when a SessionEnd handler matches.
            if (hookLifecycle && !(yield* hookLifecycle.claimEnd(sessionID))) return
            const result = yield* callSettings.trigger({ event: "SessionEnd", reason: "other" }, { sessionID })
            yield* landSystemMessages(result, { sessionID })
            if (callSettings.settleSessionEnd) yield* callSettings.settleSessionEnd()
          })
          yield* finish.pipe(
            Effect.timeout(yield* callSettings.sessionEndTimeout?.() ?? Effect.succeed(1500)),
            Effect.catchTag("TimeoutError", () => Effect.void),
            Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void)),
          )
        }
        const [{ Permission }, { InstanceStore }] = yield* Effect.promise(() =>
          Promise.all([import("@/permission"), import("@/project/instance-store")]),
        )
        const permission = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
        const instances = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
        if (permission?.clearHookPolicy && (hasInstance || instances)) {
          const clear = permission.clearHookPolicy(sessionID)
          yield* currentInstance?.directory === session.directory || !instances
            ? clear
            : instances.provide(
                { directory: session.directory, trustProject: currentInstance?.trustProject === true },
                clear,
              )
        }
        if (hasInstance || instances) {
          const [{ SessionAttention }, { SessionStatus }] = yield* Effect.promise(() =>
            Promise.all([import("@/notification/attention"), import("@/session/status")]),
          )
          const attention = Option.getOrUndefined(yield* Effect.serviceOption(SessionAttention.Service))
          const status = Option.getOrUndefined(yield* Effect.serviceOption(SessionStatus.Service))
          if (status?.clear || attention) {
            const clearAttention = Effect.gen(function* () {
              if (status?.clear) yield* status.clear(sessionID)
              if (attention) yield* attention.clear(sessionID)
            })
            // Finalizers can outlive the InstanceStore layer. Reuse the captured
            // directory context instead of loading it through a closed store.
            yield* currentInstance?.directory === session.directory || !instances
              ? clearAttention
              : instances.provide(
                  { directory: session.directory, trustProject: currentInstance?.trustProject === true },
                  clearAttention,
                )
          }
        }
        if (callSettings?.clearSession) yield* callSettings.clearSession(sessionID)
        if (hookWatch) yield* hookWatch.clear(sessionID)
        if (hookConfig) yield* hookConfig.clear(sessionID)
        yield* HookTranscript.clearEnvironment(sessionID).pipe(Effect.ignore)
        yield* HookTranscript.clearScratchpad(sessionID).pipe(Effect.ignore)
        // Cleanup durable automation state BEFORE the Deleted publish: the
        // SessionProjector deletes the session row (and FK cascades wipe the
        // workflow rows) inside the Deleted publish transaction. Publishing
        // first would make `dag.store.listBySession` below return [] (the
        // cascade already removed the rows), turning the cancel loop into
        // dead code — the WorkflowCancelled event would never fire, the
        // DagLoop terminal handler would never abort running child sessions,
        // and a crash between publish and cleanup would orphan goal rows.
        // Running cleanup first means a crash mid-way can only leave a live
        // session with no goal/workflows (consistent, recoverable) — never
        // orphan goal rows or re-adoptable workflows under a deleted session.
        // The three steps live in separate aggregates (goal_state/goal_outcome,
        // workflow events, the lease map) so no shared transaction is
        // available; each step is individually atomic.
        yield* goal
          .purgeSession(sessionID)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("goal purge failed during session remove", { sessionID, cause }),
            ),
          )
        // GOAL-FP-01-06: cancel workflows owned by this session so the running
        // DagLoop runtime stops (aborts child sessions, releases the dag
        // lease) and a restart recovery scan can never re-adopt them.
        // Terminal rows are already inert; pending rows are terminalized by
        // the startup orphan-pending sweep (cancel is not a valid transition
        // from pending).
        const workflows = yield* dag.store.listBySession(sessionID).pipe(Effect.orDie)
        // #524: capture EVERY related dag aggregate before the Deleted publish —
        // the projector's session-row delete FK-cascades the workflow rows away
        // inside the publish transaction, so listBySession after it returns []
        // and terminal aggregates would be stranded as event-store residue.
        const dagIDs = workflows.map((workflow) => workflow.id)
        for (const workflow of workflows) {
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- WorkflowRow.status is a plain string column whose values are the WorkflowStatus literals (only the projector writes it, via validated transitions).
          if (isWorkflowTerminalStatus(workflow.status as never)) continue
          yield* dag.cancel(workflow.id).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("workflow cancellation failed during session remove", {
                dagID: workflow.id,
                sessionID,
                cause,
              }),
            ),
          )
        }
        // Belt-and-braces lease sweep: drops goal registrations, wake-sweep
        // registrations, and any dag registration whose workflow did not
        // reach the terminalization handler above (e.g. cancel rejected).
        yield* automation
          .purgeSession(sessionID)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("exclusive registry purge failed during session remove", { sessionID, cause }),
            ),
          )
        // Session-row deletion (projector, inside this publish's transaction)
        // comes LAST, after every cleanup step above.
        if (toolSources) yield* toolSources.clearSession(sessionID)
        yield* db
          .transaction(
            () =>
              Effect.gen(function* () {
                if (agentMessages) yield* agentMessages.closeSession(sessionID, "session_deleted")
                yield* events.publish(SessionV1.Event.Deleted, { sessionID, info: session })
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        yield* events.remove(sessionID)
        // #524: scrub the related dag event aggregates after the session
        // aggregate — terminal workflows included (the cancel loop above skips
        // them). Soft-degrading like the EventResidueSweep sibling: a failed
        // scrub is logged and leaves the aggregate for the startup residue
        // sweep, never fails the removal. Interruption is preserved, not
        // degraded into a warning (same hasInterrupts re-raise discipline).
        yield* Effect.forEach(
          dagIDs,
          (dagID) =>
            events.remove(dagID).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("dag aggregate scrub failed during session remove", {
                      sessionID,
                      dagID,
                      cause,
                    }),
              ),
            ),
          { discard: true },
        )
      } catch (error) {
        yield* Effect.logError("failed to remove session", { sessionID, error })
      }
    })

    const updateMessage = <T extends SessionV1.Info>(msg: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: msg.sessionID, info: msg })
        return msg
      }).pipe(Effect.withSpan("Session.updateMessage"))

    const updatePart = <T extends SessionV1.Part>(part: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: part.sessionID,
          part: structuredClone(part),
          time: Date.now(),
        })
        return part
      }).pipe(Effect.withSpan("Session.updatePart"))

    const settle = Effect.fn("Session.settle")(function* (input: {
      messages?: ReadonlyArray<SessionV1.Info>
      parts?: ReadonlyArray<SessionV1.Part>
    }) {
      const time = Date.now()
      const batch: Array<Parameters<typeof events.publishMany>[0][number]> = [
        ...(input.messages ?? []).map((info) => ({
          definition: SessionV1.Event.MessageUpdated,
          data: { sessionID: info.sessionID, info },
        })),
        ...(input.parts ?? []).map((part) => ({
          definition: SessionV1.Event.PartUpdated,
          data: { sessionID: part.sessionID, part, time },
        })),
      ]
      if (batch.length) yield* events.publishMany(batch)
    })

    const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
      const row = yield* db
        .select()
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, input.sessionID),
            eq(PartTable.message_id, input.messageID),
            eq(PartTable.id, input.partID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return {
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      } as SessionV1.Part
    })

    const create = Effect.fn("Session.create")(function* (input?: InternalCreateInput) {
      const ctx = yield* InstanceState.context
      const workspace = yield* InstanceState.workspaceID
      const directory = input?.directory ?? ctx.directory
      return yield* createNext({
        parentID: input?.parentID,
        directory,
        path: sessionPath(ctx.worktree, directory),
        title: input?.title,
        agent: input?.agent,
        model: input?.model,
        metadata: input?.metadata,
        permission: input?.permission,
        workspaceID: input?.workspaceID ?? workspace,
        dagMode: input?.dagMode,
      })
    })

    const fork = Effect.fn("Session.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const callSettings = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service)) ?? settingsHook
      const ctx = yield* InstanceState.context
      const original = yield* get(input.sessionID)
      const title = getForkedTitle(original.title)
      const session = yield* createNext({
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        workspaceID: original.workspaceID,
        title,
        metadata: structuredClone(original.metadata),
        titleSource: original.metadata?.hookTitleSource === "custom" ? "custom" : "generated",
        // #1010 (E0): a fork keeps the DAG mode and budget of its source;
        // usage counters still start from zero.
        dagMode: original.dagMode,
        dagBudgetTokens: original.dagBudgetTokens,
      })
      const msgs = yield* messages({ sessionID: input.sessionID })
      const cutoff = input.messageID ? msgs.find((msg) => msg.info.id === input.messageID) : undefined
      const idMap = new Map<string, MessageID>()

      // Every updateMessage/updatePart publishes a durable event, and each
      // publish opens its own db transaction — a large session forks in
      // thousands of commits. The effect-drizzle adapter turns nested
      // `db.transaction` calls into savepoints on the outer transaction's
      // connection (reads inside the transaction see the uncommitted writes,
      // so seq allocation stays consecutive), so wrapping the copy loop in a
      // single transaction converges the fork to one commit while keeping the
      // per-event publish semantics (projector order, wake order) unchanged.
      yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              for (const msg of msgs) {
                if (cutoff && !MessageV2.before(msg.info, cutoff.info)) break
                const newID = MessageID.ascending()
                idMap.set(msg.info.id, newID)

                const parentID =
                  msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
                const cloned = yield* updateMessage({
                  ...msg.info,
                  sessionID: session.id,
                  id: newID,
                  ...(parentID && { parentID }),
                })

                for (const part of msg.parts) {
                  const p: SessionV1.Part = {
                    ...part,
                    id: PartID.ascending(),
                    messageID: cloned.id,
                    sessionID: session.id,
                  }
                  if (p.type === "compaction" && p.tail_start_id) {
                    p.tail_start_id = idMap.get(p.tail_start_id)
                  }
                  yield* updatePart(p)
                }
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (callSettings) {
        const snapshot = yield* messages({ sessionID: session.id }).pipe(Effect.orDie)
        const result = yield* callSettings.trigger(
          {
            event: "SessionStart",
            source: "fork",
            // A fork is top-level by construction: report its inherited DAG mode read-only.
            ...(session.dagMode !== undefined ? { dagMode: session.dagMode } : {}),
            ...(yield* HookModelMetrics.forSession({
              source: "fork",
              sessionID: session.id,
              title: session.title,
              titleSource: session.metadata?.hookTitleSource,
              model: original.model,
              agent: original.agent,
              history: snapshot,
            })),
          },
          { sessionID: session.id },
        )
        yield* landSystemMessages(result, { sessionID: session.id })
        let apply = HookSessionContext.applyStart({
          session,
          sessions: api,
          settings: callSettings,
          result,
          startContext: hookStart,
          reloadSkills: hookSkills?.reload(),
        })
        if (hookLifecycle) apply = apply.pipe(Effect.provideService(HookLifecycle.Service, hookLifecycle))
        if (hookWatch) apply = apply.pipe(Effect.provideService(HookFileWatch.Service, hookWatch))
        if (hookConfig) apply = apply.pipe(Effect.provideService(HookConfigChange.Service, hookConfig))
        yield* apply
      }
      return session
    })

    const patch = (sessionID: SessionID, info: Patch) =>
      Effect.gen(function* () {
        const current = yield* get(sessionID)
        const next = {
          ...current,
          ...info,
          time: info.time ? { ...current.time, ...info.time } : current.time,
          summary: info.summary === null ? undefined : (info.summary ?? current.summary),
          revert: info.revert === null ? undefined : (info.revert ?? current.revert),
          permission: info.permission === null ? undefined : (info.permission ?? current.permission),
        } as Info
        yield* events.publish(SessionV1.Event.Updated, { sessionID, info: next })
      })

    const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setTitle = Effect.fn("Session.setTitle")(function* (input: {
      sessionID: SessionID
      title: string
      source?: "custom" | "generated"
    }) {
      const current = yield* get(input.sessionID).pipe(Effect.orDie)
      yield* patch(input.sessionID, {
        title: input.title,
        metadata: { ...current.metadata, hookTitleSource: input.source ?? "custom" },
      }).pipe(Effect.orDie)
    })

    const setArchived = Effect.fn("Session.setArchived")(function* (input: { sessionID: SessionID; time?: number }) {
      yield* patch(input.sessionID, { time: { archived: input.time } }).pipe(Effect.orDie)
    })

    const setAgent = Effect.fn("Session.setAgent")(function* (input: {
      sessionID: SessionID
      agent: string
      timestamp?: number
    }) {
      yield* events.publish(SessionV1.Event.AgentSwitched, {
        sessionID: input.sessionID,
        agent: input.agent,
        timestamp: input.timestamp ?? Date.now(),
      })
    })

    const setModelSelection = Effect.fn("Session.setModelSelection")(function* (input: {
      sessionID: SessionID
      model: NonNullable<Info["model"]>
      timestamp?: number
    }) {
      yield* events.publish(SessionV1.Event.ModelSwitched, {
        sessionID: input.sessionID,
        model: input.model,
        timestamp: input.timestamp ?? Date.now(),
      })
    })

    const setMetadata = Effect.fn("Session.setMetadata")(function* (
      input: typeof SetMetadataInput.Type,
      guard?: (current: Info) => boolean,
    ) {
      // An optional guard runs after any caller-side barrier and immediately
      // before the write, so a stale commit cannot overwrite a newer metadata
      // state it did not observe.
      const current = yield* get(input.sessionID).pipe(Effect.orDie)
      if (guard && !guard(current)) return
      // `engine` is an internal routing marker, not user metadata. Keep it when
      // a client replaces metadata, or a message-less V1 session would be
      // claimed by the V2 executor after a PATCH.
      const engine = current.metadata?.engine
      yield* patch(input.sessionID, {
        metadata: engine === undefined ? input.metadata : { ...input.metadata, engine },
        time: { updated: Date.now() },
      }).pipe(Effect.orDie)
    })

    const setPermission = Effect.fn("Session.setPermission")(function* (input: {
      sessionID: SessionID
      permission: PermissionV1.Ruleset
    }) {
      yield* patch(input.sessionID, { permission: [...input.permission], time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const setRevert = Effect.fn("Session.setRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, {
        summary: input.summary,
        time: { updated: Date.now() },
        revert: input.revert,
      }).pipe(Effect.orDie)
    })

    const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() }, revert: null }).pipe(Effect.orDie)
    })

    const setSummary = Effect.fn("Session.setSummary")(function* (input: {
      sessionID: SessionID
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary }).pipe(Effect.orDie)
    })

    // H5 (#1016): message diffs live in their own table. These accessors write
    // the database directly (no durable event); the projector-owned message
    // row stays diff-free so hydrating a message never parses a large patch.
    const readMessageDiff = Effect.fn("Session.readMessageDiff")(function* (messageID: MessageID) {
      const row = yield* db
        .select()
        .from(MessageDiffTable)
        .where(eq(MessageDiffTable.message_id, messageID))
        .get()
        .pipe(Effect.orDie)
      return row ? [...row.diff] : []
    })

    const readSessionMessageDiffs = Effect.fn("Session.readSessionMessageDiffs")(function* (sessionID: SessionID) {
      const rows = yield* db
        .select()
        .from(MessageDiffTable)
        .where(eq(MessageDiffTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const result = new Map<MessageID, Snapshot.FileDiff[]>()
      for (const row of rows) result.set(row.message_id, [...row.diff])
      return result
    })

    const writeMessageDiff = Effect.fn("Session.writeMessageDiff")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      diff: ReadonlyArray<Snapshot.FileDiff>
    }) {
      const diff = [...input.diff]
      yield* db
        .insert(MessageDiffTable)
        .values({ message_id: input.messageID, session_id: input.sessionID, diff })
        .onConflictDoUpdate({
          target: MessageDiffTable.message_id,
          set: { session_id: input.sessionID, diff },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const deleteMessageDiff = Effect.fn("Session.deleteMessageDiff")(function* (messageID: MessageID) {
      yield* db.delete(MessageDiffTable).where(eq(MessageDiffTable.message_id, messageID)).run().pipe(Effect.orDie)
    })

    const setWorkspace = Effect.fn("Session.setWorkspace")(function* (input: {
      sessionID: SessionID
      workspaceID: Info["workspaceID"]
    }) {
      yield* patch(input.sessionID, { workspaceID: input.workspaceID, time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
      void sessionID
      return [] as Snapshot.FileDiff[]
    })

    const applyUpdate: Interface["applyUpdate"] = Effect.fn("Session.applyUpdate")(function* (input) {
      const current = yield* get(input.sessionID)
      if (input.title !== undefined) {
        yield* setTitle({ sessionID: input.sessionID, title: input.title })
      }
      if (input.metadata !== undefined) {
        yield* setMetadata({ sessionID: input.sessionID, metadata: input.metadata })
      }
      if (input.permission !== undefined) {
        // Permission.merge is a flat concatenation with the new rules last.
        yield* setPermission({
          sessionID: input.sessionID,
          permission: [...(current.permission ?? []), ...input.permission],
        })
      }
      if (input.time?.archived !== undefined) {
        yield* setArchived({ sessionID: input.sessionID, time: input.time.archived })
      }
      return yield* get(input.sessionID)
    })

    const messagesPage: Interface["messagesPage"] = Effect.fn("Session.messagesPage")(function* (input) {
      const before = input.before
      if (before) {
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new InvalidCursor(),
        })
      }
      const page = yield* MessageV2.page(input).pipe(Effect.provideService(Database.Service, database))
      return { items: page.items, cursor: page.cursor }
    })

    const messages: Interface["messages"] = Effect.fn("Session.messages")(function* (input) {
      if (input.limit) {
        return (yield* MessageV2.page({ sessionID: input.sessionID, limit: input.limit }).pipe(
          Effect.provideService(Database.Service, database),
        )).items
      }

      const size = 50
      const result = [] as SessionV1.WithParts[]
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID: input.sessionID, limit: size, before }).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item) result.push(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return result.reverse()
    })

    const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* events.publish(SessionV1.Event.MessageRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    })

    const removePart = Effect.fn("Session.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    })

    const updatePartDelta = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      yield* events.publish(MessageV2.Event.PartDelta, input)
    })

    /** Finds the first message matching the predicate, searching newest-first. */
    const findMessage: Interface["findMessage"] = Effect.fn("Session.findMessage")(function* (sessionID, predicate) {
      const size = 50
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID, limit: size, before }).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item && predicate(item)) return Option.some(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return Option.none<SessionV1.WithParts>()
    })

    const turnMessages: Interface["turnMessages"] = Effect.fn("Session.turnMessages")(function* (input) {
      return yield* MessageV2.turnMessages(input).pipe(Effect.provideService(Database.Service, database))
    })

    const getMessageInfos: Interface["getMessageInfos"] = (input) => MessageV2.infosByIDs(db, input)

    const api: Interface = Service.of({
      list,
      create,
      fork,
      touch,
      get,
      setTitle,
      setArchived,
      setAgent,
      setModelSelection,
      setMetadata,
      setPermission,
      setRevert,
      clearRevert,
      setSummary,
      readMessageDiff,
      readSessionMessageDiffs,
      writeMessageDiff,
      deleteMessageDiff,
      setWorkspace,
      diff,
      messages,
      messagesPage,
      applyUpdate,
      children,
      remove,
      updateMessage,
      removeMessage,
      removePart,
      updatePart,
      settle,
      getPart,
      updatePartDelta,
      findMessage,
      turnMessages,
      getMessageInfos,
    })
    return api
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(Database.defaultLayer),
  // Session.create/update/remove publish SessionV1 events and read the rows
  // back through Session.get/list, so the projector that writes those rows is
  // part of this layer (same shape as Dag.defaultLayer → DagProjector). It used
  // to arrive transitively through the removed V2 session service, so every
  // composition of Session.defaultLayer — AppLayer, the HTTP server app,
  // workspaces and tests — now needs it explicitly here.
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(DagMessages.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
  // GOAL-FP-01-05/-06: self-provide the remove() cleanup dependencies so the
  // cleanup runs in EVERY composition of Session.defaultLayer (AppLayer
  // mergeAll siblings, DagLoop, workspace, share, MoveSession, …). All three
  // defaultLayers are self-contained (never requirements) and none depends on
  // Session, so this cannot introduce a layer cycle; memoization shares the
  // instances with the other group-1 siblings.
  Layer.provide(Goal.defaultLayer),
  Layer.provide(ExclusiveRegistry.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(ToolSourceLedger.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(HookLifecycle.defaultLayer),
  Layer.provide(HookFileWatch.defaultLayer),
  Layer.provide(HookConfigChange.defaultLayer),
  Layer.provide(HookStartContext.defaultLayer),
)

function listByProject(
  db: Database.Interface["db"],
  input: ListInput & {
    projectID: ProjectV2.ID
    experimentalWorkspaces: boolean
  },
) {
  const conditions = [eq(SessionTable.project_id, input.projectID)]

  if (input.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (input.path !== undefined) {
    if (input.path) {
      const conds = [
        eq(SessionTable.path, input.path),
        like(SessionTable.path, sql.param(`${input.path}/%`, SessionTable.path)),
      ]

      conditions.push(
        input.directory
          ? or(...conds, and(isNull(SessionTable.path), eq(SessionTable.directory, input.directory))!)!
          : or(...conds)!,
      )
    }
  } else if (input.scope !== "project") {
    if (input.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
  }
  if (input.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }

  const limit = input.limit ?? 100

  return db
    .select()
    .from(SessionTable)
    .where(and(...conditions))
    .orderBy(desc(SessionTable.time_updated))
    .limit(limit)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(fromRow)),
    )
}

export const node = LayerNode.make(layer, [
  Skill.node,
  HookLifecycle.node,
  HookFileWatch.node,
  HookConfigChange.node,
  HookStartContext.node,
  BackgroundJob.node,
  RuntimeFlags.node,
  Database.node,
  DagMessages.node,
  EventV2Bridge.node,
  Goal.node,
  ExclusiveRegistry.node,
  // PR2: the dag-release re-trigger is gated by the session inbox's status
  // map, not by the registry. The status node stays listed so the inbox's
  // hard SessionStatus requirement remains explicit in this wiring.
  SessionStatus.node,
  Dag.node,
])

export * as Session from "./session"
