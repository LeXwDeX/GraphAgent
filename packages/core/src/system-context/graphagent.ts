export * as GraphAgentPrompt from "./graphagent"

import PROMPT from "./graphagent.txt"

/** Name the editing tools this request actually exposes. */
export function editingInstruction(tools: readonly string[]) {
  if (tools.includes("apply_patch")) return "Use apply_patch for manual file edits."
  const available = ["edit", "write"].filter((name) => tools.includes(name))
  if (available.length) return `Use ${available.join(" and ")} for manual file edits.`
  return "No file-editing tool is available in this request. Do not use shell commands to bypass this restriction."
}

/**
 * The one system prompt every model receives. The editing instruction is the
 * only part that varies, because it names the tools exposed for this request.
 */
export function render(tools: readonly string[]) {
  return PROMPT.replace("${editingInstruction}", () => editingInstruction(tools))
}
