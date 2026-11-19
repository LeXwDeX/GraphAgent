/** The provider a web search went through, by name; none when the call does not say, or says one this build does not know. */
export function webSearchProviderName(provider: unknown) {
  if (provider === "parallel") return "Parallel"
  if (provider === "exa") return "Exa"
  return undefined
}

export function webSearchProviderLabel(provider: unknown) {
  const name = webSearchProviderName(provider)
  return name ? `${name} Web Search` : "Web Search"
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  if (!("status" in state) || state.status === "pending") return {}
  if (!("structured" in state) || !state.structured || typeof state.structured !== "object") return {}
  if (Array.isArray(state.structured)) return {}
  return state.structured as Record<string, unknown>
}

export function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

export function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const toolDisplays = new Set([
  "bash",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "write",
  "edit",
  "task",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
])

export function toolDisplay(tool: string) {
  return toolDisplays.has(tool) ? tool : "generic"
}

/**
 * What the row of a call leads with, by tool: the tool's identifier, which is the same in every language and so is not in
 * the message tables (#1614). A tool that has no entry leads with its own id.
 */
const toolRowNames: Readonly<Record<string, string>> = {
  bash: "Bash",
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  websearch: "WebSearch",
  webfetch: "WebFetch",
  skill: "Skill",
  write: "Write",
  edit: "Edit",
  apply_patch: "Patch",
  task: "Task",
}

export function toolRowName(tool: string) {
  return toolRowNames[toolDisplay(tool)] ?? tool
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = recordValue(item)
    if (!file) return []
    const type = stringValue(file.type)
    const relativePath = stringValue(file.relativePath)
    const filePath = stringValue(file.filePath)
    const patch = stringValue(file.patch)
    const deletions = numberValue(file.deletions)
    if (!type || !relativePath || !filePath || patch === undefined || deletions === undefined) return []
    // A server that does not count the added lines leaves `additions` out: the row then says only what was removed.
    return [
      {
        type,
        relativePath,
        filePath,
        patch,
        additions: numberValue(file.additions),
        deletions,
        movePath: stringValue(file.movePath),
      },
    ]
  })
}

export function parseTodos(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const todo = recordValue(item)
    const status = stringValue(todo?.status)
    const content = stringValue(todo?.content)
    return status && content ? [{ status, content }] : []
  })
}

export function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const question = stringValue(recordValue(item)?.question)
    return question ? [{ question }] : []
  })
}

export function parseQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}

/** The errors of a file a row lists under its summary; the others are only counted. */
export const DIAGNOSTIC_LINES = 3

/** The errors the language server found in `filePath`: the first `DIAGNOSTIC_LINES`, or the first `limit`. */
export function parseDiagnostics(value: unknown, filePath: string, limit = DIAGNOSTIC_LINES) {
  const diagnostics = recordValue(value)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .flatMap((item) => {
      const diagnostic = recordValue(item)
      const start = recordValue(recordValue(diagnostic?.range)?.start)
      const line = numberValue(start?.line)
      const character = numberValue(start?.character)
      const message = stringValue(diagnostic?.message)
      if (diagnostic?.severity !== 1 || line === undefined || character === undefined || !message) return []
      return [{ range: { start: { line, character } }, message }]
    })
    .slice(0, limit)
}
