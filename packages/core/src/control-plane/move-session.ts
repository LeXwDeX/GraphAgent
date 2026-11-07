export * as MoveSession from "./move-session"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { EventV2 } from "../event"
import { Git } from "../git"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { SessionEvent } from "../session/event"
import { SessionCwdHooks } from "../session/cwd-hooks"
import { SessionSchema } from "../session/schema"
import { WorkspaceV2 } from "../workspace"
import { AbsolutePath, RelativePath } from "../schema"
import path from "path"

export const Destination = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "MoveSession.Destination" })
export type Destination = typeof Destination.Type

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  destination: Destination,
  moveChanges: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MoveSession.Input" })
export type Input = typeof Input.Type

/** The session fields MoveSession reads; the host supplies them from its session store. */
export interface SessionTarget {
  readonly directory: AbsolutePath
  readonly workspaceID?: WorkspaceV2.ID
  readonly projectID: ProjectV2.ID
}

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "MoveSession.SessionNotFoundError",
  {
    sessionID: SessionSchema.ID,
  },
) {}

export interface SessionLookupInterface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionTarget, SessionNotFoundError>
}

export class SessionLookup extends Context.Service<SessionLookup, SessionLookupInterface>()(
  "@graphagent/ControlPlaneSessionLookup",
) {}

export class DestinationProjectMismatchError extends Schema.TaggedError<DestinationProjectMismatchError>()(
  "MoveSession.DestinationProjectMismatchError",
  {
    expected: ProjectV2.ID,
    actual: ProjectV2.ID,
  },
) {}

export class ApplyChangesError extends Schema.TaggedError<ApplyChangesError>()("MoveSession.ApplyChangesError", {
  message: Schema.String,
}) {}

export class CaptureChangesError extends Schema.TaggedError<CaptureChangesError>()(
  "MoveSession.CaptureChangesError",
  {
    message: Schema.String,
  },
) {}

export class ResetSourceChangesError extends Schema.TaggedError<ResetSourceChangesError>()(
  "MoveSession.ResetSourceChangesError",
  {
    directory: AbsolutePath,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type Error =
  | SessionNotFoundError
  | DestinationProjectMismatchError
  | CaptureChangesError
  | ApplyChangesError
  | ResetSourceChangesError

export interface Interface {
  readonly moveSession: (input: Input) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/ControlPlaneMoveSession") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const events = yield* EventV2.Service
    const project = yield* ProjectV2.Service
    const lookup = yield* SessionLookup

    const moveSession = Effect.fn("MoveSession.moveSession")(function* (input: Input) {
      const current = yield* lookup.get(input.sessionID)
      const directory = AbsolutePath.make(input.destination.directory)
      if (current.directory === directory) return

      const source = yield* project.resolve(current.directory)
      const destination = yield* project.resolve(directory)
      if (current.projectID !== destination.id) {
        return yield* new DestinationProjectMismatchError({ expected: current.projectID, actual: destination.id })
      }

      const moveChanges = input.moveChanges && source.directory !== destination.directory
      const sourceRepository = moveChanges ? yield* git.repo.discover(current.directory) : undefined
      if (moveChanges && !sourceRepository)
        return yield* new CaptureChangesError({ message: "Source is not a Git repository" })
      const patch = sourceRepository
        ? yield* git.change
            .capture({ repository: sourceRepository, path: current.directory })
            .pipe(Effect.mapError((error) => new CaptureChangesError({ message: error.message })))
        : Git.ChangeSet.make("")
      if (patch) {
        const repository = yield* git.repo.discover(directory)
        if (!repository) return yield* new ApplyChangesError({ message: "Destination is not a Git repository" })
        yield* git.change
          .apply({ repository, path: directory, changes: patch })
          .pipe(Effect.mapError((error) => new ApplyChangesError({ message: error.message })))
      }

      yield* events.publish(SessionEvent.Moved, {
        sessionID: input.sessionID,
        location: Location.Ref.make({ directory }),
        subdirectory: RelativePath.make(path.relative(destination.directory, directory).replaceAll("\\", "/")),
        timestamp: yield* DateTime.now,
      })

      yield* SessionCwdHooks.changed({
        sessionID: input.sessionID,
        previousDirectory: current.directory,
        directory,
      })

      if (patch) {
        const repository = yield* git.repo.discover(current.directory)
        if (!repository)
          return yield* new ResetSourceChangesError({
            directory: current.directory,
            message: "Source is not a Git repository",
          })
        yield* git.change
          .discard({
            repository,
            path: current.directory,
            index: "preserve",
            untracked: "remove",
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ResetSourceChangesError({
                  directory: current.directory,
                  message: error.message,
                  cause: error.cause,
                }),
            ),
          )
      }
    })

    return Service.of({ moveSession })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
)
