import path from "node:path"
import { Schema } from "effect"

const RuntimeCompat = Schema.Struct({
  runtime_repo: Schema.String,
  runtime_commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
})

const decodeRuntimeCompat = Schema.decodeUnknownSync(RuntimeCompat)

/** One root-only discovery contract shared by validation, generation, and packaging. */
export async function discoverDagTemplateFiles(directory: string) {
  const files = await Promise.all(
    ["*.yaml", "*.yml"].map((pattern) => Array.fromAsync(new Bun.Glob(pattern).scan(directory))),
  )
  const discovered = [...new Set(files.flat())].sort()
  const names = new Map<string, string>()
  for (const file of discovered) {
    const name = path.basename(file, path.extname(file))
    const previous = names.get(name)
    if (previous) {
      throw new Error(`DAG template name is duplicated across .yaml/.yml files: ${name} (${previous}, ${file})`)
    }
    names.set(name, file)
  }
  return discovered
}

/** A template directory is releasable only when it pins one exact runtime. */
export async function readRuntimeCompat(directory: string) {
  const filepath = path.join(directory, "runtime-compat.json")
  if (!(await Bun.file(filepath).exists())) {
    throw new Error(`runtime compatibility file is missing: ${filepath}`)
  }
  try {
    return decodeRuntimeCompat(await Bun.file(filepath).json())
  } catch (error) {
    throw new Error(`runtime compatibility file is invalid: ${filepath}: ${String(error)}`, { cause: error })
  }
}
