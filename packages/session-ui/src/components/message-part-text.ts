export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

/** Display-only hook replacement takes precedence over the raw streaming accumulator. */
export function readDisplayPartText(
  accum: Record<string, string> | undefined,
  part: { id: string; text?: string; displayText?: string },
): string {
  return (part.displayText ?? accum?.[part.id] ?? part.text ?? "").trim()
}
