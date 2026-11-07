import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Layer } from "effect"
import { layer as locationLayer } from "./location"
import { ModelHandler } from "./handlers/model"
import { ProviderHandler } from "./handlers/provider"
import { FileSystemHandler } from "./handlers/fs"
import { CommandHandler } from "./handlers/command"
import { SkillHandler } from "./handlers/skill"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { HealthHandler } from "./handlers/health"
import { ReferenceHandler } from "./handlers/reference"
import { LocationHandler } from "./handlers/location"
import { IntegrationHandler } from "./handlers/integration"
import { CredentialHandler } from "./handlers/credential"
import { Credential } from "@opencode-ai/core/credential"
import { ProjectCopyHandler } from "./handlers/project-copy"

export const handlers = Layer.mergeAll(
  HealthHandler,
  LocationHandler,
  AgentHandler,
  ModelHandler,
  ProviderHandler,
  IntegrationHandler,
  CredentialHandler,
  FileSystemHandler,
  CommandHandler,
  SkillHandler,
  EventHandler,
  ReferenceHandler,
  ProjectCopyHandler,
).pipe(
  Layer.provide(locationLayer),
  Layer.provide(LocationServiceMap.layer),
  Layer.provide(Credential.defaultLayer),
)
