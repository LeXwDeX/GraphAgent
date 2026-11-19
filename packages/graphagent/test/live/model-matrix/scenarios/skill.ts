// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The `skill` scenarios: loading a skill by its name, and recovering from a name that is only part of it. The
 * skill file is part of the workspace (`.agents/skills/` is the project layer), so each run has its own and
 * the host's home holds no scenario data.
 */

import { ranTool, replyHas } from "../judge"
import type { Scenario } from "../types"
import { call, once, say } from "./kit"

const CHECKLIST = "CHECKLIST-7Q2 tag, notes, publish"

const SKILLS = {
  ".agents/skills/release-notes/SKILL.md": `---
name: release-notes
description: Release checklist
---

When asked for the release checklist, reply with exactly: ${CHECKLIST}
`,
}

export const SKILL_SCENARIOS: readonly Scenario[] = [
  {
    id: "skill.call",
    files: SKILLS,
    prompt: "Use the skill tool to load the release-notes skill, then reply with the checklist line it asks for.",
    scripts: { default: once("skill", { name: "release-notes" }, CHECKLIST) },
    judge: (run) => [...ranTool(run, "skill"), ...replyHas(run, CHECKLIST)],
  },
  {
    id: "skill.recover",
    files: SKILLS,
    prompt: "Use the skill tool to load the skill named release, then reply with the checklist line it asks for.",
    scripts: {
      default: {
        replies: [call("skill", { name: "release" }), call("skill", { name: "release-notes" }), say(CHECKLIST)],
        trap: { call: 0, includes: ["Available skills:", "release-notes"] },
      },
    },
    judge: (run) => [...ranTool(run, "skill"), ...replyHas(run, CHECKLIST)],
  },
]
