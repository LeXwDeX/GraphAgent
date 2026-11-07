import { Credential } from "@graphagent/core/credential"
import { EventV2 } from "@graphagent/core/event"
import { FileSystem } from "@graphagent/core/filesystem"
import { FSUtil } from "@graphagent/core/fs-util"
import { Global } from "@graphagent/core/global"
import { Npm } from "@graphagent/core/npm"
import { PluginV2 } from "@graphagent/core/plugin"
import { RepositoryCache } from "@graphagent/core/repository-cache"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { SkillDiscovery } from "@graphagent/core/skill/discovery"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { tempLocationLayer } from "../fixture/location"

export const PluginTestLayer = Layer.mergeAll(FileSystem.locationLayer, PluginV2.locationLayer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Credential.defaultLayer,
      EventV2.defaultLayer,
      FetchHttpClient.layer,
      FSUtil.defaultLayer,
      Global.defaultLayer,
      Layer.succeed(
        Npm.Service,
        Npm.Service.of({
          add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
          install: () => Effect.void,
          which: () => Effect.succeed(undefined),
        }),
      ),
      RepositoryCache.defaultLayer,
      SkillDiscovery.defaultLayer,
      Ripgrep.defaultLayer,
      tempLocationLayer,
    ),
  ),
)
