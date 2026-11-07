import { existsSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { dagTemplateDirectoryFailure, validateDagTemplateDirectory } from "./dag-template-validation"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const modelsUrl = process.env.GRAPHAGENT_MODELS_URL || "https://models.dev"

async function loadModelsData() {
  if (process.env.MODELS_DEV_API_JSON) {
    console.log("Loaded models.dev snapshot from MODELS_DEV_API_JSON")
    return Bun.file(process.env.MODELS_DEV_API_JSON).text()
  }

  const response = await fetch(`${modelsUrl}/api.json`).catch(() => undefined)
  if (response?.ok) {
    console.log("Loaded models.dev snapshot from api.json")
    return response.text()
  }

  const snapshotSpecifier = "@graphagent/models/snapshot"
  const snapshot = await import(snapshotSpecifier).catch(() => undefined)
  if (snapshot) {
    console.log("Loaded models.dev snapshot from @graphagent/models")
    return JSON.stringify(snapshot.providers)
  }

  console.log("Loaded no models.dev snapshot")
  return "undefined"
}

export const modelsData = await loadModelsData()

/**
 * DAG reference templates compiled into the binary so air-gapped installs
 * ship the curated workflows without network access. The release pipeline
 * clones opencode-dag-config and points DAG_TEMPLATES_DIR at it; when absent
 * (local dev), the binary has no builtin templates and falls back to the
 * project/global workflow library scopes.
 */
async function loadDagTemplatesData() {
  const templatesDir = process.env.DAG_TEMPLATES_DIR
  if (!templatesDir) {
    console.log("Loaded no dag templates snapshot (DAG_TEMPLATES_DIR unset)")
    return "undefined"
  }
  // Contextual failure: a set-but-unresolvable dir usually means the release
  // workflow's Extract Templates step wrote an unconverted shell path
  // (Windows Git Bash) — fail loudly with the offending value instead of a
  // bare glob/IO error.
  if (!existsSync(templatesDir)) {
    throw new Error(
      `DAG_TEMPLATES_DIR points to a missing directory: ${templatesDir} — check the release workflow's Extract Templates step path conversion`,
    )
  }
  const validation = await validateDagTemplateDirectory(templatesDir)
  const failure = dagTemplateDirectoryFailure(validation)
  if (failure) throw new Error(failure)
  const templates = Object.fromEntries(
    validation.results.map((entry) => [entry.name.replace(/\.ya?ml$/, ""), entry.content]),
  )
  console.log(
    `Loaded dag templates snapshot from ${templatesDir}: ${Object.keys(templates).length} templates (all validated)`,
  )
  return JSON.stringify(templates)
}

export const dagTemplatesData = await loadDagTemplatesData()
