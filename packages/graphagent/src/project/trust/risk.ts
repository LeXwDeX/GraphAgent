// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Heuristic risk assessment for project-trust entries (T1 PR1).
 *
 * The rule table exists to inform the user and choose the panel's default
 * checkbox state. It is not a security boundary: commands can evade these
 * text heuristics. For that reason the rules return codes plus interpolation
 * values only; the display copy and the "nothing stood out" wording belong to
 * the panel PR and must never call an entry "safe".
 */
import type { EntryDisplay, HookKind, TrustCategory } from "./types"
import { shellTokens } from "./shell"

export type RiskLevel = "high" | "caution"

export const RISK_CODES = [
  // High: default unchecked in the panel.
  "download-and-execute",
  "send-local-file",
  "delete-outside-project",
  "startup-persistence",
  // Caution: checked by default, shown with a note.
  "package-runner",
  "reads-environment",
  "external-url",
  "remote-mcp",
  "sudo",
] as const
export type RiskCode = (typeof RISK_CODES)[number]

export interface Risk {
  code: RiskCode
  level: RiskLevel
  /** Interpolation value for the display copy (variable names, runner, URL). */
  detail?: string
}

/** The subset of a trust entry the rules need. `TrustEntry` satisfies it. */
export interface RiskTarget {
  category: TrustCategory
  kind?: HookKind
  mcpType?: "local" | "remote"
  display: Pick<EntryDisplay, "commands" | "urls" | "envKeys">
}

interface RuleContext {
  commands: readonly string[]
  urls: readonly string[]
  envKeys: readonly string[]
  text: string
}

interface RiskMatch {
  detail?: string
}

interface RiskRule {
  code: RiskCode
  level: RiskLevel
  detect: (context: RuleContext, target: RiskTarget) => RiskMatch | undefined
}

const DOWNLOAD_AND_EXECUTE = [
  // curl/wget piped into an interpreter.
  /\b(?:curl|wget)\b[^|\n;]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|ash|python[0-9.]*|node|perl|ruby|php)\b/i,
  // PowerShell download cradle.
  /\b(?:iwr|invoke-webrequest|invoke-restmethod)\b[^|\n;]*\|\s*(?:iex|invoke-expression)\b/i,
  /\b(?:iex|invoke-expression)\s*\(\s*(?:iwr|invoke-webrequest|invoke-restmethod|curl)\b/i,
]

const SEND_LOCAL_FILE = [
  // curl form/data flags reading a local file via `@`.
  /\bcurl\b[^\n]*(?:-d|--data|--data-binary|--data-raw|-F|--form)\s*@/i,
  // Upload flags always name a local file.
  /\bcurl\b[^\n]*(?:-T\b|--upload-file)\b/i,
  /\bscp\b/i,
  /(?:^|[\s|;&])n(?:c|cat)\b/i,
  /\brsync\b[^\n]*(?:@[^\s:]+:|::)/i,
]

const PACKAGE_RUNNER = /\b(?:npx|bunx|pnpx|uvx)\b|\bpnpm\s+dlx\b|\byarn\s+dlx\b|\bpipx\s+run\b/i

const ENV_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g

const URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s"'`<>]+/i

const STARTUP_FILE =
  /(?:>>?|tee\s+(?:-a\s+)?)\s*(?:(?:~|\$HOME)\/)?(?:\.bashrc|\.bash_profile|\.bash_login|\.profile|\.zshrc|\.zprofile|\.zshenv)\b/
const FISH_STARTUP_FILE = /(?:>>?|tee\s+(?:-a\s+)?)\s*(?:(?:~|\$HOME)\/)?\.config\/fish\/config\.fish\b/

/** Ordered rule table: high-risk rules first, then caution rules. */
export const RISK_RULES: readonly RiskRule[] = [
  {
    code: "download-and-execute",
    level: "high",
    detect: ({ text }) => (DOWNLOAD_AND_EXECUTE.some((pattern) => pattern.test(text)) ? {} : undefined),
  },
  {
    code: "send-local-file",
    level: "high",
    detect: ({ text }) => (SEND_LOCAL_FILE.some((pattern) => pattern.test(text)) ? {} : undefined),
  },
  {
    code: "delete-outside-project",
    level: "high",
    detect: ({ commands }) => (commands.some(deletesOutsideProject) ? {} : undefined),
  },
  {
    code: "startup-persistence",
    level: "high",
    detect: ({ text }) => {
      if (/\bcrontab\b/.test(text) && !/\bcrontab\s+-l\b/.test(text)) return {}
      if (/\b(?:launchctl|systemctl)\b/.test(text)) return {}
      if (STARTUP_FILE.test(text) || FISH_STARTUP_FILE.test(text)) return {}
      return undefined
    },
  },
  {
    code: "package-runner",
    level: "caution",
    detect: ({ text }) => {
      const match = text.match(PACKAGE_RUNNER)
      return match ? { detail: match[0] } : undefined
    },
  },
  {
    code: "reads-environment",
    level: "caution",
    detect: (context) => {
      const names = environmentNames(context)
      return names.length ? { detail: names.join(", ") } : undefined
    },
  },
  {
    code: "external-url",
    level: "caution",
    detect: ({ commands, urls }) => {
      const found = [...urls, ...commands.flatMap((command) => command.match(URL_PATTERN) ?? [])]
      return found.length ? { detail: found[0] } : undefined
    },
  },
  {
    code: "remote-mcp",
    level: "caution",
    detect: (_context, target) => (target.category === "mcp" && target.mcpType === "remote" ? {} : undefined),
  },
  {
    code: "sudo",
    level: "caution",
    detect: ({ text }) => (/\b(?:sudo|doas)\b/.test(text) ? {} : undefined),
  },
]

/** Assess one entry. Each rule runs at most once and contributes one risk. */
export function assessRisk(target: RiskTarget): Risk[] {
  const context: RuleContext = {
    commands: target.display.commands,
    urls: target.display.urls,
    envKeys: target.display.envKeys,
    text: target.display.commands.join("\n"),
  }
  const risks: Risk[] = []
  for (const rule of RISK_RULES) {
    const match = rule.detect(context, target)
    if (!match) continue
    risks.push({ code: rule.code, level: rule.level, ...(match.detail ? { detail: match.detail } : {}) })
  }
  return risks
}

function environmentNames(context: RuleContext): string[] {
  const names = new Set(context.envKeys.filter((name) => name.length > 0))
  for (const command of context.commands)
    for (const match of command.matchAll(ENV_REFERENCE)) {
      const name = match[1] ?? match[2]
      if (name) names.add(name)
    }
  return [...names].toSorted()
}

/**
 * `rm` whose first non-flag argument is clearly outside the project: an
 * absolute path, the filesystem root, `~`/`$HOME`, or a `..` traversal. A
 * command whose `rm` is just an argument to another program is ignored.
 */
function deletesOutsideProject(command: string): boolean {
  return command.split(/[;&|\n]/).some((segment) => {
    const tokens = shellTokens(segment)
    const position = tokens.indexOf("rm")
    if (position === -1) return false
    const prefix = tokens.slice(0, position)
    if (!prefix.every((token) => token.startsWith("-") || token === "sudo")) return false
    return tokens.slice(position + 1).some(isOutsideTarget)
  })
}

function isOutsideTarget(token: string): boolean {
  if (token.startsWith("-")) return false
  if (token === "/" || token.startsWith("/*")) return true
  if (token === "~" || token.startsWith("~/")) return true
  if (token === "$HOME" || token.startsWith("$HOME/")) return true
  if (token.startsWith("/")) return true
  return token === ".." || token.startsWith("../")
}
