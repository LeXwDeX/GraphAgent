// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { CONFIG_BASENAME, PROJECT_DIR } from "@graphagent/core/brand"
import customizeConfigContent from "./customize-graphagent.md" with { type: "text" }
import configureHooksContent from "./configure-hooks.md" with { type: "text" }
import gitWorkflowContent from "./git-workflow.md" with { type: "text" }
import dagAutoContent from "./dag-auto.md" with { type: "text" }
import dagBlocksContent from "./dag-blocks.md" with { type: "text" }
import dagNodesContent from "./dag-nodes.md" with { type: "text" }
import dagRecoveryContent from "./dag-recovery.md" with { type: "text" }
import dagPatternsContent from "./dag-patterns.md" with { type: "text" }
import dagPolicyContent from "./dag-policy.md" with { type: "text" }

export interface BuiltinSkill {
  name: string
  /** Trigger description; written to the skill list and the slash-command help. */
  description: string
  /** SKILL.md body. */
  content: string
  /** true: no same-name slash command (reference-only skill). */
  hidden?: boolean
}

/**
 * Single registration point for built-in skills. `Skill` seeds these in order;
 * a disk skill with the same name overrides the built-in one.
 */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  {
    name: "customize-graphagent",
    description: `Use ONLY when the user is editing or creating GraphAgent's own configuration: ${CONFIG_BASENAME}.json, ${CONFIG_BASENAME}.jsonc, files under ${PROJECT_DIR}/, or files under ~/.config/${CONFIG_BASENAME}/. Also use when creating or fixing GraphAgent agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring GraphAgent itself.`,
    content: customizeConfigContent,
  },
  {
    name: "configure-hooks",
    description:
      "Use when the user wants GraphAgent to react to a tool or lifecycle event, run a background check, or poll for a result and resume the same idle conversation. Also use for questions about hooks, hooks.json, or migrating Claude Code hooks. Explains the 31 supported events and local applicability, 5 handler types, matching, configuration scopes, input/output protocols, synchronous decisions, async/asyncRewake continuation, and how to verify execution. Load this skill before creating or changing a lifecycle hook.",
    content: configureHooksContent,
  },
  {
    name: "git-workflow",
    description:
      "Use when committing, pushing, creating a branch, or opening or updating a pull request. Covers inspecting changes, staging only intended files, commit message style, non-destructive git rules, and the gh PR workflow.",
    content: gitWorkflowContent,
  },
  {
    name: "dag-auto",
    description: "Assess useful DAG orchestration for a request and adapt the graph to its evidence and dependencies",
    content: dagAutoContent,
  },
  {
    name: "dag-blocks",
    description:
      "Use when authoring or repairing composable workflow block YAML. Covers start/extend/replan envelopes, block kinds and contracts, fan_out, and when to drop to low-level nodes.",
    content: dagBlocksContent,
    hidden: true,
  },
  {
    name: "dag-nodes",
    description:
      "Use when authoring low-level workflow nodes or resolving saved workflows. Covers node fields, input mapping, prompt templates, budgets, node defaults, and single-workspace discipline.",
    content: dagNodesContent,
    hidden: true,
  },
  {
    name: "dag-recovery",
    description:
      "Use when a workflow failed, stalled, timed out, needs replanning or recovery, or reports a verdict needing disposal. Covers failure triage, crash recovery, pause-first replan, checkpoint gating, and bounded repair.",
    content: dagRecoveryContent,
    hidden: true,
  },
  {
    name: "dag-patterns",
    description:
      "Use when selecting a workflow shape or combining domain playbooks. Covers staged gates, parallel fan-out, adversarial review, diverge-converge, and cross-domain assurance slices.",
    content: dagPatternsContent,
    hidden: true,
  },
  {
    name: "dag-policy",
    description:
      "Use for DAG execution policy: model tiers, depth choices, parent/child ownership, deep admission QA, role resolution, review lifecycle, and business-verdict gates.",
    content: dagPolicyContent,
    hidden: true,
  },
]
