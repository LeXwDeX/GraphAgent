import type { PluginOptions } from "./options"
import type { AgentHooks } from "./agent"
import type { AISDKHooks } from "./aisdk"
import type { CatalogHooks } from "./catalog"
import type { CommandHooks } from "./command"
import type { IntegrationHooks } from "./integration"
import type { ReferenceHooks } from "./reference"
import type { SkillHooks } from "./skill"
import type { Reload } from "./registration"

export interface PluginContext {
  readonly options: PluginOptions
  readonly agent: AgentHooks & Reload
  readonly aisdk: AISDKHooks
  readonly catalog: CatalogHooks & Reload
  readonly command: CommandHooks & Reload
  readonly integration: IntegrationHooks & Reload
  readonly reference: ReferenceHooks & Reload
  readonly skill: SkillHooks & Reload
}
