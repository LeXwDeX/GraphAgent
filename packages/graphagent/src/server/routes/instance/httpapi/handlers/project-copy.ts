// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import * as InstanceState from "@/effect/instance-state"
import { ProjectCopy as ProjectCopyName } from "@/project/copy"
import { Git } from "@graphagent/core/git"
import { Location } from "@graphagent/core/location"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { ProjectCopy } from "@graphagent/core/project/copy"
import { AbsolutePath } from "@graphagent/core/schema"
import { Slug } from "@graphagent/core/util/slug"
import { Effect, Layer } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { InstanceHttpApi } from "../api"
import { ProjectCopyError } from "../errors"

export const projectCopyHandlers = HttpApiBuilder.group(InstanceHttpApi, "projectCopyName", (handlers) =>
  Effect.gen(function* () {
    const copy = yield* ProjectCopyName.Service
    const locations = yield* LocationServiceMap

    const withLocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const directory = AbsolutePath.make((yield* InstanceState.context).directory)
        return yield* effect.pipe(Effect.provide(locations.get(Location.Ref.make({ directory }))))
      })

    return handlers
      .handle("generateName", (ctx) =>
        copy.generateName(ctx.payload.context).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("project copy name generation failed", {
              projectID: ctx.params.projectID,
              cause,
            }).pipe(Effect.as(Slug.create())),
          ),
          Effect.map((name) => ({ name })),
        ),
      )
      .handle("create", (ctx) =>
        withLocation(
          Effect.gen(function* () {
            const copies = yield* ProjectCopy.Service
            const location = yield* Location.Service
            return yield* badRequest(
              copies.create({
                ...ctx.payload,
                projectID: ctx.params.projectID,
                sourceDirectory: location.project.directory,
              }),
            )
          }),
        ),
      )
      .handle("remove", (ctx) =>
        withLocation(
          ProjectCopy.Service.use((copies) =>
            badRequest(copies.remove({ ...ctx.payload, projectID: ctx.params.projectID })).pipe(
              Effect.as(HttpApiSchema.NoContent.make()),
            ),
          ),
        ),
      )
      .handle("refresh", (ctx) =>
        withLocation(
          ProjectCopy.Service.use((copies) =>
            badRequest(copies.refresh({ projectID: ctx.params.projectID })).pipe(
              Effect.as(HttpApiSchema.NoContent.make()),
            ),
          ),
        ),
      )
  }),
).pipe(Layer.provide(LocationServiceMap.layer))

function badRequest<A, R>(effect: Effect.Effect<A, ProjectCopy.Error, R>) {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new ProjectCopyError({
          name: "ProjectCopyError",
          data: {
            message: message(error),
            forceRequired: error instanceof Git.WorktreeError ? error.forceRequired : undefined,
          },
        }),
    ),
  )
}

function message(error: ProjectCopy.Error) {
  if (error instanceof ProjectCopy.SourceDirectoryNotFoundError)
    return `Project copy source not found: ${error.directory}`
  if (error instanceof ProjectCopy.DestinationExistsError)
    return `Project copy destination already exists: ${error.directory}`
  if (error instanceof ProjectCopy.DirectoryUnavailableError)
    return `Project copy directory unavailable: ${error.directory}`
  if (error instanceof ProjectCopy.InvalidDirectoryError) return `Invalid project copy directory: ${error.directory}`
  if (error instanceof ProjectCopy.StrategyUnavailableError)
    return `Project copy strategy unavailable: ${error.strategy}`
  return error.message
}
