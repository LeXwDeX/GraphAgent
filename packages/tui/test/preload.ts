// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Preload of every `bun test` run in this package: the test process gets a home
 * and data directories of its own.
 *
 * `@graphagent/core/global` fixes `Global.Path.*` from the XDG variables the
 * first time it is imported, and creates those directories on the spot. That
 * covers the log directory `TuiLog` appends to, and the state, config and cache
 * directories. Without this file a test that reaches an error path, or merely
 * imports the data layer, writes into the real directories of an installed
 * GraphAgent. The variables are therefore set here, ahead of every test file
 * and every `src/` module, the way `packages/core/test/preload.ts` does, and
 * the directory is removed when the run ends. `test/util/log.test.ts` guards
 * the result.
 *
 * The layout is that of a real home (`.local/share`, `.config`, ...), under one
 * temporary directory that `GRAPHAGENT_TEST_HOME` names. Only `[test]` in
 * `bunfig.toml` lists this file: `bun run` and the benchmark keep the user's
 * own directories.
 */

import { afterAll } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = await fsp.mkdtemp(path.join(os.tmpdir(), "graphagent-tui-test-"))

process.env.GRAPHAGENT_TEST_HOME = home
process.env.XDG_DATA_HOME = path.join(home, ".local", "share")
process.env.XDG_STATE_HOME = path.join(home, ".local", "state")
process.env.XDG_CACHE_HOME = path.join(home, ".cache")
process.env.XDG_CONFIG_HOME = path.join(home, ".config")
// Wins over a config directory the developer's own environment names, without the
// explicit-config-path behavior `GRAPHAGENT_CONFIG_DIR` brings (see `Global.Path.config`).
process.env.GRAPHAGENT_TEST_CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME, "graphagent")

// Runs once, after the last test file. A run that is killed skips it, like the preloads of the other packages.
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))
