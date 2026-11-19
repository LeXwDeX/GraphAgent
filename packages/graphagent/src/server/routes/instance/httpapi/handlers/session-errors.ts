import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import type { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { Cause, Effect } from "effect"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

export function mapBusy<A, R>(self: Effect.Effect<A, Session.BusyError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          name: "SessionBusyError",
          data: {
            sessionID: error.sessionID,
            message: `Session is busy: ${error.sessionID}`,
          },
        }),
      ),
    ),
  )
}

/**
 * The prompt service raises a model the catalog does not have as a defect, since a turn cannot start without it. The
 * request names that model, or the session still does, so the handler answers with the declared
 * `ProviderModelNotFoundError` (#1557). Every other cause, and one that was also interrupted, goes on unchanged.
 */
export function mapModelNotFound<A, E, R>(self: Effect.Effect<A, E, R>) {
  return self.pipe(
    Effect.catchCause((cause): Effect.Effect<never, E | ApiError.ProviderModelNotFoundError> => {
      if (!Cause.hasInterrupts(cause))
        for (const reason of cause.reasons)
          if (Cause.isDieReason(reason) && Provider.ModelNotFoundError.isInstance(reason.defect))
            return Effect.fail(ApiError.modelNotFound(reason.defect))
      return Effect.failCause(cause)
    }),
  )
}
