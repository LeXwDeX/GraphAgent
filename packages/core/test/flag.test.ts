// brand-guard: legacy-name-negative-test
import { describe, expect, test } from "bun:test"
import path from "path"
import { Flag } from "../src/flag/flag"

const REPO = path.resolve(import.meta.dir, "../../..")
const ENTRY = path.join(REPO, "packages/core/src/flag/flag.ts")

function isolatedEnv(overrides: Record<string, string>) {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.GRAPHAGENT_CONFIG
  delete env.GRAPHAGENT_CONFIG_DIR
  delete env.GRAPHAGENT_DB
  delete env.OPENCODE_CONFIG
  delete env.OPENCODE_CONFIG_DIR
  delete env.OPENCODE_DB
  return { ...env, ...overrides }
}

async function readFlagValues(overrides: Record<string, string>) {
  const script = `
    const { Flag } = await import(${JSON.stringify(ENTRY)})
    console.log(JSON.stringify({
      config: Flag.GRAPHAGENT_CONFIG ?? null,
      configDir: Flag.GRAPHAGENT_CONFIG_DIR ?? null,
      db: Flag.GRAPHAGENT_DB ?? null,
    }))
  `
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", script],
    cwd: REPO,
    env: isolatedEnv(overrides),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ stderr, code }).toEqual({ stderr: "", code: 0 })
  return JSON.parse(stdout.trim())
}

describe("Flag", () => {
  test("every key uses the GraphAgent or OTEL namespace", () => {
    const keys = Object.keys(Flag)
    expect(keys.length).toBeGreaterThan(30)
    for (const key of keys) expect({ key, ok: key.startsWith("GRAPHAGENT_") || key.startsWith("OTEL_") }).toEqual({
      key,
      ok: true,
    })
  })

  test("does not read the legacy OPENCODE_ variables", async () => {
    expect(
      await readFlagValues({
        OPENCODE_CONFIG: "/tmp/legacy-config.json",
        OPENCODE_CONFIG_DIR: "/tmp/legacy-config-dir",
        OPENCODE_DB: "/tmp/legacy.db",
      }),
    ).toEqual({ config: null, configDir: null, db: null })
  })

  test("reads the renamed GRAPHAGENT_ variables", async () => {
    expect(
      await readFlagValues({
        GRAPHAGENT_CONFIG: "/tmp/config.json",
        GRAPHAGENT_CONFIG_DIR: "/tmp/config-dir",
        GRAPHAGENT_DB: "/tmp/graphagent.db",
      }),
    ).toEqual({ config: "/tmp/config.json", configDir: "/tmp/config-dir", db: "/tmp/graphagent.db" })
  })
})
