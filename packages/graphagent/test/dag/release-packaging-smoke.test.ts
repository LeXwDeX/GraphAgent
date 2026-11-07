import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import fs from "node:fs/promises"
import path from "node:path"
import { DagValidation } from "@/dag/validation"
import { WorkflowAuthoring } from "@/dag/authoring"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Release packaging smoke test (change repair-workflow-authoring-validation,
// §6.4): the package-templates job's contract is validate-before-copy, fail
// closed. This simulates the job locally: run the runtime validator CLI,
// package only when it passes, then prove the archive holds exactly the
// validated YAML, compatibility manifest, and required provenance/license
// files, and that all three commit identifiers are recorded.

const it = testEffect(CrossSpawnSpawner.defaultLayer)

const pkgRoot = path.resolve(import.meta.dir, "..", "..")

const VALID_TEMPLATE_A = `config:
  name: route-a
  objective: Ship the bounded change
  blocks:
    - id: plan
      kind: plan
`

const VALID_TEMPLATE_B = `config:
  name: route-b
  nodes:
    - id: work
      name: work
      worker_type: build
      depends_on: []
      prompt_template:
        inline: Do the work.
`

const INVALID_TEMPLATE = `config:
  name: route-broken
  objective: Ship
  blocks:
    - id: proto
      kind: prototype
    - id: review
      kind: review
      depends_on: [proto]
`

function runValidator(configDir: string) {
  const result = Bun.spawnSync({
    cmd: ["bun", path.join("script", "validate-dag-templates.ts"), configDir],
    cwd: pkgRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

// The release job and this smoke test run the exact same script, so the
// copy/tar contract cannot drift between CI and the test.
function runPackager(configDir: string, archive: string) {
  const result = Bun.spawnSync({
    cmd: ["bun", path.join("script", "package-dag-templates.ts"), configDir, archive],
    cwd: pkgRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function runCliPackager(distDir: string, archive: string) {
  const result = Bun.spawnSync({
    cmd: ["bun", path.join("script", "package-cli-artifact.ts"), distDir, archive],
    cwd: pkgRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function configRepoScoped(templates: Record<string, string>) {
  return Effect.gen(function* () {
    return yield* tmpdirScoped({
      init: (directory) =>
        Effect.promise(async () => {
          for (const [name, content] of Object.entries(templates)) {
            await fs.writeFile(path.join(directory, name), content)
          }
          // runtime-compat.json travels with the config repo and is read by the CLI.
          await fs.writeFile(
            path.join(directory, "runtime-compat.json"),
            JSON.stringify({ runtime_repo: "LeXwDeX/GraphAgent", runtime_commit: "0".repeat(40) }),
          )
          await fs.mkdir(path.join(directory, "third_party", "mattpocock-skills"), { recursive: true })
          await fs.writeFile(path.join(directory, "THIRD_PARTY_NOTICES.md"), "# Third-party notices\n")
          await fs.writeFile(path.join(directory, "third_party", "mattpocock-skills", "LICENSE"), "MIT License\n")
          await fs.writeFile(
            path.join(directory, "third_party", "mattpocock-skills", "SOURCE.md"),
            "# Source\n",
          )
          for (const command of [
            ["git", "init", "-q"],
            ["git", "config", "user.email", "test@example.com"],
            ["git", "config", "user.name", "Test"],
            ["git", "add", "."],
            ["git", "commit", "-qm", "test templates"],
          ]) {
            const result = Bun.spawnSync({ cmd: command, cwd: directory, stdout: "pipe", stderr: "pipe" })
            if (result.exitCode !== 0) throw new Error(result.stderr.toString())
          }
        }),
    })
  })
}

describe("release packaging smoke test", () => {
  it.effect("packages every license referenced by NOTICE into the real CLI archive", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const dist = path.join(directory, "opencode-test")
      yield* Effect.promise(() => fs.mkdir(path.join(dist, "bin"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(dist, "bin", "opencode"), "test binary"))
      const archive = path.join(directory, "opencode-test.tar.gz")
      const packaged = runCliPackager(dist, archive)
      expect(packaged.exitCode).toBe(0)

      const unpack = path.join(directory, "unpack")
      yield* Effect.promise(() => fs.mkdir(unpack))
      const untar = Bun.spawnSync({ cmd: ["tar", "-xzf", archive, "-C", unpack], stdout: "pipe", stderr: "pipe" })
      expect(untar.exitCode).toBe(0)
      const repoRoot = path.resolve(pkgRoot, "..", "..")
      for (const name of [
        "NOTICE",
        "LICENSE",
        "packages/core/src/dag/LICENSE",
        "packages/graphagent/src/dag/LICENSE",
        "third_party/mattpocock-skills/LICENSE",
        "third_party/mattpocock-skills/SOURCE.md",
      ]) {
        expect(yield* Effect.promise(() => fs.readFile(path.join(unpack, name), "utf-8"))).toBe(
          yield* Effect.promise(() => fs.readFile(path.join(repoRoot, name), "utf-8")),
        )
      }
    }),
  )

  it.effect(
    "packages exactly the validated YAML through the release packager and records all SHAs",
    () =>
      Effect.gen(function* () {
        const configDir = yield* configRepoScoped({
          "route-a.yaml": VALID_TEMPLATE_A,
          "route-b.yml": VALID_TEMPLATE_B,
        })
        const archive = path.join(configDir, "dag-templates.tar.gz")
        const packaged = runPackager(configDir, archive)
        expect(packaged.exitCode).toBe(0)

        const manifest = JSON.parse(packaged.stdout)
        expect(manifest.files).toEqual([
          "THIRD_PARTY_NOTICES.md",
          "route-a.yaml",
          "route-b.yml",
          "runtime-compat.json",
          "third_party/mattpocock-skills/LICENSE",
          "third_party/mattpocock-skills/SOURCE.md",
        ])
        expect(manifest.template_files).toEqual(["route-a.yaml", "route-b.yml"])
        expect(manifest.file_count).toBe(6)
        expect(manifest.template_count).toBe(2)
        // Runtime SHA comes from the releasing runtime checkout; compat SHA
        // from the config repo's pinned runtime commit.
        expect(manifest.runtime_commit).toMatch(/^[0-9a-f]{7,40}$/)
        expect(manifest.compat_runtime_sha).toBe("0".repeat(40))
        expect(manifest.template_commit).toMatch(/^[0-9a-f]{40}$/)

        // Unpack the produced artifact and assert it holds exactly the
        // validated YAML plus compatibility and provenance metadata,
        // byte-identical and usable by the real generation path.
        const unpack = path.join(configDir, "unpack")
        yield* Effect.promise(() => fs.mkdir(unpack))
        const untar = Bun.spawnSync({ cmd: ["tar", "-xzf", archive, "-C", unpack], stdout: "pipe", stderr: "pipe" })
        expect(untar.exitCode).toBe(0)

        const archived = (yield* Effect.promise(() => fs.readdir(unpack)))
          .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
          .sort()
        expect(archived).toEqual(["route-a.yaml", "route-b.yml"])
        expect((yield* Effect.promise(() => fs.readdir(unpack))).sort()).toEqual([
          "THIRD_PARTY_NOTICES.md",
          "route-a.yaml",
          "route-b.yml",
          "runtime-compat.json",
          "third_party",
        ])
        expect(yield* Effect.promise(() => fs.readFile(path.join(unpack, "runtime-compat.json"), "utf-8"))).toBe(
          yield* Effect.promise(() => fs.readFile(path.join(configDir, "runtime-compat.json"), "utf-8")),
        )
        for (const name of archived) {
          const content = yield* Effect.promise(() => fs.readFile(path.join(unpack, name), "utf-8"))
          expect(content).toBe(yield* Effect.promise(() => fs.readFile(path.join(configDir, name), "utf-8")))
          const result = yield* WorkflowAuthoring.make().prepare({
            action: "start",
            source: { kind: "yaml", content, source: name },
            profile: "portable",
          })
          expect(result.valid).toBe(true)
        }
        for (const name of [
          "THIRD_PARTY_NOTICES.md",
          "third_party/mattpocock-skills/LICENSE",
          "third_party/mattpocock-skills/SOURCE.md",
        ]) {
          expect(yield* Effect.promise(() => fs.readFile(path.join(unpack, name), "utf-8"))).toBe(
            yield* Effect.promise(() => fs.readFile(path.join(configDir, name), "utf-8")),
          )
        }

        const modelsSnapshot = path.join(configDir, "models-snapshot.json")
        yield* Effect.promise(() => fs.writeFile(modelsSnapshot, "{}"))
        const generated = Bun.spawnSync({
          cmd: ["bun", path.join("script", "generate.ts")],
          cwd: pkgRoot,
          env: { ...process.env, DAG_TEMPLATES_DIR: unpack, MODELS_DEV_API_JSON: modelsSnapshot },
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(`${generated.stdout.toString()}\n${generated.stderr.toString()}`).not.toContain(
          "runtime compatibility file is missing",
        )
        expect(generated.exitCode).toBe(0)
      }),
    { timeout: 60_000 },
  )

  it.effect(
    "fails closed on duplicate logical names before packaging",
    () =>
      Effect.gen(function* () {
        const configDir = yield* configRepoScoped({
          "duplicate.yaml": VALID_TEMPLATE_A,
          "duplicate.yml": VALID_TEMPLATE_B,
        })
        const archive = path.join(configDir, "dag-templates.tar.gz")
        const packaged = runPackager(configDir, archive)

        expect(packaged.exitCode).toBe(1)
        expect(packaged.stderr).toContain("duplicated across .yaml/.yml")
        expect(yield* Effect.promise(() => Bun.file(archive).exists())).toBe(false)
        const validation = runValidator(configDir)
        expect(validation.exitCode).toBe(1)
        expect(JSON.parse(validation.stdout).discovery_error).toContain("duplicated across .yaml/.yml")
      }),
    { timeout: 60_000 },
  )

  it.effect(
    "fails closed: an invalid template blocks packaging entirely",
    () =>
      Effect.gen(function* () {
        const configDir = yield* configRepoScoped({
          "route-a.yaml": VALID_TEMPLATE_A,
          "route-broken.yaml": INVALID_TEMPLATE,
        })
        const archive = path.join(configDir, "dag-templates.tar.gz")
        const packaged = runPackager(configDir, archive)
        expect(packaged.exitCode).toBe(1)
        expect(packaged.stderr).toContain("Template validation failed")
        expect(packaged.stderr).toContain("Packaging aborted")
        // Nothing was archived — the release job aborts at the gate.
        expect(yield* Effect.promise(() => Bun.file(archive).exists())).toBe(false)

        const gate = runValidator(configDir)
        expect(gate.exitCode).toBe(1)
        const report = JSON.parse(gate.stdout)
        expect(report.invalid_count).toBe(1)
        const broken = report.results.find((entry: { name: string }) => entry.name === "route-broken.yaml")
        expect(broken.errors[0].code).toBe(DagValidation.DIAGNOSTIC_CODES.blockCompileFailed)
      }),
    { timeout: 60_000 },
  )

  it.effect(
    "reports an unparseable template inside the machine-readable JSON",
    () =>
      Effect.gen(function* () {
        const configDir = yield* configRepoScoped({
          "route-a.yaml": VALID_TEMPLATE_A,
          "route-unparseable.yaml": "key: [unclosed",
        })
        const gate = runValidator(configDir)
        expect(gate.exitCode).toBe(1)
        // stdout stays parseable JSON even when a file cannot be parsed.
        const report = JSON.parse(gate.stdout)
        const broken = report.results.find((entry: { name: string }) => entry.name === "route-unparseable.yaml")
        expect(broken.valid).toBe(false)
        expect(broken.errors[0].code).toBe(DagValidation.DIAGNOSTIC_CODES.schemaInvalid)
        expect(broken.errors[0].message).toContain("not parseable YAML")
      }),
    { timeout: 60_000 },
  )

  it.effect(
    "fails closed when runtime compatibility metadata is missing or invalid",
    () =>
      Effect.gen(function* () {
        const configDir = yield* configRepoScoped({ "route-a.yaml": VALID_TEMPLATE_A })
        yield* Effect.promise(() => fs.writeFile(path.join(configDir, "runtime-compat.json"), "{broken"))
        const invalid = runValidator(configDir)
        expect(invalid.exitCode).toBe(1)
        expect(JSON.parse(invalid.stdout).compat_error).toContain("runtime compatibility file is invalid")

        yield* Effect.promise(() => fs.rm(path.join(configDir, "runtime-compat.json")))
        const missing = runValidator(configDir)
        expect(missing.exitCode).toBe(1)
        expect(JSON.parse(missing.stdout).compat_error).toContain("runtime compatibility file is missing")
      }),
    { timeout: 60_000 },
  )
})
