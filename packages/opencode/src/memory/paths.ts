export * as MemoryPaths from "./paths"

/** Worktree-local paths containing durable project memory. */
export const PROJECT_PATHS = [".agents/memory.jsonc", ".agents/memory.json", ".agents/memory/"] as const

export const PROJECT_CONFIG_PATHS = [".agents/memory.jsonc", ".agents/memory.json"] as const

export function isProjectMemoryPath(input: string) {
  const path = input.replaceAll("\\", "/").replace(/^\.\//, "")
  return PROJECT_PATHS.some((candidate) => (candidate.endsWith("/") ? path.startsWith(candidate) : path === candidate))
}
