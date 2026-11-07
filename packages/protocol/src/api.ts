import { Context } from "effect"
import { HttpApi, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/http-api"
import { SchemaErrorMiddleware } from "./middleware/schema-error"
import { ModelGroup } from "./groups/model"
import { ProviderGroup } from "./groups/provider"
import { makePermissionGroup } from "./groups/permission"
import { FileSystemGroup } from "./groups/fs"
import { CommandGroup } from "./groups/command"
import { SkillGroup } from "./groups/skill"
import { EventGroup, makeEventGroup } from "./groups/event"
import type { Definition } from "@opencode-ai/schema/event"
import { AgentGroup } from "./groups/agent"
import { HealthGroup } from "./groups/health"
import { ReferenceGroup } from "./groups/reference"
import { Authorization } from "./middleware/authorization"
import { LocationGroup } from "./groups/location"
import { IntegrationGroup } from "./groups/integration"
import { CredentialGroup } from "./groups/credential"
import { ProjectCopyGroup } from "./groups/project-copy"

// Protocol owns middleware placement, while Server injects concrete keys so Core service identities stay downstream.
const makeApiFromGroup = <
  const Group extends HttpApiGroup.Constraint,
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
>(
  eventGroup: Group,
  locationMiddleware: Context.Key<LocationId, LocationService>,
) =>
  HttpApi.make("server")
    .add(HealthGroup)
    .add(LocationGroup.middleware(locationMiddleware))
    .add(AgentGroup.middleware(locationMiddleware))
    .add(ModelGroup.middleware(locationMiddleware))
    .add(ProviderGroup.middleware(locationMiddleware))
    .add(IntegrationGroup.middleware(locationMiddleware))
    .add(CredentialGroup.middleware(locationMiddleware))
    .add(makePermissionGroup(locationMiddleware))
    .add(FileSystemGroup.middleware(locationMiddleware))
    .add(CommandGroup.middleware(locationMiddleware))
    .add(SkillGroup.middleware(locationMiddleware))
    .add(eventGroup)
    .add(ReferenceGroup.middleware(locationMiddleware))
    .add(ProjectCopyGroup.middleware(locationMiddleware))
    .annotateMerge(
      OpenApi.annotations({
        title: "opencode HttpApi",
        version: "0.0.1",
        description: "Experimental HttpApi surface for selected instance routes.",
      }),
    )
    .middleware(Authorization)
    .middleware(SchemaErrorMiddleware)

export const makeApi = <LocationId extends HttpApiMiddleware.AnyId, LocationService>(options: {
  readonly definitions: ReadonlyArray<Definition>
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
}) => makeApiFromGroup(makeEventGroup(options.definitions), options.locationMiddleware)

export const makeDefaultApi = <LocationId extends HttpApiMiddleware.AnyId, LocationService>(options: {
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
}) => makeApiFromGroup(EventGroup, options.locationMiddleware)
