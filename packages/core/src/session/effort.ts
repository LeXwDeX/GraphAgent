/** Claude Code's portable effort levels. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

/**
 * Map a model variant (see provider/transform.ts's `VARIANT_EFFORT_ORDER`) to
 * Claude Code's effort level. Only CC's five levels are portable: provider
 * tiers below `low` report `low`, tiers above `max` report `max`, and unknown
 * names — including provider-specific custom variants — yield `undefined`
 * rather than a guess.
 */
export function variantToEffort(variant: string | undefined): Effort | undefined {
  switch (variant) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return variant
    // No reasoning at all sits below CC's lowest selectable level.
    case "none":
    case "minimal":
      return "low"
    // fork-only tier above "max"; CC clamps to the level it actually runs.
    case "ultra":
      return "max"
    default:
      return undefined
  }
}
