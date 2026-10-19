import fs from "node:fs/promises"
import path from "node:path"

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
export async function install(directory: string) {
  const target = path.join(directory, "hooks.json")
  const lock = `${target}.install-lock`
  await fs.mkdir(directory, { recursive: true })
  await fs.mkdir(lock)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    const original = await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    const local: unknown = original === undefined ? {} : JSON.parse(original)
    if (!object(local)) throw new Error("hooks.json must be an object")
    if (local.hooks !== undefined && !object(local.hooks)) throw new Error("hooks must be an object")
    const configured = object(local.hooks) ? local.hooks : local
    const template: unknown = JSON.parse(
      await fs.readFile(new URL("./ci-watcher.template.json", import.meta.url), "utf8"),
    )
    if (!object(template)) throw new Error("Invalid watcher template")
    for (const [event, defaults] of Object.entries(template)) {
      if (!Array.isArray(defaults) || (configured[event] !== undefined && !Array.isArray(configured[event])))
        throw new Error(`Invalid ${event} hooks`)
      const groups = (configured[event] ?? []) as unknown[]
      configured[event] = [
        ...groups.flatMap((group) => {
          if (!object(group) || !Array.isArray(group.hooks)) throw new Error(`Invalid ${event} hook group`)
          const hooks = group.hooks.filter(
            (hook) => !object(hook) || !object(hook.options) || hook.options.repoCiWatcher !== "v1",
          )
          return hooks.length ? [{ ...group, hooks }] : []
        }),
        ...defaults,
      ]
    }
    const text = JSON.stringify(local, null, 2) + "\n"
    if (text === original) return false
    const mode = (await fs.stat(target).catch(() => undefined))?.mode ?? 0o600
    await fs.writeFile(temporary, text, { mode })
    if ((await fs.readFile(target, "utf8").catch(() => undefined)) !== original)
      throw new Error("hooks.json changed during installation; retry")
    await fs.rename(temporary, target)
    return true
  } finally {
    await fs.rm(temporary, { force: true })
    await fs.rmdir(lock)
  }
}
if (import.meta.main) {
  await install(path.resolve(import.meta.dir, ".."))
  console.log("CI watcher installed in local .opencode/hooks.json. Start a new session to receive guidance.")
}
