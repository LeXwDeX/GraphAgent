// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Loop background-analysis result (#1328).
 *
 * This is the parameter shape of the analysis agent's `submit_analysis` tool, so
 * field names stay snake_case (the model-facing wire form) and every field
 * carries a description for the model. The schema fixes structure only: the
 * content rules V1-V8 (first analysis, verbatim intent, evidence, limits) are
 * checked by the runtime validator, so a rule violation reaches the model as a
 * numbered rule instead of a decode error.
 */

import { Schema } from "effect"

/** Upper bound on `next_prompt`, in characters (rule V5). */
export const LOOP_NEXT_PROMPT_MAX_CHARS = 8000
/** Upper bound on `reason`, in characters (rule V8). */
export const LOOP_REASON_MAX_CHARS = 300

export const LoopVerdict = Schema.Literals(["continue", "done", "blocked", "goal_changed", "user_stop"]).annotate({
  description:
    "continue: keep going, next_prompt is required. done: every acceptance item is met with evidence. " +
    "blocked: only the user can unblock it, open_questions lists the questions. " +
    "goal_changed: a human message moved the long-term goal. user_stop: a human message asked to stop.",
})
export type LoopVerdict = typeof LoopVerdict.Type

export const LoopAcceptanceStatus = Schema.Literals(["unmet", "met"])
export type LoopAcceptanceStatus = typeof LoopAcceptanceStatus.Type

export const LoopAcceptance = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable identifier, unique within the list (for example A1)." }),
  text: Schema.String.annotate({ description: "What must be true for this item to count as done." }),
  status: LoopAcceptanceStatus,
  evidence: Schema.optional(Schema.String).annotate({
    description: "Where the item was verified (file, test, command output). Required once the item is met.",
  }),
})
export type LoopAcceptance = typeof LoopAcceptance.Type

/** The user's intent as understood by the analysis. Versioned by the caller; every revision is traceable. */
export const LoopIntent = Schema.Struct({
  objective: Schema.String.annotate({ description: "One sentence stating the final goal." }),
  acceptance: Schema.Array(LoopAcceptance).annotate({
    description:
      "Verifiable acceptance items. Existing items keep their id and text; new items may be added; " +
      "update status and evidence as the work progresses.",
  }),
  constraints: Schema.Array(Schema.String).annotate({
    description: "Constraints and no-go areas the user stated explicitly.",
  }),
  non_goals: Schema.Array(Schema.String).annotate({ description: "Things the user explicitly does not want done." }),
  assumptions: Schema.Array(Schema.String).annotate({
    description: "Assumptions made by the analysis that are still unverified.",
  }),
  open_questions: Schema.Array(Schema.String).annotate({ description: "Questions only the user can answer." }),
})
export type LoopIntent = typeof LoopIntent.Type

export const LoopIntentChange = Schema.Struct({
  changed: Schema.Boolean.annotate({
    description:
      "True when objective, constraints or non_goals differ from the previous version, or an existing " +
      "acceptance item was removed or rewritten.",
  }),
  basis_message_id: Schema.optional(Schema.String).annotate({
    description:
      "ID of the human message, from the basis window, that justifies the change or the goal_changed / " +
      "user_stop verdict.",
  }),
  summary: Schema.optional(Schema.String).annotate({ description: "One sentence on what changed and why." }),
})
export type LoopIntentChange = typeof LoopIntentChange.Type

export const LoopProgress = Schema.Struct({
  advanced: Schema.Boolean.annotate({
    description:
      "False when this turn completed no new item and ruled out no path compared with the last analysis.",
  }),
  summary: Schema.String.annotate({ description: "What this turn achieved." }),
  done: Schema.Array(Schema.String).annotate({ description: "Work items completed so far." }),
  remaining: Schema.Array(Schema.String).annotate({ description: "Work items still to do." }),
})
export type LoopProgress = typeof LoopProgress.Type

export const LoopAnalysisResult = Schema.Struct({
  verdict: LoopVerdict,
  intent: LoopIntent,
  intent_change: LoopIntentChange,
  progress: LoopProgress,
  next_prompt: Schema.optional(Schema.String).annotate({
    description:
      `Required when verdict is continue; at most ${LOOP_NEXT_PROMPT_MAX_CHARS} characters. State what this round ` +
      "must achieve, where to pick up, how to verify, and what the last round got wrong. Do not repeat the " +
      "objective or constraints; the runtime appends them to every round.",
  }),
  reason: Schema.String.annotate({
    description: `Reason shown to the user; 1 to ${LOOP_REASON_MAX_CHARS} characters.`,
  }),
})
export type LoopAnalysisResult = typeof LoopAnalysisResult.Type
