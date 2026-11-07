#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { parseArgs } from "util"

const root = path.resolve(import.meta.dirname, "../../..")
const snapshot = path.join(root, "packages/core/schema.json")
const tsDir = path.join(root, "packages/core/src/database/migration")
const registry = path.join(root, "packages/core/src/database/migration.gen.ts")
const schema = path.join(root, "packages/core/src/database/schema.gen.ts")
const baselineLock = path.join(root, "packages/core/baseline.lock")
const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    check: { type: "boolean" },
    name: { type: "string" },
    rebaseline: { type: "boolean" },
    "freeze-baseline": { type: "boolean" },
  },
})

if (args.values.check) {
  await check()
  process.exit(0)
}

if (args.values["freeze-baseline"]) {
  await freezeBaseline()
  process.exit(0)
}

if (args.values.rebaseline) {
  await rebaseline()
  process.exit(0)
}

await generate()

async function generate() {
  if (!(await Bun.file(baselineLock).exists())) {
    throw new Error(
      "The v2.0.0 baseline is not frozen yet. Incremental migrations are disabled; change the Drizzle definitions and run `bun run migration --rebaseline` instead.",
    )
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-migration-"))
  const incremental = path.join(temporary, "incremental")
  const full = path.join(temporary, "full")
  try {
    await fs.mkdir(incremental)
    await fs.mkdir(path.join(incremental, "baseline"))
    await fs.copyFile(snapshot, path.join(incremental, "baseline/snapshot.json"))
    await drizzle(temporary, incremental, args.values.name)

    const generated = await generatedMigrations(incremental)
    if (generated.length > 1) throw new Error(`Expected one generated migration, found ${generated.length}.`)
    const name = generated[0]
    if (name) {
      const target = path.join(tsDir, `${name}.ts`)
      if (await Bun.file(target).exists()) throw new Error(`Database migration already exists: ${name}`)
      await Bun.write(
        target,
        await formatTypescript(
          renderMigration(name, await Bun.file(path.join(incremental, name, "migration.sql")).text()),
        ),
      )
      await fs.copyFile(path.join(incremental, name, "snapshot.json"), snapshot)
    }

    const fullSchema = await generateFull(temporary)
    await Bun.write(schema, await formatTypescript(renderSchema(fullSchema.sql)))
    await Bun.write(
      registry,
      await formatTypescript(renderRegistry(await typescriptMigrations(), baselineId(fullSchema.sql))),
    )
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function rebaseline() {
  if (await Bun.file(baselineLock).exists()) {
    throw new Error(
      "The baseline is frozen (packages/core/baseline.lock exists). Incremental migrations are in effect; `--rebaseline` is no longer allowed.",
    )
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-migration-rebaseline-"))
  try {
    const full = await generateFull(temporary)
    await fs.rm(tsDir, { recursive: true, force: true })
    await fs.mkdir(tsDir, { recursive: true })
    await Bun.write(path.join(tsDir, ".gitkeep"), "")
    await fs.copyFile(full.snapshot, snapshot)
    await Bun.write(schema, await formatTypescript(renderSchema(full.sql)))
    await Bun.write(registry, await formatTypescript(renderRegistry([], baselineId(full.sql))))
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function freezeBaseline() {
  if (await Bun.file(baselineLock).exists())
    throw new Error("The baseline is already frozen (packages/core/baseline.lock).")
  const migrations = await typescriptMigrations()
  if (migrations.length > 0) {
    throw new Error(
      `Cannot freeze the baseline while incremental migrations exist (${migrations.length} files in src/database/migration). Run \`bun run migration --rebaseline\` first.`,
    )
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-migration-freeze-"))
  try {
    const full = await generateFull(temporary)
    const id = baselineId(full.sql)
    if ((await Bun.file(schema).text()) !== (await formatTypescript(renderSchema(full.sql)))) {
      throw new Error(
        "Current database schema is stale. Run `bun run migration --rebaseline` before freezing the baseline.",
      )
    }
    if ((await Bun.file(registry).text()) !== (await formatTypescript(renderRegistry([], id)))) {
      throw new Error(
        "Database migration registry is stale. Run `bun run migration --rebaseline` before freezing the baseline.",
      )
    }
    await Bun.write(baselineLock, `${id}\n`)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function check() {
  const frozen = await Bun.file(baselineLock).exists()
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-migration-check-"))
  const incremental = path.join(temporary, "incremental")
  try {
    const full = await generateFull(temporary)
    const id = baselineId(full.sql)
    if ((await Bun.file(schema).text()) !== (await formatTypescript(renderSchema(full.sql)))) {
      throw new Error(
        frozen
          ? "Current database schema is stale. Run `bun run migration` from packages/core."
          : "Current database schema is stale. Run `bun run migration --rebaseline` from packages/core.",
      )
    }

    const migrations = await typescriptMigrations()
    if (frozen) {
      if ((await Bun.file(baselineLock).text()).trim() !== id) {
        throw new Error(
          "packages/core/baseline.lock does not match the current database schema. Run `bun run migration`.",
        )
      }
    } else if (migrations.length > 0) {
      throw new Error(
        `The v2.0.0 pre-release baseline must not contain incremental migrations, found ${migrations.length} files in src/database/migration. Run \`bun run migration --rebaseline\` to fold them into the baseline.`,
      )
    }

    await fs.mkdir(incremental)
    await fs.mkdir(path.join(incremental, "baseline"))
    await fs.copyFile(snapshot, path.join(incremental, "baseline/snapshot.json"))
    await drizzle(temporary, incremental)
    if ((await generatedMigrations(incremental)).length > 0) {
      throw new Error(
        frozen
          ? "Core schema has ungenerated database migrations. Run `bun script/migration.ts` from packages/core."
          : "Core schema snapshot is stale. Run `bun run migration --rebaseline` from packages/core.",
      )
    }

    if ((await Bun.file(registry).text()) !== (await formatTypescript(renderRegistry(migrations, id)))) {
      throw new Error(
        frozen
          ? "Database migration registry is stale. Run `bun script/migration.ts` from packages/core."
          : "Database migration registry is stale. Run `bun run migration --rebaseline` from packages/core.",
      )
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function generateFull(temporary: string) {
  const full = path.join(temporary, "full")
  await fs.mkdir(full)
  await drizzle(temporary, full, "schema")
  const generated = await generatedMigrations(full)
  if (generated.length !== 1) throw new Error(`Expected one full schema migration, found ${generated.length}.`)
  return {
    sql: await Bun.file(path.join(full, generated[0]!, "migration.sql")).text(),
    snapshot: path.join(full, generated[0]!, "snapshot.json"),
  }
}

function baselineId(sql: string) {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(sql)
  return `baseline-${hasher.digest("hex").slice(0, 16)}`
}

async function drizzle(temporary: string, output: string, name?: string) {
  const config = path.join(temporary, `${path.basename(output)}.config.ts`)
  await Bun.write(
    config,
    `import config from ${JSON.stringify(pathToFileURL(path.join(root, "packages/core/drizzle.config.ts")).href)}

export default { ...config, out: ${JSON.stringify(output)} }
`,
  )
  await $`bun drizzle-kit generate --config ${config} ${name ? ["--name", name] : []}`.cwd(
    path.join(root, "packages/core"),
  )
}

async function generatedMigrations(directory: string) {
  return (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: directory })))
    .map((file) => file.split("/")[0])
    .filter((name): name is string => name !== undefined)
    .sort()
}

async function typescriptMigrations() {
  return (await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: tsDir })))
    .map((file) => path.basename(file, ".ts"))
    .sort()
}

function renderMigration(name: string, sql: string) {
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: ${JSON.stringify(name)},
  up(tx) {
    return Effect.gen(function* () {
${renderStatements(sql)}
    })
  },
} satisfies DatabaseMigration.Migration
`
}

function renderSchema(sql: string) {
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
${renderStatements(sql)}
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
`
}

function renderStatements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map(renderRun)
    .join("\n")
}

function renderRun(statement: string) {
  const lines = statement.replaceAll("\t", "  ").split("\n")
  if (lines.length === 1) return `      yield* tx.run(\`${escapeTemplate(lines[0])}\`)`
  return `      yield* tx.run(\`\n${lines.map((line) => `        ${escapeTemplate(line)}`).join("\n")}\n      \`)`
}

function escapeTemplate(line: string) {
  return line.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")
}

async function formatTypescript(input: string) {
  const prettier = await import("prettier")
  const typescript = await import("prettier/plugins/typescript")
  const estree = await import("prettier/plugins/estree")
  return prettier.format(input, {
    parser: "typescript",
    plugins: [typescript.default, estree.default],
    semi: false,
    printWidth: 120,
  })
}

function renderRegistry(names: string[], id: string) {
  const migrations =
    names.length === 0
      ? "export const migrations: DatabaseMigration.Migration[] = []"
      : `export const migrations = (
  await Promise.all([
${names.map((name) => `    import("./migration/${name}"),`).join("\n")}
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]`
  return `import type { DatabaseMigration } from "./migration"

export const baseline = { id: ${JSON.stringify(id)} } as const

${migrations}
`
}
