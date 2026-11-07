export * as ConfigPaths from "./paths"

import path from "path"
import { PROJECT_DIR } from "@opencode-ai/core/brand"

/** Shared project settings inside `<root>/.agents/`. */
export const PROJECT_SETTINGS = "settings.json"
/** Local project overrides inside `<root>/.agents/`; same schema as the shared file. */
export const PROJECT_LOCAL_SETTINGS = "settings.local.json"

/** `<root>/.agents` — the only project configuration directory. */
export function projectDirectory(root: string) {
  return path.join(root, PROJECT_DIR)
}

export function projectSettingsFile(root: string) {
  return path.join(projectDirectory(root), PROJECT_SETTINGS)
}

export function projectLocalSettingsFile(root: string) {
  return path.join(projectDirectory(root), PROJECT_LOCAL_SETTINGS)
}

/** Project settings in merge order: shared first, local overrides second. */
export function projectSettingsFiles(root: string) {
  return [projectSettingsFile(root), projectLocalSettingsFile(root)]
}

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
