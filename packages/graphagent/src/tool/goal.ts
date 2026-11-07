import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./goal.txt"
import { Goal } from "../goal/goal"
import { GoalState } from "../goal/state"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["status", "create", "resume", "pause", "complete", "intent"]).annotate({
    description: "Create, resume, pause, inspect, complete, or declare the current goal turn's intent.",
  }),
  intent: Schema.optional(Schema.Literals(["progress", "await", "done", "blocked"])).annotate({
    description:
      "Required for action=intent. progress: more work is ready; await: wait for an external wake; done: let the judge verify evidence; blocked: pause visibly.",
  }),
  // Only sources with a production wake producer are accepted; the durable
  // GoalState.WaitSource keeps the wider set for persisted compatibility.
  wait_source: Schema.optional(Schema.Literals(["background_job", "watch_pr"])).annotate({
    description: "Required for intent=await. The wake source to register: watch_pr or background_job.",
  }),
  wait_id: Schema.optional(Schema.String).annotate({
    description:
      "Required for intent=await. The exact identity that will wake the goal. For watch_pr use the job ID from its start output or the watched PR/MR URL; for background_job use the background task id. An unmatched event does not wake the goal.",
  }),
  deadline_ms: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Optional for intent=await. Milliseconds until the wait expires (default 30 minutes).",
  }),
  max_wakes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Optional for intent=await. Maximum wake deliveries accepted for this wait (default 1).",
  }),
  evidence: Schema.optional(Schema.String).annotate({
    description: "Required for intent=done. The concrete delivery evidence the judge verifies.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "Required for create. The goal to pursue; treated as literal text, not a slash command.",
  }),
  max_turns: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  ).annotate({
    description:
      "Positive integer total budget for create (default 20) or resume. Resume preserves used turns. Increase only with user authorization.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Required for pause or complete. Explain the pause or summarize what was delivered.",
  }),
})

type Metadata = {
  goal?: {
    text: string
    status: "active" | "waiting" | "paused" | "done"
    turnsUsed: number
    maxTurns: number
    subgoals: ReadonlyArray<string>
    pausedReason?: string
  } | null
}

// Goal.Service MUST be resolved inside `execute` (request phase), NOT in this
// build-phase `init` gen. `init` runs once during ToolRegistry construction,
// which lives in one Layer.mergeAll group of AppLayer while Goal.defaultLayer
// lives in a sibling group; mergeAll siblings cannot see each other's outputs,
// so a build-phase serviceOption(Goal.Service) is guaranteed None and would be
// captured in this closure, permanently no-op-ing the tool (verified by the
// runtime "autonomous goal service is not available" symptom). At execute time
// the session request context carries the full AppLayer, so Goal.Service is
// reachable. This corrects the misleading reference in goal-loop-correctness
// task 6.1, which cited the old build-phase probe as the pattern to follow.
// serviceOption contributes R = never, so Tool.define<…, never> is unchanged
// and headless runtimes that omit Goal still degrade gracefully below.
export const GoalTool = Tool.define<typeof Parameters, Metadata, never>(
  "goal",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Goal state belongs to the session itself; it is not an external
          // resource boundary (no filesystem, no network, no cross-session
          // write), so it does not need a permission gate.
          const goal = Option.getOrUndefined(yield* Effect.serviceOption(Goal.Service))

          if (!goal) {
            // Goal service not wired into this entry point (some headless
            // / test runtimes omit it). Return a clear message rather than
            // crashing — the tool must never break a session.
            return {
              title: "goal service unavailable",
              output:
                "The autonomous goal service is not available in this runtime. Goal state cannot be queried or modified here.",
              metadata: { goal: null },
            }
          }

          if (params.action === "status") {
            const state = yield* goal.load(ctx.sessionID)
            if (!state) {
              return {
                title: "no goal",
                output: "No autonomous goal is active for this session.",
                metadata: { goal: null },
              }
            }
            const remaining = Math.max(0, state.max_turns - state.turns_used)
            const subgoals = state.subgoals ?? []
            const line = [
              `Goal: ${state.goal}`,
              `Status: ${state.status}`,
              `Turns: ${state.turns_used}/${state.max_turns} (${remaining} remaining)`,
              subgoals.length > 0 ? `Subgoals (${subgoals.length}):` : "Subgoals: none",
              ...subgoals.map((s, i) => `  ${i + 1}. ${s}`),
              state.status === "paused" && state.paused_reason ? `Paused because: ${state.paused_reason}` : null,
              state.last_verdict
                ? `Last judge verdict: ${state.last_verdict}${state.last_reason ? ` — ${state.last_reason}` : ""}`
                : null,
            ]
              .filter(Boolean)
              .join("\n")
            return {
              title: `goal ${state.status} (${state.turns_used}/${state.max_turns})`,
              output: line,
              metadata: {
                goal: {
                  text: state.goal,
                  status: state.status,
                  turnsUsed: state.turns_used,
                  maxTurns: state.max_turns,
                  subgoals,
                  pausedReason: state.paused_reason,
                },
              },
            }
          }

          if (params.action === "intent") {
            if (!params.intent) {
              throw new Tool.InvalidArgumentsError({
                tool: "goal",
                detail: "`intent` is required when action is `intent`.",
              })
            }
            let intent: GoalState.Intent
            if (params.intent === "await") {
              if (!params.wait_source || !params.wait_id) {
                throw new Tool.InvalidArgumentsError({
                  tool: "goal",
                  detail: "`wait_source` and `wait_id` are required when intent is `await`.",
                })
              }
              intent = {
                kind: "await",
                wait: {
                  source: params.wait_source,
                  wait_id: params.wait_id,
                  deadline: Date.now() + (params.deadline_ms ?? 30 * 60_000),
                  max_wakes: GoalState.nni(params.max_wakes ?? 1),
                  wakes: GoalState.nni(0),
                },
              }
            } else if (params.intent === "done") {
              if (!params.evidence || params.evidence.trim().length === 0) {
                throw new Tool.InvalidArgumentsError({
                  tool: "goal",
                  detail: "`evidence` is required when intent is `done`.",
                })
              }
              intent = { kind: "done", evidence: params.evidence.trim() }
            } else if (params.intent === "blocked") {
              intent = { kind: "blocked", reason: params.reason?.trim() || "blocked" }
            } else {
              intent = { kind: "progress" }
            }
            const state = yield* goal.setIntent(ctx.sessionID, intent)
            if (!state) {
              return {
                title: "no active goal",
                output: "Cannot set intent: no active goal for this session.",
                metadata: { goal: null },
              }
            }
            return {
              title: `goal intent ${state.intent?.kind ?? "none"}`,
              output: [
                `Goal: ${state.goal}`,
                `Status: ${state.status}`,
                `Intent: ${state.intent?.kind ?? "none"}`,
                state.status === "waiting" && state.intent?.kind === "await"
                  ? `Waiting for: ${state.intent.wait.source}:${state.intent.wait.wait_id} until ${new Date(state.intent.wait.deadline).toISOString()}`
                  : "Finish this turn; the goal loop applies the intent when the session becomes idle.",
              ].join("\n"),
              metadata: {
                goal: {
                  text: state.goal,
                  status: state.status,
                  turnsUsed: state.turns_used,
                  maxTurns: state.max_turns,
                  subgoals: state.subgoals ?? [],
                  pausedReason: state.paused_reason,
                },
              },
            }
          }

          if (params.action === "create" || params.action === "resume" || params.action === "pause") {
            const input: Goal.TurnControl =
              params.action === "create"
                ? { action: "create", text: params.text ?? "", maxTurns: params.max_turns }
                : params.action === "resume"
                  ? { action: "resume", maxTurns: params.max_turns }
                  : { action: "pause", reason: params.reason ?? "" }
            const result = yield* goal.controlDuringTurn(ctx.sessionID, input)
            if (!result.changed) {
              return {
                title: `goal ${params.action} not applied`,
                output: `Cannot ${params.action} goal: ${result.reason} No state change was applied.`,
                metadata: {},
              }
            }
            const state = result.state
            return {
              title: `goal ${state.status} (${state.turns_used}/${state.max_turns})`,
              output: [
                `Goal: ${state.goal}`,
                `Status: ${state.status}`,
                `Turns: ${state.turns_used}/${state.max_turns}`,
                state.status === "paused"
                  ? `Paused because: ${state.paused_reason}. Automatic continuation is stopped; finish this response.`
                  : "Continue working in this turn. The goal loop evaluates progress when this turn ends; no additional prompt was started.",
              ].join("\n"),
              metadata: {
                goal: {
                  text: state.goal,
                  status: state.status,
                  turnsUsed: state.turns_used,
                  maxTurns: state.max_turns,
                  subgoals: state.subgoals ?? [],
                  pausedReason: state.paused_reason,
                },
              },
            }
          }

          // action === "complete"
          if (!params.reason || params.reason.trim().length === 0) {
            throw new Tool.InvalidArgumentsError({
              tool: "goal",
              detail: "`reason` is required when action is `complete`. Describe in one sentence what was delivered.",
            })
          }
          const state = yield* goal.load(ctx.sessionID)
          if (!state || !Goal.isRunning(state)) {
            return {
              title: "no active goal",
              output:
                "Cannot complete goal: no active goal for this session. The loop may have already finished, been paused, or been cleared.",
              metadata: { goal: null },
            }
          }
          // markDone performs: clearFiber → deleteAndPublishDone (publish
          // goal.updated(done) → deleteState → publish goal.cleared). It is
          // budget-neutral — turns_used counts continuation dispatches only, so
          // markDone does NOT increment it (see goal.ts markDone).
          // deleteAndPublishDone re-loads the current row, so use its return
          // value (NOT the pre-call `state` above) for the completion message —
          // otherwise a turn a prior continue dispatch already accounted for
          // could be missed in the "N turns" count shown to the user.
          const finalState = yield* goal.markDone(ctx.sessionID, params.reason.trim())

          // GOAL-FP-01-09: markDone returns undefined when the transition did
          // not happen (the goal was cleared or completed between the `load`
          // above and the markDone transition). Presenting the pre-call state
          // as completed would claim an achievement for a goal that no longer
          // exists — report the no-op instead.
          if (!finalState) {
            return {
              title: "goal no longer active",
              output:
                "Cannot complete goal: the goal is no longer active (it may have been cleared or completed concurrently). No state transition was applied.",
              metadata: { goal: null },
            }
          }
          const completionMsg = `Goal completed (${finalState.turns_used}/${finalState.max_turns} turns): ${finalState.goal}\nReason: ${params.reason.trim()}`
          return {
            title: `goal completed (${finalState.turns_used}/${finalState.max_turns})`,
            output: completionMsg,
            metadata: {
              goal: {
                text: finalState.goal,
                status: "done" as const,
                turnsUsed: finalState.turns_used,
                maxTurns: finalState.max_turns,
                subgoals: finalState.subgoals ?? [],
              },
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
