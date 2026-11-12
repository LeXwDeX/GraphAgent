<!--
  Built-in skill. Name and description are registered in code at
  packages/graphagent/src/skill/builtin/index.ts. The body below becomes the
  skill's content.
-->

# Customizing GraphAgent

GraphAgent validates its own config strictly and refuses to start when a field
is wrong. The shapes below cover the common surface area, but they are a
**summary, not the source of truth**.

## Full schema reference

The authoritative list of every config option — with field types, enums,
defaults, and descriptions — lives in the published JSON Schema:

**<https://raw.githubusercontent.com/LeXwDeX/GraphAgent/main/schema/config.json>**

If a field is not documented in this skill, or you need to confirm an exact
shape before writing config, **fetch that URL and read the schema directly**
rather than guessing. GraphAgent hard-fails on invalid config, so the cost of a
wrong shape is a broken startup.

Independently, every `graphagent.json` should declare
`"$schema": "https://raw.githubusercontent.com/LeXwDeX/GraphAgent/main/schema/config.json"` so the user's editor catches
mistakes as they type.

## Applying changes

Config is loaded once when GraphAgent starts and is not hot-reloaded. After
saving changes to `graphagent.json`, an agent file, a skill, or any
other config-time file, **tell the user to quit and restart GraphAgent** for
the changes to take effect. The running session will keep using the
already-loaded config until then.

## Where files live

| Scope                         | Path                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project config                | `.agents/settings.json` (shared) and `.agents/settings.local.json` (local overrides) — GraphAgent walks up from the cwd to the nearest `.agents/` directory to find the project root |
| Global config                 | `~/.config/graphagent/graphagent.json` or `~/.config/graphagent/graphagent.jsonc` (NOT `~/.agents/`)                                                                                 |
| Project MCP servers           | `.agents/mcp.json`                                                                                                                                                                   |
| Global MCP servers            | `~/.config/graphagent/mcp.json` (`$GRAPHAGENT_CONFIG_DIR/mcp.json` when set)                                                                                                         |
| Project agents                | `.agents/agents/<name>.md`                                                                                                                                                           |
| Global agents                 | `~/.config/graphagent/agents/<name>.md`                                                                                                                                              |
| Project commands              | `.agents/commands/<name>.md`                                                                                                                                                         |
| Global commands               | `~/.config/graphagent/commands/<name>.md`                                                                                                                                            |
| Project skills                | `.agents/skills/<name>/SKILL.md`                                                                                                                                                     |
| Global skills                 | `~/.config/graphagent/skills/<name>/SKILL.md`                                                                                                                                        |
| External skills (auto-loaded) | `~/.agents/skills/<name>/SKILL.md`                                                                                                                                                   |

Configs from each scope are deep-merged. Project overrides global. Unknown
top-level keys in `graphagent.json` are rejected with `ConfigInvalidError`.

## Project trust

Executable entries in the project layer (`.agents/`) take effect only after the
user confirms them in `/trust`: MCP servers in `.agents/mcp.json`, hooks,
formatter and LSP commands in project settings, hooks in agent and skill
frontmatter, and embedded shell in command files and skill bodies. After writing
or changing such entries, tell the user to review them with `/trust`. User-level
config under `~/.config/graphagent/` and an untracked `.agents/settings.local.json`
are the user's own and skip this step.

Two limits matter when authoring:

- A top-level `shell` in project settings (`.agents/settings.json`, or a tracked
  `settings.local.json`) cannot be trusted: it is ignored and the default shell
  is used. Put `shell` in user-level config instead.
- A skill that `skills.paths` or `skills.urls`, declared in project settings
  (`.agents/settings.json` or `settings.local.json`, tracked or not), brings in
  from outside `.agents/skills/` cannot be reviewed in `/trust`: its frontmatter
  hooks are never registered, and its embedded shell is refused (with a `/trust`
  hint) when it runs as a slash command, hooks or not. Keep skills that need
  hooks or embedded shell under `.agents/skills/`. The same keys in user-level
  config stay the user's own wherever they point, so they are unaffected.

## graphagent.json

Every field is optional.

```json
{
  "$schema": "https://raw.githubusercontent.com/LeXwDeX/GraphAgent/main/schema/config.json",
  "username": "string",
  "model": "provider/model-id",
  "small_model": "provider/model-id",
  "default_agent": "agent-name",
  "shell": "/bin/zsh",
  "logLevel": "DEBUG" | "INFO" | "WARN" | "ERROR",
  "share": "manual" | "auto" | "disabled",
  "autoupdate": true | false | "notify",
  "snapshot": true,
  "instructions": ["AGENTS.md", "docs/style.md"],

  "skills": {
    "paths": [".agents/skills", "/abs/path/to/skills"],
    "urls": ["https://example.com/.well-known/skills/"]
  },

  "references": {
    "docs": {
      "path": "../docs",
      "description": "Use for product behavior and documentation conventions"
    },
    "sdk": {
      "repository": "owner/sdk",
      "branch": "main",
      "description": "Use for SDK implementation details",
      "hidden": true
    }
  },

  "agent": {
    "my-agent": {
      "model": "anthropic/claude-sonnet-4-6",
      "mode": "subagent",
      "description": "...",
      "permission": { "edit": "deny" }
    }
  },

  "command": {
    "deploy": { "description": "...", "template": "..." }
  },

  "provider": {
    "anthropic": { "options": { "apiKey": "..." } }
  },
  "disabled_providers": ["openai"],
  "enabled_providers": ["anthropic"],

  "permission": {
    "edit": "deny",
    "bash": { "git *": "allow", "*": "ask" }
  },

  "formatter": false,
  "lsp": false,

  "experimental": {
    "primary_tools": ["edit"]
  },

  "tool_output": { "max_lines": 200, "max_bytes": 8192 },

  "compaction": { "auto": true, "tail_turns": 15 }
}
```

Shape notes worth being explicit about:

- `model` always carries a provider prefix: `"anthropic/claude-sonnet-4-6"`.
- `skills` is an object with `paths` and/or `urls`, not an array.
- `references` is an object keyed by alias. Each value is a local path, Git repository, or string shorthand.
- `agent` is an object keyed by agent name, not an array.
- `command` is an object keyed by command name, not an array.
- MCP servers do not belong in this file: put them in `mcp.json` under a top-level `mcpServers` map (see MCP servers).
- `permission` is either a string action or an object keyed by tool name.

## Skills

GraphAgent's skill loader scans for `**/SKILL.md` inside skill directories. The
file is named `SKILL.md` exactly, and lives in its own folder named after the
skill:

```
.agents/skills/my-skill/SKILL.md
```

Frontmatter:

```markdown
---
name: my-skill
description: One sentence covering what this skill does AND when to trigger it. Front-load the literal keywords or filenames the user is likely to say.
---

# My Skill

(skill body in markdown: instructions, examples, references)
```

- For portable skill authoring, require a lowercase hyphen-separated `name`, up to 64 chars, matching the folder name. The directory-based runtime loader requires a string name but does not enforce these naming conventions. Treat successful loading as separate from compliance with the authoring rules.
- `description` is effectively required: skills without one are filtered out and never surfaced to the model. Cover both _what_ the skill does and _when_ to use it. Write in third person ("Use when...", not "I help with..."). Front-load concrete trigger keywords and filenames; gate with "Use ONLY when..." if the skill should stay quiet on adjacent topics.
- Optional: `license`, `compatibility`, `metadata` (string-string map).

Register skills from non-default locations via `skills.paths` (scanned
recursively for `**/SKILL.md`) and `skills.urls` (each URL serves a list of
skills). When project settings declare these keys, the skills they bring in
follow the limits in Project trust above.

## References

References make local directories and Git repositories outside the active
project available as supporting context. Configure them under `references`,
keyed by the alias used in `@` autocomplete:

```json
{
  "references": {
    "docs": {
      "path": "../product-docs",
      "description": "Use for product behavior and terminology"
    },
    "effect": {
      "repository": "Effect-TS/effect",
      "branch": "main",
      "description": "Use for Effect implementation details"
    }
  }
}
```

Local `path` values may be relative to the declaring config, absolute, or use
`~/`. Git `repository` values accept Git URLs, host/path references, and GitHub
`owner/repo` shorthand; `branch` is optional. Both forms support optional
`description` and `hidden` fields.

- Only references with a `description` are advertised to agents in system context.
- `hidden: true` removes a reference from TUI `@` autocomplete only. It remains available to agents and by direct path.
- Reference directories are automatically allowed through the external-directory boundary; normal read/edit/tool permissions still apply.
- String shorthand is supported: use `"docs": "../docs"` for local paths or `"effect": "Effect-TS/effect"` for Git repositories.

## Agents

Two ways to define an agent. Use the file form for anything non-trivial.

### Inline (in `graphagent.json`)

```json
{
  "agent": {
    "my-reviewer": {
      "description": "Reviews PRs for style violations.",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-6",
      "permission": { "edit": "deny", "bash": "ask" },
      "prompt": "You are a strict PR reviewer..."
    }
  }
}
```

### File

```
.agents/agent/my-reviewer.md      OR     .agents/agents/my-reviewer.md
```

```markdown
---
description: Reviews PRs for style violations.
mode: subagent
model: anthropic/claude-sonnet-4-6
permission:
  edit: deny
  bash: ask
---

You are a strict PR reviewer. Focus on...
```

The file body becomes the agent's `prompt`. Do not also put `prompt:` in the
frontmatter.

`mode` is one of `"primary"`, `"subagent"`, `"all"`.

Allowed top-level frontmatter fields: `name, model, variant, description, mode,
hidden, color, steps, options, permission, disable, temperature, top_p`. Any
unknown field is silently routed into `options`.

To disable a built-in agent: `agent: { build: { disable: true } }`, or in a
file, `disable: true` in frontmatter.

`default_agent` must point to a non-hidden, primary-mode agent.

### Built-in agents

GraphAgent ships with `build`, `plan`, `general`, `explore`. Hidden internal agents:
`compaction`, `title`, `summary`. To override a built-in's fields, define the
same key in `agent: { <name>: { ... } }`.

## Commands

GraphAgent's command loader scans for `**/*.md` inside command directories. The
file is named after the command, and lives directly inside the `command` folder:

```
.agents/command/deploy.md
```

Frontmatter:

```markdown
---
description: One sentence describing what the command does.
agent: build
model: anthropic/claude-sonnet-4-6
---

(command body in markdown: the prompt GraphAgent runs, with $ARGUMENTS for the user's input)
```

- `template` is the command body — everything below the frontmatter — and is required: it is the prompt GraphAgent runs when the command is invoked. Do not also put a `template:` key in the frontmatter.
- `$ARGUMENTS` is replaced with everything the user typed after the command; `$1`, `$2`, … pull individual positional arguments.
- Optional: `description`, `agent`, `model`, `variant`, `subtask`.

## MCP servers

MCP servers live in their own `mcp.json`, not in `graphagent.json`. A main
config that still contains an `mcp` key is rejected with an error pointing at
this file. The document accepts one top-level key, `mcpServers`, plus an
optional `$schema`:

```json
{
  "mcpServers": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"],
      "cwd": ".",
      "environment": { "BROWSER": "chromium" },
      "timeout": { "startup": 30000, "request": 30000 }
    },
    "github": {
      "type": "remote",
      "url": "https://...",
      "headers": { "Authorization": "Bearer ..." },
      "disabled": false
    }
  }
}
```

- Project layer: `.agents/mcp.json`; user layer:
  `~/.config/graphagent/mcp.json` (`$GRAPHAGENT_CONFIG_DIR/mcp.json` when set).
  The user file loads first, and a same-name project entry replaces the whole
  user entry; there is no field-level merge. `$HOME/.agents/mcp.json` is not
  read as a project layer.
- `type` is required and is `"local"` or `"remote"`.
- Local: `command` is an array of strings; optional `cwd`, `environment`,
  `disabled`, and `timeout`.
- Remote: `url` is required; optional `headers`, `oauth` (an object, or `false`
  to disable OAuth), `disabled`, and `timeout`.
- `timeout.startup` and `timeout.request` are milliseconds and default to
  30000 each.
- `disabled: true` turns a server off. The old `enabled` field is rejected.
- `protocol` is rejected; protocol negotiation is automatic. The removed
  `experimental.mcp_timeout` is replaced by per-server `timeout.request`.
- MCP entries are not interpolated: `{env:VAR}`, `{file:path}`, and `${VAR}`
  remain literal text.

## Permissions

```json
"permission": {
  "edit": "deny",
  "bash": { "git *": "allow", "rm *": "deny", "*": "ask" },
  "external_directory": { "~/secrets/**": "deny", "*": "allow" }
}
```

Actions: `"allow"`, `"ask"`, `"deny"`.

Per-tool value forms: `"allow"` shorthand (treated as `{"*": "allow"}`), or an
object `{ pattern: action }`. Within an object, **insertion order matters**.
GraphAgent evaluates the LAST matching rule, so put broad rules first and narrow
rules last.

`permission: "allow"` (a string at the top level) is shorthand for "allow
everything" and is rarely what the user wants.

Known permission keys: `read, edit, glob, grep, list, bash, task,
external_directory, todowrite, question, webfetch, websearch, lsp, doom_loop,
skill`. Some of these (`todowrite,
question, webfetch, websearch, doom_loop`) only accept a flat
action, not a per-pattern object.

`external_directory` patterns are filesystem paths (use `~/`, absolute paths,
or globs like `~/projects/**`).

Per-agent `permission:` overrides top-level `permission:`. Plan Mode lives on
the `plan` agent's permission ruleset (`edit: deny *`).

## Escape hatches

When a user's config is broken and GraphAgent won't start, these env vars help:

- `GRAPHAGENT_DISABLE_PROJECT_CONFIG=1`: skip the project's `.agents/settings.json`
  and `.agents/settings.local.json` and start from globals only. Run from the project
  directory, GraphAgent loads, the user edits the broken file, then they restart
  without the flag.
- `GRAPHAGENT_CONFIG=/path/to/file.json`: load an additional explicit config.
- `GRAPHAGENT_CONFIG_CONTENT='{"$schema":"https://raw.githubusercontent.com/LeXwDeX/GraphAgent/main/schema/config.json"}'`:
  inject inline JSON as a final local-scope merge.

## When proposing edits

- Validate against the schema before writing. If you are unsure of a field's
  exact shape, or the field is not covered in this skill, fetch
  `https://raw.githubusercontent.com/LeXwDeX/GraphAgent/main/schema/config.json` and read the schema rather than guessing.
- Preserve `$schema` and any existing fields the user did not ask to change.
- For agent, command, and skill definitions, prefer creating new files
  in the correct location over inlining everything in `graphagent.json`.
- If the user's existing config is malformed, point them at the env-var escape
  hatches above so they can edit from inside GraphAgent without breaking their
  session.
- After saving any config change, remind the user to quit and restart GraphAgent
  — running sessions keep using the already-loaded config.
