/** Preserve the existing model-specific editing policy in one place. */
export function usesApplyPatch(modelID: string) {
  return modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")
}

export function editingTools(modelID: string) {
  return usesApplyPatch(modelID) ? ["apply_patch"] : ["edit", "write"]
}

export function editingInstruction(tools: readonly string[]) {
  if (tools.includes("apply_patch")) return "Use apply_patch for manual file edits."
  const available = ["edit", "write"].filter((name) => tools.includes(name))
  if (available.length) return `Use ${available.join(" and ")} for manual file edits.`
  return "No file-editing tool is available in this request. Do not use shell commands to bypass this restriction."
}
