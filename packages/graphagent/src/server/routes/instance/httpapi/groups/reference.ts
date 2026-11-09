// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Reference } from "@graphagent/core/reference"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const ReferencePaths = {
  list: "/reference",
} as const

export const ReferenceApi = HttpApi.make("reference").add(
  HttpApiGroup.make("reference")
    .add(
      HttpApiEndpoint.get("list", ReferencePaths.list, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(Reference.Info), "References"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "reference.list",
          summary: "List references",
          description: "List references available in the current project.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "reference", description: "Project reference routes." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware),
)
