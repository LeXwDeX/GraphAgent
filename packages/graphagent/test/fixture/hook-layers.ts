// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"

/** Contents of the three hooks files; a layer left undefined writes no file. */
export interface HookLayerFiles {
  readonly global?: object
  readonly project?: object
  readonly local?: object
}

/**
 * Point the global hooks layer at a temporary directory until the scope closes,
 * so a test never reads or writes the shared test configuration directory.
 */
export const isolatedGlobalConfig = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-layers-global-"))
    const previous = process.env.GRAPHAGENT_TEST_CONFIG_DIR
    process.env.GRAPHAGENT_TEST_CONFIG_DIR = dir
    return { dir, previous }
  }),
  ({ dir, previous }) =>
    Effect.promise(async () => {
      if (previous === undefined) delete process.env.GRAPHAGENT_TEST_CONFIG_DIR
      else process.env.GRAPHAGENT_TEST_CONFIG_DIR = previous
      await fs.rm(dir, { recursive: true, force: true })
    }),
)

/**
 * Write the global `hooks.json`, the project `<root>/.agents/hooks.json` and the
 * local `<root>/.agents/hooks.local.json`. Call before the engine first reads
 * its chain: the state loads lazily on first use.
 */
export const writeHookLayers = (root: string, globalDir: string, files: HookLayerFiles) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(root, ".agents"), { recursive: true })
    const targets: [object | undefined, string][] = [
      [files.global, path.join(globalDir, "hooks.json")],
      [files.project, path.join(root, ".agents", "hooks.json")],
      [files.local, path.join(root, ".agents", "hooks.local.json")],
    ]
    for (const [value, file] of targets) if (value !== undefined) await fs.writeFile(file, JSON.stringify(value))
  })
