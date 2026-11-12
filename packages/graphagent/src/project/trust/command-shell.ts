// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Execution gate for inline `!`shell`` segments in slash commands.
 *
 * Command templates are expanded with `$ARGUMENTS` before their shell segments
 * run, so the segments about to execute are not necessarily the segments the
 * project file declares. The trust list fingerprints the declared segments, so
 * this gate compares the expanded segments against that declaration and lets
 * them run only when the text and order match and every declared entry is
 * trusted. A mismatch refuses the whole command before any shell starts.
 */
import { PROJECT_DIR } from "@graphagent/core/brand"
import { ConfigMarkdown } from "@graphagent/core/config/markdown"
import { Effect } from "effect"
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs"
import path from "node:path"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { shell as shellSegments } from "@/config/markdown"
import { isRecord } from "@/util/record"
import { commandFileEntries, settingsEntries, skillBodyEntries } from "./entries"
import type { GateEntry, GateResult, GateScope } from "./service"
import type { TrustEntry } from "./types"

export type ShellVerdict =
  | { readonly type: "allow" }
  | { readonly type: "refuse"; readonly reason: string }

export interface ShellGateInput {
  /** Project root (the directory holding `.agents/`). */
  readonly root: string
  /** Command name as invoked, without the leading slash. */
  readonly command: string
  /** The fully expanded template that is about to run. */
  readonly template: string
  /**
   * Set when `command` is a skill-promoted command: the backing skill's own
   * trust classification and SKILL.md path. `findDeclaration`'s skill branch
   * only walks `<root>/.agents/skills`; a project-owned skill reached some
   * other way (`skills.paths`/`skills.urls`) has no declaration it could ever
   * find there, so this is how `shellVerdict` fails closed on it instead of
   * running its body shell segments unchecked (#1040).
   */
  readonly skill?: { readonly source: "project" | "user" | "builtin" | undefined; readonly location: string }
}

interface Declaration {
  /** Path relative to `<root>/.agents`, POSIX separators. */
  readonly file: string
  readonly scope: GateScope
  /** Declared shell entries for this command, in file order. */
  readonly entries: readonly TrustEntry[]
}

const SETTINGS_FILES = ["settings.local.json", "settings.json"] as const

/**
 * A project command declaration wins over user/builtin commands in the merge
 * order (`commands/**` loads after the settings files). The first declaration
 * found here is therefore the one whose segments run.
 */
function findDeclaration(root: string, name: string): Declaration | undefined {
  const base = path.join(root, PROJECT_DIR)
  const relative = path.posix.normalize(`commands/${name}.md`)
  if (relative.startsWith("commands/") && !relative.split("/").includes("..")) {
    const file = path.join(base, ...relative.split("/"))
    const text = readText(file)
    const parsed = text === undefined ? undefined : parseFrontmatter(text)
    if (text !== undefined && parsed) {
      return { file: relative, scope: "project", entries: commandFileEntries(relative, text) }
    }
  }

  for (const file of SETTINGS_FILES) {
    const text = readText(path.join(base, file))
    if (text === undefined) continue
    const errors: ParseError[] = []
    const value = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length || !isRecord(value) || !isRecord(value.command)) continue
    const candidate = value.command[name]
    if (!isRecord(candidate) || typeof candidate.template !== "string") continue
    return {
      file,
      scope: file === "settings.local.json" ? "local" : "project",
      entries: settingsEntries(file, value).filter(
        (entry) => entry.category === "command-shell" && entry.label === name,
      ),
    }
  }

  // Config commands shadow builtins and skills by name, so a skill is only the
  // runtime source when neither a command file nor an inline setting declared
  // the name. Duplicate skill names resolve in path order, last one wins.
  let found: Declaration | undefined
  for (const file of walkSkillFiles(path.join(base, "skills")).toSorted()) {
    const text = readText(file.absolute)
    if (text === undefined) continue
    const parsed = parseFrontmatter(text)
    if (!parsed || parsed.data.name !== name || parsed.data.hidden === true) continue
    found = {
      file: file.relative,
      scope: "project",
      entries: skillBodyEntries(file.relative, text).filter(
        (entry) => entry.category === "command-shell" && entry.label === name,
      ),
    }
  }
  return found
}

function walkSkillFiles(
  dir: string,
  relative = "skills",
): Array<{ readonly absolute: string; readonly relative: string }> {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: Array<{ absolute: string; relative: string }> = []
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    const child = `${relative}/${entry.name}`
    if (entry.isDirectory()) files.push(...walkSkillFiles(absolute, child))
    else if (entry.isFile() && entry.name === "SKILL.md") files.push({ absolute, relative: child })
  }
  return files
}

function readText(file: string) {
  if (!existsSync(file)) return undefined
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function parseFrontmatter(text: string): ReturnType<typeof ConfigMarkdown.parse> | undefined {
  try {
    return ConfigMarkdown.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Decide whether the expanded shell segments of a command may run. Executes no
 * shell itself; callers refuse the whole command on `refuse`.
 */
export function shellVerdict(
  input: ShellGateInput,
  gate: (entries: readonly GateEntry[]) => Effect.Effect<GateResult>,
): Effect.Effect<ShellVerdict> {
  const declaration = findDeclaration(input.root, input.command)
  if (!declaration) {
    if (input.skill?.source !== "project") return Effect.succeed({ type: "allow" })
    // A project-owned skill the trust panel cannot enumerate: fail closed as
    // one "not enumerated" entry instead of running its shell segments with
    // no check at all. User/builtin skills, and commands with no backing
    // skill, keep allowing above.
    return gate([{ scope: "project", file: input.skill.location, entry: undefined }]).pipe(
      Effect.map((result): ShellVerdict =>
        result.allowed[0]
          ? { type: "allow" }
          : { type: "refuse", reason: "its skill is outside what the trust panel tracks." },
      ),
    )
  }
  const actual = segments(input.template)
  const declared = declaration.entries.map((entry) => entry.display.text)
  if (actual.length !== declared.length || actual.some((command, index) => command !== declared[index])) {
    return Effect.succeed({
      type: "refuse",
      reason: "the expanded shell segments do not match the project declaration.",
    })
  }
  return gate(declaration.entries.map((entry) => ({ scope: declaration.scope, file: declaration.file, entry }))).pipe(
    Effect.map((result): ShellVerdict =>
      result.allowed.every(Boolean)
        ? { type: "allow" }
        : { type: "refuse", reason: "its project shell segments are not trusted." },
    ),
  )
}

function segments(template: string) {
  return shellSegments(template)
    .map((match) => match[1]?.trim())
    .filter((command): command is string => command !== undefined && command.length > 0)
}