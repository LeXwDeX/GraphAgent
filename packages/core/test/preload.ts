import path from "path"
import os from "os"
import fs from "fs/promises"
import { afterAll } from "bun:test"

// Set these before any source imports: xdg-basedir captures its paths at load
// time, and cache/log tests must never mutate an installed user's files.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-test-data-"))
process.env.XDG_DATA_HOME = path.join(directory, "share")
process.env.XDG_CACHE_HOME = path.join(directory, "cache")
process.env.XDG_CONFIG_HOME = path.join(directory, "config")
process.env.XDG_STATE_HOME = path.join(directory, "state")
process.env.GRAPHAGENT_CONFIG_DIR = path.join(directory, "config", "opencode")
process.env.GRAPHAGENT_TEST_HOME = path.join(directory, "home")
process.env.GRAPHAGENT_TEST_MANAGED_CONFIG_DIR = path.join(directory, "managed")
delete process.env.GRAPHAGENT_CONFIG
delete process.env.GRAPHAGENT_CONFIG_CONTENT
await fs.mkdir(process.env.GRAPHAGENT_TEST_HOME, { recursive: true })

afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

process.env.GRAPHAGENT_DB = ":memory:"
process.env.GRAPHAGENT_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.GRAPHAGENT_DISABLE_MODELS_FETCH = "true"
