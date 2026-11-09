// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { CONFIG_BASENAME, PROJECT_DIR } from "@graphagent/core/brand"
import customizeConfigContent from "./customize-opencode.md" with { type: "text" }
import configureHooksContent from "./configure-hooks.md" with { type: "text" }
import gitWorkflowContent from "./git-workflow.md" with { type: "text" }

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
    name: "customize-opencode",
    description: `Use ONLY when the user is editing or creating opencode's own configuration: ${CONFIG_BASENAME}.json, ${CONFIG_BASENAME}.jsonc, files under ${PROJECT_DIR}/, or files under ~/.config/${CONFIG_BASENAME}/. Also use when creating or fixing opencode agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.`,
    content: customizeConfigContent,
  },
  {
    name: "configure-hooks",
    description:
      "Use when the user wants opencode to react to a tool or lifecycle event, run a background check, or poll for a result and resume the same idle conversation. Also use for questions about hooks, hooks.json, or migrating Claude Code hooks. Explains the 31 supported events and local applicability, 5 handler types, matching, configuration scopes, input/output protocols, synchronous decisions, async/asyncRewake continuation, and how to verify execution. Load this skill before creating or changing a lifecycle hook.",
    content: configureHooksContent,
  },
  {
    name: "git-workflow",
    description:
      "Use when committing, pushing, creating a branch, or opening or updating a pull request. Covers inspecting changes, staging only intended files, commit message style, non-destructive git rules, and the gh PR workflow.",
    content: gitWorkflowContent,
  },
]
