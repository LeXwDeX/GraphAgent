import { ProjectCopy } from "@graphagent/core/project/copy"
import { ProjectV2 } from "@graphagent/core/project"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ProjectCopyError } from "../errors"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"

export const GenerateNamePayload = Schema.Struct({
  context: Schema.optional(Schema.String),
})

const root = "/experimental/project/:projectID/copy"
const CreatePayload = Schema.Struct(Struct.omit(ProjectCopy.CreateInput.fields, ["projectID", "sourceDirectory"]))
const RemovePayload = Schema.Struct(Struct.omit(ProjectCopy.RemoveInput.fields, ["projectID"]))

export const ProjectCopyApi = HttpApi.make("projectCopyName").add(
  HttpApiGroup.make("projectCopyName")
    .add(
      HttpApiEndpoint.post("generateName", `${root}/generate-name`, {
        params: { projectID: ProjectV2.ID },
        query: WorkspaceRoutingQuery,
        payload: GenerateNamePayload,
        success: Schema.Struct({ name: Schema.String }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.projectCopy.generateName",
          summary: "Generate project copy name",
          description: "Generate a short name for a project copy from task context.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("create", root, {
        params: { projectID: ProjectV2.ID },
        payload: CreatePayload,
        success: ProjectCopy.Copy,
        error: ProjectCopyError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.projectCopy.create",
          summary: "Create project copy",
          description: "Create a project copy at the requested directory.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("remove", root, {
        params: { projectID: ProjectV2.ID },
        payload: RemovePayload,
        success: HttpApiSchema.NoContent,
        error: ProjectCopyError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.projectCopy.remove",
          summary: "Remove project copy",
          description: "Remove a project copy from the requested directory.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("refresh", `${root}/refresh`, {
        params: { projectID: ProjectV2.ID },
        query: WorkspaceRoutingQuery,
        success: HttpApiSchema.NoContent,
        error: ProjectCopyError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.projectCopy.refresh",
          summary: "Refresh project copies",
          description: "Refresh the project copy registry for the current project.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "projectCopy", description: "Project copy routes." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware),
)
