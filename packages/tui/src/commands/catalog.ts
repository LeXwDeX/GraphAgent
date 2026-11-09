// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Flag } from "@graphagent/core/flag/flag"
import type { MessageKey } from "../i18n"
import type { CommandCategory, CommandScope, CommandSlash } from "./registry"

/**
 * Metadata for the v2 builtin command surface. Implementations are attached by
 * the mounted view through `CommandRegistry.setHandler`, which keeps this list
 * free of UI imports and usable by completion, the palette and tests.
 */
export interface BuiltinCommandDefinition {
  id: string
  titleKey: MessageKey
  descriptionKey?: MessageKey
  category: CommandCategory
  scope: readonly CommandScope[]
  slash?: CommandSlash
  enabled?: () => boolean
  hidden?: boolean
}

const HSA = ["home", "session", "subagent"] as const
const HS = ["home", "session"] as const
const S = ["session"] as const
const SA = ["session", "subagent"] as const

export const BUILTIN_COMMANDS: readonly BuiltinCommandDefinition[] = [
  {
    id: "session.new",
    titleKey: "command.session.new.title",
    descriptionKey: "command.session.new.description",
    category: "session",
    scope: HSA,
    slash: { name: "new", aliases: ["clear"], args: "none" },
  },
  {
    id: "session.list",
    titleKey: "command.session.list.title",
    descriptionKey: "command.session.list.description",
    category: "session",
    scope: HSA,
    slash: { name: "sessions", aliases: ["resume"], args: "none" },
  },
  {
    id: "session.rename",
    titleKey: "command.session.rename.title",
    descriptionKey: "command.session.rename.description",
    category: "session",
    scope: S,
    slash: { name: "rename", args: "optional" },
  },
  {
    id: "session.fork",
    titleKey: "command.session.fork.title",
    descriptionKey: "command.session.fork.description",
    category: "session",
    scope: S,
    slash: { name: "fork", args: "none" },
  },
  {
    id: "session.timeline",
    titleKey: "command.session.timeline.title",
    descriptionKey: "command.session.timeline.description",
    category: "session",
    scope: S,
    slash: { name: "timeline", args: "none" },
  },
  {
    id: "session.compact",
    titleKey: "command.session.compact.title",
    descriptionKey: "command.session.compact.description",
    category: "session",
    scope: S,
    slash: { name: "compact", aliases: ["summarize"], args: "none" },
  },
  {
    id: "session.undo",
    titleKey: "command.session.undo.title",
    descriptionKey: "command.session.undo.description",
    category: "session",
    scope: S,
    slash: { name: "undo", args: "none" },
  },
  {
    id: "session.redo",
    titleKey: "command.session.redo.title",
    descriptionKey: "command.session.redo.description",
    category: "session",
    scope: S,
    slash: { name: "redo", args: "none" },
  },
  {
    id: "session.copy",
    titleKey: "command.session.copy.title",
    descriptionKey: "command.session.copy.description",
    category: "session",
    scope: SA,
    slash: { name: "copy", args: "none" },
  },
  {
    id: "session.export",
    titleKey: "command.session.export.title",
    descriptionKey: "command.session.export.description",
    category: "session",
    scope: SA,
    slash: { name: "export", args: "none" },
  },
  {
    id: "session.move",
    titleKey: "command.session.move.title",
    descriptionKey: "command.session.move.description",
    category: "session",
    scope: S,
    slash: { name: "move", args: "none" },
  },
  {
    id: "session.btw",
    titleKey: "command.session.btw.title",
    descriptionKey: "command.session.btw.description",
    category: "session",
    scope: S,
    slash: { name: "btw", args: "required" },
  },
  {
    id: "model.list",
    titleKey: "command.model.list.title",
    descriptionKey: "command.model.list.description",
    category: "model",
    scope: HS,
    slash: { name: "model", args: "none" },
  },
  {
    id: "agent.list",
    titleKey: "command.agent.list.title",
    descriptionKey: "command.agent.list.description",
    category: "model",
    scope: HS,
    slash: { name: "agent", args: "none" },
  },
  {
    id: "agent.subagents",
    titleKey: "command.agent.subagents.title",
    descriptionKey: "command.agent.subagents.description",
    category: "model",
    scope: SA,
    slash: { name: "agents", args: "none" },
  },
  {
    id: "config.open",
    titleKey: "command.config.open.title",
    descriptionKey: "command.config.open.description",
    category: "config",
    scope: HSA,
    slash: { name: "config", aliases: ["settings"], args: "none" },
  },
  {
    id: "config.permissions",
    titleKey: "command.config.permissions.title",
    descriptionKey: "command.config.permissions.description",
    category: "config",
    scope: HS,
    slash: { name: "permissions", args: "none" },
  },
  {
    id: "theme.switch",
    titleKey: "command.theme.switch.title",
    descriptionKey: "command.theme.switch.description",
    category: "config",
    scope: HSA,
    slash: { name: "theme", args: "none" },
  },
  {
    id: "mcp.list",
    titleKey: "command.mcp.list.title",
    descriptionKey: "command.mcp.list.description",
    category: "config",
    scope: HS,
    slash: { name: "mcp", args: "none" },
  },
  {
    id: "prompt.skills",
    titleKey: "command.prompt.skills.title",
    descriptionKey: "command.prompt.skills.description",
    category: "config",
    scope: S,
    slash: { name: "skills", args: "none" },
  },
  {
    id: "provider.connect",
    titleKey: "command.provider.connect.title",
    descriptionKey: "command.provider.connect.description",
    category: "config",
    scope: HS,
    slash: { name: "connect", args: "none" },
  },
  {
    id: "workspace.set",
    titleKey: "command.workspace.set.title",
    descriptionKey: "command.workspace.set.description",
    category: "config",
    scope: HS,
    slash: { name: "warp", args: "none" },
    enabled: () => Flag.GRAPHAGENT_WORKSPACES,
  },
  {
    id: "workspace.list",
    titleKey: "command.workspace.list.title",
    descriptionKey: "command.workspace.list.description",
    category: "config",
    scope: HS,
    slash: { name: "workspaces", args: "none" },
    enabled: () => Flag.GRAPHAGENT_WORKSPACES,
  },
  {
    id: "session.drawer.toggle",
    titleKey: "command.session.drawer.toggle.title",
    descriptionKey: "command.session.drawer.toggle.description",
    category: "view",
    scope: SA,
    slash: { name: "sidebar", args: "none" },
  },
  {
    id: "diff.open",
    titleKey: "command.diff.open.title",
    descriptionKey: "command.diff.open.description",
    category: "view",
    scope: S,
    slash: { name: "diff", args: "none" },
  },
  {
    id: "prompt.editor",
    titleKey: "command.prompt.editor.title",
    descriptionKey: "command.prompt.editor.description",
    category: "view",
    scope: HS,
    slash: { name: "editor", args: "none" },
  },
  {
    id: "dag.open",
    titleKey: "command.dag.open.title",
    descriptionKey: "command.dag.open.description",
    category: "workflow",
    scope: SA,
    slash: { name: "dag", args: "none" },
  },
  {
    id: "hooks.list",
    titleKey: "command.hooks.list.title",
    descriptionKey: "command.hooks.list.description",
    category: "workflow",
    scope: S,
    slash: { name: "hooks", args: "none" },
  },
  {
    id: "graphagent.status",
    titleKey: "command.graphagent.status.title",
    descriptionKey: "command.graphagent.status.description",
    category: "system",
    scope: HSA,
    slash: { name: "status", args: "none" },
  },
  {
    id: "help.show",
    titleKey: "command.help.show.title",
    descriptionKey: "command.help.show.description",
    category: "system",
    scope: HSA,
    slash: { name: "help", args: "none" },
  },
  {
    id: "app.exit",
    titleKey: "command.app.exit.title",
    descriptionKey: "command.app.exit.description",
    category: "system",
    scope: HSA,
    slash: { name: "exit", aliases: ["quit", "q"], args: "none" },
  },
  {
    id: "app.debug",
    titleKey: "command.app.debug.title",
    descriptionKey: "command.app.debug.description",
    category: "debug",
    scope: HSA,
  },
  {
    id: "app.console",
    titleKey: "command.app.console.title",
    descriptionKey: "command.app.console.description",
    category: "debug",
    scope: HSA,
  },
  {
    id: "app.heap_snapshot",
    titleKey: "command.app.heap_snapshot.title",
    descriptionKey: "command.app.heap_snapshot.description",
    category: "debug",
    scope: HSA,
  },
]
