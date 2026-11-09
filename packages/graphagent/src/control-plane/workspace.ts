import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { serviceUse } from "@graphagent/core/effect/service-use"
import { Database } from "@graphagent/core/database/database"
import { eq } from "drizzle-orm"
import { Project } from "@/project/project"
import { GlobalBus } from "@/bus/global"
import { Auth } from "@/auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FSUtil } from "@graphagent/core/fs-util"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProjectV2 } from "@graphagent/core/project"
import { Slug } from "@graphagent/core/util/slug"
import { WorkspaceTable } from "@graphagent/core/control-plane/workspace.sql"
import { getAdapter, registeredAdapters } from "./adapters"
import { type WorkspaceInfo, WorkspaceInfo as WorkspaceInfoSchema } from "./types"
import { WorkspaceV2 } from "@graphagent/core/workspace"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionTable } from "@graphagent/core/session/sql"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { errorData } from "@/util/error"
import { waitEvent } from "./util"
import { Vcs } from "@/project/vcs"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { WorkspaceAdapterRuntime } from "./workspace-adapter-runtime"
import { WorkspaceEvent } from "@graphagent/schema/workspace-event"

/** How long `create` waits for the adapter to report connected/error. */
const CREATE_STATUS_TIMEOUT = 5000

export const Info = Schema.Struct({
  ...WorkspaceInfoSchema.fields,
  timeUsed: Schema.Number,
}).annotate({ identifier: "Workspace" })
export type Info = WorkspaceInfo & { timeUsed: number }

export const ConnectionStatus = WorkspaceEvent.ConnectionStatus
export type ConnectionStatus = WorkspaceEvent.ConnectionStatus

export const Event = WorkspaceEvent

function fromRow(row: typeof WorkspaceTable.$inferSelect): Info {
  return {
    id: row.id,
    type: row.type,
    branch: row.branch,
    name: row.name,
    directory: row.directory,
    extra: row.extra,
    projectID: row.project_id,
    timeUsed: row.time_used,
  }
}

export const CreateInput = Schema.Struct({
  id: Schema.optional(WorkspaceV2.ID),
  type: Info.fields.type,
  branch: Info.fields.branch,
  projectID: ProjectV2.ID,
  extra: Schema.optional(Info.fields.extra),
})
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const SessionWarpInput = Schema.Struct({
  workspaceID: Schema.NullOr(WorkspaceV2.ID),
  sessionID: SessionID,
  copyChanges: Schema.optional(Schema.Boolean),
})
export type SessionWarpInput = Schema.Schema.Type<typeof SessionWarpInput>

export class WorkspaceNotFoundError extends Schema.TaggedError<WorkspaceNotFoundError>()(
  "WorkspaceNotFoundError",
  {
    message: Schema.String,
    workspaceID: WorkspaceV2.ID,
  },
) {}

type CreateError = Auth.AuthError
type SessionWarpError = WorkspaceNotFoundError | Vcs.PatchApplyError

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, CreateError>
  readonly sessionWarp: (input: SessionWarpInput) => Effect.Effect<void, SessionWarpError>
  readonly list: (project: Project.Info) => Effect.Effect<Info[]>
  readonly syncList: (project: Project.Info) => Effect.Effect<void>
  readonly get: (id: WorkspaceV2.ID) => Effect.Effect<Info | undefined>
  readonly remove: (id: WorkspaceV2.ID) => Effect.Effect<Info | undefined>
  readonly status: () => Effect.Effect<ConnectionStatus[]>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/Workspace") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const session = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const events = yield* EventV2Bridge.Service
    const vcs = yield* Vcs.Service
    const flags = yield* RuntimeFlags.Service
    const fs = yield* FSUtil.Service
    const { db } = yield* Database.Service
    const connections = new Map<WorkspaceV2.ID, ConnectionStatus>()

    const setStatus = (id: WorkspaceV2.ID, status: ConnectionStatus["status"]) => {
      const prev = connections.get(id)
      if (prev?.status === status) return
      const next = { workspaceID: id, status }
      connections.set(id, next)

      GlobalBus.emit("event", {
        directory: "global",
        workspace: id,
        payload: {
          type: Event.Status.type,
          properties: next,
        },
      })
    }

    const runInWorkspace = <A, E, R>(input: {
      workspaceID?: WorkspaceV2.ID
      local: () => Effect.Effect<A, E, R>
      fallback: A
    }) =>
      Effect.gen(function* () {
        if (!input.workspaceID) return yield* input.local()

        const workspace = yield* get(input.workspaceID)
        if (!workspace) return input.fallback

        const target = yield* WorkspaceAdapterRuntime.target(workspace)
        const store = yield* InstanceStore.Service
        return yield* store.provide({ directory: target.directory }, input.local())
      })

    const startSync = Effect.fn("Workspace.startSync")(function* (space: Info) {
      if (!flags.experimentalWorkspaces) return

      const target = yield* WorkspaceAdapterRuntime.target(space).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            setStatus(space.id, "error")
            yield* Effect.logWarning("workspace target failed", {
              workspaceID: space.id,
              error: errorData(error),
            })
            return null
          }),
        ),
      )
      if (!target) return

      setStatus(space.id, (yield* fs.existsSafe(target.directory)) ? "connected" : "error")
    })

    const stopSync = Effect.fn("Workspace.stopSync")(function* (id: WorkspaceV2.ID) {
      connections.delete(id)
    })

    const create = Effect.fn("Workspace.create")(function* (input: CreateInput) {
      const id = WorkspaceV2.ID.ascending(input.id)
      const adapter = getAdapter(input.projectID, input.type)
      const config = yield* WorkspaceAdapterRuntime.configure(adapter, {
        ...input,
        id,
        name: Slug.create(),
        directory: null,
        extra: input.extra ?? null,
      })

      const info: Info = {
        id,
        type: config.type,
        branch: config.branch ?? null,
        name: config.name ?? null,
        directory: config.directory ?? null,
        extra: config.extra ?? null,
        projectID: input.projectID,
        timeUsed: Date.now(),
      }

      yield* db
        .insert(WorkspaceTable)
        .values({
          id: info.id,
          type: info.type,
          branch: info.branch,
          name: info.name,
          directory: info.directory,
          extra: info.extra,
          project_id: info.projectID,
          time_used: info.timeUsed,
        })
        .run()
        .pipe(Effect.orDie)

      const env = {
        GRAPHAGENT_AUTH_CONTENT: JSON.stringify(yield* auth.all()),
        OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
        OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES,
      }

      yield* WorkspaceAdapterRuntime.create(adapter, config, env)
      yield* Effect.all(
        [
          waitEvent({
            timeout: CREATE_STATUS_TIMEOUT,
            fn(event) {
              if (event.workspace === info.id && event.payload.type === Event.Status.type) {
                const { status } = event.payload.properties
                return status === "error" || status === "connected"
              }
              return false
            },
          }),
          startSync(info),
        ],
        { concurrency: 2, discard: true },
      )

      return info
    })

    const sessionWarp = Effect.fn("Workspace.sessionWarp")(function* (input: SessionWarpInput) {
      return yield* Effect.gen(function* () {
        const current = yield* db
          .select({ workspaceID: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)

        if (current?.workspaceID) {
          const previous = yield* get(current.workspaceID)
          if (previous) {
            yield* prompt.cancel(input.sessionID)

            // "claim" this session so any future events coming from
            // the old workspace are ignored
            yield* events.claim(input.sessionID, input.workspaceID ?? previous.projectID)
          }
        }

        const sourcePatch =
          input.copyChanges && current?.workspaceID
            ? yield* runInWorkspace({
                workspaceID: current?.workspaceID ?? undefined,
                local: () => vcs.diffRaw(),
                fallback: "",
              }).pipe(Effect.provide(InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer))))
            : ""

        if (sourcePatch) {
          // Attempt to apply the file changes to the new workspace.
          // We intentionally do first so if it fails we don't warp
          // the session.
          yield* runInWorkspace({
            workspaceID: input.workspaceID ?? undefined,
            local: () => vcs.apply({ patch: sourcePatch }),
            fallback: { applied: false },
          }).pipe(Effect.provide(InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer))))
        }

        if (input.workspaceID === null) {
          yield* session.setWorkspace({ sessionID: input.sessionID, workspaceID: undefined })

          return
        }

        const workspaceID = input.workspaceID
        const space = yield* get(workspaceID)
        if (!space)
          return yield* new WorkspaceNotFoundError({
            message: `Workspace not found: ${workspaceID}`,
            workspaceID,
          })

        yield* session.setWorkspace({ sessionID: input.sessionID, workspaceID: input.workspaceID })
      })
    })

    const list = Effect.fn("Workspace.list")(function* (project: Project.Info) {
      return (yield* db
        .select()
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.project_id, project.id))
        .all()
        .pipe(Effect.orDie))
        .map(fromRow)
        .sort((a, b) => a.id.localeCompare(b.id))
    })

    const syncList = Effect.fn("Workspace.syncList")(function* (project: Project.Info) {
      const names = new Set((yield* list(project)).map((workspace) => workspace.name))
      const discovered = yield* Effect.forEach(
        registeredAdapters(project.id),
        ([type, adapter]) =>
          WorkspaceAdapterRuntime.list(adapter).pipe(
            Effect.catchCause((error) =>
              Effect.logWarning("workspace adapter list failed", { type, error }).pipe(Effect.as([])),
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items) => items.flat()))

      yield* Effect.forEach(
        discovered,
        (item) =>
          Effect.gen(function* () {
            if (names.has(item.name)) return
            names.add(item.name)

            const info: Info = {
              id: WorkspaceV2.ID.ascending(),
              type: item.type,
              branch: item.branch,
              name: item.name,
              directory: item.directory,
              extra: item.extra,
              projectID: item.projectID,
              timeUsed: Date.now(),
            }

            yield* db
              .insert(WorkspaceTable)
              .values({
                id: info.id,
                type: info.type,
                branch: info.branch,
                name: info.name,
                directory: info.directory,
                extra: info.extra,
                project_id: info.projectID,
                time_used: info.timeUsed,
              })
              .run()
              .pipe(Effect.orDie)

            yield* startSync(info)
          }),
        { concurrency: 1 },
      )
    })

    const get = Effect.fn("Workspace.get")(function* (id: WorkspaceV2.ID) {
      const row = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return
      return fromRow(row)
    })

    const remove = Effect.fn("Workspace.remove")(function* (id: WorkspaceV2.ID) {
      const sessions = yield* db
        .select({ id: SessionTable.id, parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.workspace_id, id))
        .all()
        .pipe(Effect.orDie)
      const sessionIDs = new Set(sessions.map((sessionInfo) => sessionInfo.id))
      yield* Effect.forEach(
        sessions.filter((sessionInfo) => !sessionInfo.parentID || !sessionIDs.has(sessionInfo.parentID)),
        (sessionInfo) =>
          session.remove(sessionInfo.id).pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.void)),
        { discard: true },
      )

      const row = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return

      yield* stopSync(id)

      const info = fromRow(row)
      yield* Effect.catchCause(
        Effect.gen(function* () {
          yield* WorkspaceAdapterRuntime.remove(info)
        }),
        () => Effect.logError("adapter not available when removing workspace", { type: row.type }),
      )

      yield* db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, id)).run().pipe(Effect.orDie)
      return info
    })

    const status = Effect.fn("Workspace.status")(function* () {
      return [...connections.values()]
    })

    return Service.of({
      create,
      sessionWarp,
      list,
      syncList,
      get,
      remove,
      status,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.provide(Vcs.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export const node = LayerNode.make(layer, [
  Auth.node,
  Session.node,
  SessionPrompt.node,
  EventV2Bridge.node,
  Vcs.node,
  RuntimeFlags.node,
  FSUtil.node,
  Database.node,
])

export * as Workspace from "./workspace"
