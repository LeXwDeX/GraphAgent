/** Preserve the existing model-specific editing policy in one place. */
export function usesApplyPatch(modelID: string) {
  return modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")
}
