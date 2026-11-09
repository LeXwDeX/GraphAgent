// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as MemoryHome from "./home"

import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Global } from "@graphagent/core/global"
import { ProjectV2 } from "@graphagent/core/project"
import { Hash } from "@graphagent/core/util/hash"
import { Context, Layer } from "effect"
import { join } from "node:path"

export interface Interface {
  readonly directory: (projectID: ProjectV2.ID) => string
  readonly topics: (projectID: ProjectV2.ID) => string
  readonly manifest: (projectID: ProjectV2.ID) => string
  readonly generations: (projectID: ProjectV2.ID) => string
  readonly locks: string
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/MemoryHome") {}

export function make(dataRoot: string): Interface {
  const directory = (projectID: ProjectV2.ID) =>
    join(dataRoot, "memory", "projects", Hash.sha256(`memory-project:${projectID}`))
  return Service.of({
    directory,
    topics: (projectID) => join(directory(projectID), "topics"),
    manifest: (projectID) => join(directory(projectID), "manifest.json"),
    generations: (projectID) => join(directory(projectID), "generations"),
    locks: join(dataRoot, "memory", "locks"),
  })
}

export const layer = Layer.succeed(Service, make(Global.Path.data))

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])
