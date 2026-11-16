// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG safety guard (#1031 M7): the `AskAdjudicator` for unattended runs.
 *
 * DAG node attempts and task children of a DAG-on root never reach the user,
 * so every permission request they produce is adjudicated here after the deny
 * rules have already won, in this order:
 *
 * 1. SF-6: a `forced` ask (a hook `ask`, an MCP tool that requires user
 *    interaction) needs a human nobody can fetch, so it is denied. No allow
 *    lifts it, the user's own included.
 * 2. A user-written allow (`rule.explicit`: a concrete pattern on the checked
 *    permission key; role/default allows and whole-key wildcards such as
 *    `bash: "allow"` never count) settles the pattern as allowed.
 * 3. A match in the built-in list (SF-1..5) or in `dag.safety.extra` (SX-n)
 *    denies the call. The node receives a tool error carrying the rule and
 *    keeps running; no permission request, no second wake.
 * 4. Everything else, including the ask the rules produced, is allowed.
 *
 * The list is a net for the mistakes of an honest agent, not a security
 * boundary (there is no sandbox). It decides from structured facts only: the
 * permission key, the paths native tools hand over, which tool raised an
 * `external_directory` request, the doom_loop detector, `forced`, and literal
 * Wildcard tables over one simple command. It never interprets shell command
 * text, so whatever the spelling of a command hides (`env X=1 git reset
 * --hard`, `bash -c '...'`, redirects, `cat .env`) is outside its reach by
 * design; stronger cover is a `deny` rule, `dag.safety.extra`, or a command
 * guard hook.
 *
 * `dag.safety.extra` is read from the global layer only, which
 * `Config.dagGlobal()` already enforces; it can add denies, never allows.
 *
 * The decision for a denied DAG-node call is also published as the durable
 * `dag.node.safety_denied` event, projected into the node row for `inspect`,
 * coverage and the reports. Task children have no node row, so their denial
 * only becomes the tool result.
 */
export * as SafetyGuard from "./safety-guard"

import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { containsPath, type InstanceContext } from "@/project/instance-context"
import { Skill } from "@/skill"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { FSUtil } from "@graphagent/core/fs-util"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Global } from "@graphagent/core/global"
import { Wildcard } from "@graphagent/core/util/wildcard"
import { DagEvent } from "@graphagent/schema/dag-event"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AskAdjudicator, type DecideInput, type Decision } from "./ask-adjudicator"
import { isRecord } from "@/util/record"

/** One global `dag.safety.extra` entry. */
export interface SafetyRule {
  readonly permission: string
  readonly pattern: string
  readonly reason?: string
}

export interface Violation {
  readonly ruleID: string
  readonly label: string
  readonly reason: string
}

export interface EvaluateInput {
  readonly permission: string
  /** The single pattern being evaluated. */
  readonly pattern: string
  readonly metadata: Record<string, unknown> | undefined
  /** A `force` ask: a hook `permissionDecision: "ask"` or an MCP tool that requires user interaction. */
  readonly forced: boolean
  /** Action of the rule that matched this pattern. */
  readonly ruleAction: "allow" | "ask"
  /** True only when the winning allow is one the user wrote, for this permission key, with a concrete pattern. */
  readonly explicit: boolean
  /** Fallback base for relative paths when there is no project instance. */
  readonly cwd: string
  /** Project boundary; absent means writes cannot be proven inside and are denied. */
  readonly instance: InstanceContext | undefined
  /** Temp/skill/reference directories the agent defaults already allow. */
  readonly allowRoots: readonly string[]
  readonly extra: readonly SafetyRule[]
}

const SF_1 = "SF-1"
const SF_2 = "SF-2"
const SF_3 = "SF-3"
const SF_4 = "SF-4"
const SF_5 = "SF-5"
const SF_6 = "SF-6"

const FINAL =
  "Do not retry this call; choose another approach, or complete the rest of your task and mention this in your final response."

/** `metadata.tool` of the `external_directory` requests the shell tool raises. */
const SHELL_TOOL = "bash"

/**
 * SF-3 and SF-4 are data, not parsers: each entry is a Wildcard over the text
 * of one simple command, matched the way a `dag.safety.extra` pattern is (a
 * trailing ` *` also matches the bare command). Anything that changes the text
 * of the command is not matched on purpose.
 */
const DESTRUCTIVE: readonly string[] = [
  "git reset --hard*",
  "git reset * --hard*",
  "git clean *",
  "git push*--force*",
  "git push* -f *",
  "sudo *",
  "shutdown *",
  "reboot *",
  "mkfs*",
  "dd * of=/dev/*",
]
const PUBLISHING: readonly string[] = [
  "npm publish *",
  "pnpm publish *",
  "yarn publish *",
  "yarn npm publish *",
  "cargo publish *",
  "docker push *",
  "gh release *",
  "gh pr merge *",
]

const ENV_TEMPLATE = /\.env\.(example|sample|template)$/i
const envSensitive = (base: string) => (base.endsWith(".env") || base.includes(".env.")) && !ENV_TEMPLATE.test(base)
const PRIVATE_KEY = /\.(pem|key|p12|pfx)$/i
const SSH_KEY = /^id_(rsa|ed25519|ecdsa)/i
const CREDENTIAL_FILES = new Set([".npmrc", ".netrc", ".pgpass", ".git-credentials"])

/** The sensitive-file category a path belongs to, or undefined. */
export function sensitiveCategory(target: string): string | undefined {
  const normalized = target.replaceAll("\\", "/")
  const lower = normalized.toLowerCase()
  const base = path.posix.basename(lower)
  const segments = lower.split("/")
  if (envSensitive(base)) return "environment file"
  if (PRIVATE_KEY.test(base)) return "private key material"
  if (SSH_KEY.test(base)) return "SSH private key"
  if (segments.includes(".ssh")) return "SSH directory"
  if (lower.endsWith("/.aws/credentials")) return "AWS credentials"
  if (CREDENTIAL_FILES.has(base)) return "credential file"
  if (lower.endsWith("/.docker/config.json")) return "Docker credentials"
  if (lower.endsWith("/.kube/config")) return "Kubernetes config"
  if (normalized === "/etc/shadow") return "system password file"
  if (normalized.startsWith("/etc/sudoers")) return "sudoers file"
  return undefined
}

const slashes = (text: string) => (process.platform === "win32" ? text.replaceAll("\\", "/") : text)

/**
 * Resolve a literal tool-provided path. Native tools supply filesystem paths,
 * not shell words: `user's-guide.md` and `users.$userId.tsx` are plain names,
 * with no quote decoding, expansion or glob interpretation. Empty is unknowable.
 */
function literalPath(raw: string, base: string): string | undefined {
  const text = slashes(raw.trim())
  if (text === "") return undefined
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(base, text)
}

const GLOB_META = /[*?[]/
const KEY_EXTENSIONS = ["pem", "key", "p12", "pfx"] as const

/** Glob segment to regex. `*` and `?` never cross `/`; `[...]` classes pass through. */
function segmentGlob(pattern: string) {
  let out = "^"
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? ""
    if (char === "*") out += "[^/]*"
    else if (char === "?") out += "[^/]"
    else if (char === "[") {
      const close = pattern.indexOf("]", index + 1)
      if (close < 0) {
        out += "\\["
        continue
      }
      let body = pattern.slice(index + 1, close)
      if (body.startsWith("!")) body = "^" + body.slice(1)
      // An empty class (`[]`, `[!]`) is not a valid regular expression.
      if (body === "" || body === "^") out += "\\["
      else out += `[${body.replaceAll("\\", "\\\\")}]`
      index = close
    } else out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(out + "$", "i")
}

/** True when the pattern can spell a leading dot (literally or through a bracket class). */
function dotLeading(pattern: string) {
  if (pattern.startsWith(".")) return true
  if (!pattern.startsWith("[")) return false
  const close = pattern.indexOf("]")
  return close > 0 && pattern.slice(1, close).includes(".")
}

/** A glob does not match a leading dot unless the pattern spells one. */
function matchesSegment(pattern: string, name: string) {
  if (name.startsWith(".") && !dotLeading(pattern)) return false
  return segmentGlob(pattern).test(name)
}

const firstGlob = (pattern: string) => {
  for (let index = 0; index < pattern.length; index++) if ("*?[".includes(pattern[index] ?? "")) return index
  return pattern.length
}

/** Brace alternatives (`*.{pem,key}`) that ripgrep globs accept. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{")
  if (open < 0) return [pattern]
  const close = pattern.indexOf("}", open + 1)
  if (close < 0) return [pattern]
  const options = pattern.slice(open + 1, close).split(",")
  if (options.length < 2) return [pattern]
  const head = pattern.slice(0, open)
  const tail = pattern.slice(close + 1)
  return options.flatMap((option) => expandBraces(`${head}${option}${tail}`)).slice(0, 16)
}

/**
 * Sensitive category a file selection (grep `include`) can select, exact names
 * included. A glob like `*.pem` must not pass just because the directory it
 * searches is innocent.
 */
function sensitiveSelection(selected: string, cwd: string): string | undefined {
  for (const pattern of expandBraces(selected)) {
    const glob = sensitiveGlobOne(pattern, cwd)
    if (glob) return glob
    if (!GLOB_META.test(pattern)) {
      const target = literalPath(pattern, cwd)
      const category = target === undefined ? undefined : sensitiveCategory(target)
      if (category) return category
    }
  }
  return undefined
}

function sensitiveGlobOne(raw: string, cwd: string): string | undefined {
  const text = slashes(raw)
  if (!GLOB_META.test(text)) return undefined
  // Resolve `..`/relative spellings before the fixed-path checks; glob
  // characters survive `path.resolve`, so the pattern stays a pattern.
  const lower = (path.isAbsolute(text) ? text : path.resolve(cwd, text)).toLowerCase()
  const segments = lower.split("/")
  const base = segments.at(-1) ?? ""
  const dirs = segments.slice(0, -1)

  // A literal `.env`, unless the literal suffix after the wildcard is a known
  // template (`.env.example`); `.env.example*` could still select
  // `.env.example.local`, so it stays sensitive.
  const literal = base.replaceAll("[.]", ".")
  const first = firstGlob(literal)
  const literalTail = first < literal.length ? literal.slice(first + 1) : literal
  if (literal.includes(".env") && !ENV_TEMPLATE.test(literalTail)) return "environment file"
  if (dotLeading(base) && matchesSegment(base, ".env")) return "environment file"

  const dot = base.lastIndexOf(".")
  const extension = dot >= 0 ? base.slice(dot + 1) : ""
  if (extension !== "" && KEY_EXTENSIONS.some((name) => matchesSegment(extension, name))) return "private key material"
  if (base.includes("id_")) return "SSH private key"
  if ([...CREDENTIAL_FILES].some((name) => matchesSegment(base, name))) return "credential file"
  if (dirs.some((dir) => matchesSegment(dir, ".ssh"))) return "SSH directory"
  if (dirs.some((dir) => matchesSegment(dir, ".aws")) && matchesSegment(base, "credentials")) return "AWS credentials"
  if (dirs.some((dir) => matchesSegment(dir, ".docker")) && matchesSegment(base, "config.json"))
    return "Docker credentials"
  if (dirs.some((dir) => matchesSegment(dir, ".kube")) && matchesSegment(base, "config")) return "Kubernetes config"

  const full = segmentGlob(lower)
  if (full.test("/etc/shadow")) return "system password file"
  if (full.test("/etc/sudoers") || full.test("/etc/sudoers.d/x")) return "sudoers file"
  return undefined
}

/** Inside the project, or inside a directory the agent defaults already allow. */
function inside(input: EvaluateInput, target: string) {
  if (input.instance !== undefined && containsPath(target, input.instance)) return true
  return input.allowRoots.some((root) => FSUtil.contains(root, target))
}

const denial = (ruleID: string, label: string, reason: string): Violation => ({ ruleID, label, reason })

/** A command's text as a label: one line, bounded. */
const labelOf = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

/** The tool error the deny decision becomes, once the seam prefixes `dag_safety:<rule>`. */
function wording(violation: Violation) {
  return `Denied by DAG safety rule ${violation.ruleID} (${violation.label}): ${violation.reason}. ${FINAL}`
}

const writeOutside = (target: string) => `writes outside the project are not allowed in workflow nodes: ${target}`
const credentialRead = (category: string, target: string) =>
  `reading credential files is not allowed in workflow nodes (${category}): ${target}`

/** Move destinations an apply_patch carries; the source is already a permission pattern. */
function editMoveTargets(metadata: Record<string, unknown> | undefined): string[] {
  const files = metadata?.files
  if (!Array.isArray(files)) return []
  const out: string[] = []
  for (const file of files) {
    if (!isRecord(file) || file.type !== "move") continue
    if (typeof file.movePath === "string" && file.movePath !== "") out.push(file.movePath)
  }
  return out
}

/** SF-1 (a): edit, write and apply_patch targets, move destinations included. */
function editViolation(input: EvaluateInput): Violation | undefined {
  const base = input.instance?.worktree ?? input.cwd
  const target = literalPath(input.pattern, base)
  if (target === undefined) return denial(SF_1, "edit", `cannot determine the write target of "${input.pattern}"`)
  if (!inside(input, target)) return denial(SF_1, "edit", writeOutside(target))
  // apply_patch names only the source in the permission patterns; a move
  // writes its destination, so that path must pass the same boundary.
  for (const raw of editMoveTargets(input.metadata)) {
    const moved = literalPath(raw, base)
    if (moved === undefined) return denial(SF_1, "apply_patch move", `cannot determine the move target of "${raw}"`)
    if (!inside(input, moved)) return denial(SF_1, "apply_patch move", writeOutside(moved))
  }
  return undefined
}

/** SF-1 (b): the shell reaches outside the project and no default allow covers the directory. */
function shellDirectoryViolation(input: EvaluateInput): Violation | undefined {
  // Only the shell tool is judged here: a native tool's external_directory
  // request is not a write signal, its write is judged under SF-1 (a) and its
  // read under SF-2. The shell cannot tell the two apart, so it counts as one.
  if (input.metadata?.tool !== SHELL_TOOL || input.ruleAction !== "ask") return undefined
  return denial(
    SF_1,
    "external_directory",
    `${writeOutside(input.pattern)}; shell commands that reach outside the project count as writes, use the read tool to read files there`,
  )
}

/** SF-2 for `read`: the pattern is the file path. */
function readViolation(input: EvaluateInput): Violation | undefined {
  const target = literalPath(input.pattern, input.instance?.worktree ?? input.cwd)
  if (target === undefined) return undefined
  const category = sensitiveCategory(target)
  return category ? denial(SF_2, "read", credentialRead(category, target)) : undefined
}

/**
 * SF-2 for `grep` and `glob`: the searched `metadata.path` and, for grep, the
 * `metadata.include` selection. The permission pattern is a search regex or a
 * file-name glob, not a path, so it is never judged.
 */
function searchViolation(input: EvaluateInput): Violation | undefined {
  // grep/glob resolve their `path` against the working directory, not the worktree root.
  const directory = input.instance?.directory ?? input.cwd
  const raw = typeof input.metadata?.path === "string" ? input.metadata.path : undefined
  const target = raw === undefined ? undefined : literalPath(raw, directory)
  const include =
    input.permission === "grep" && typeof input.metadata?.include === "string" ? input.metadata.include : undefined
  if (include) {
    const selection = sensitiveSelection(include, target ?? directory)
    if (selection) return denial(SF_2, input.permission, credentialRead(selection, include))
  }
  if (target === undefined) return undefined
  const category = sensitiveCategory(target)
  return category ? denial(SF_2, input.permission, credentialRead(category, target)) : undefined
}

/** SF-3 and SF-4: the literal tables over one simple command. */
function commandViolation(input: EvaluateInput): Violation | undefined {
  if (DESTRUCTIVE.some((pattern) => Wildcard.match(input.pattern, pattern)))
    return denial(SF_3, labelOf(input.pattern), "destructive command")
  if (PUBLISHING.some((pattern) => Wildcard.match(input.pattern, pattern)))
    return denial(
      SF_4,
      labelOf(input.pattern),
      "publishing is a decision for the main agent and the user; commit locally and report instead",
    )
  return undefined
}

function extraViolation(input: EvaluateInput) {
  for (const [index, rule] of input.extra.entries()) {
    if (!Wildcard.match(input.permission, rule.permission)) continue
    if (!Wildcard.match(input.pattern, rule.pattern)) continue
    return denial(`SX-${index + 1}`, `${rule.permission}:${rule.pattern}`, rule.reason ?? "configured DAG safety rule")
  }
  return undefined
}

function builtinViolation(input: EvaluateInput): Violation | undefined {
  switch (input.permission) {
    case "doom_loop":
      return denial(
        SF_5,
        "doom_loop",
        "the same tool call was repeated three times without progress; repeating it will not change the result",
      )
    case "edit":
      return editViolation(input)
    case "external_directory":
      return shellDirectoryViolation(input)
    case "read":
      return readViolation(input)
    case "grep":
    case "glob":
      return searchViolation(input)
    case "bash":
      return commandViolation(input)
    default:
      return undefined
  }
}

/**
 * Pure adjudication of one pattern. The caller resolves the project instance
 * and the whitelist roots; symlink resolution needs the filesystem and lives in
 * `symlinkViolation`.
 */
export function evaluate(input: EvaluateInput): Violation | undefined {
  // SF-6 comes first and nothing lifts it: nobody can answer this call.
  if (input.forced)
    return denial(SF_6, input.permission, "this call requires user confirmation, which workflow nodes cannot obtain")
  if (input.explicit) return undefined
  return builtinViolation(input) ?? extraViolation(input)
}

/** Real path of the nearest existing ancestor plus the not-yet-created components. */
async function realPathOf(target: string): Promise<string | undefined> {
  let current = path.resolve(target)
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail.reverse())
    } catch (error) {
      // Only a missing component may be appended blindly. Permission errors
      // and symlink loops leave the real location unproven, so deny.
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined
      const parent = path.dirname(current)
      if (parent === current) return undefined
      tail.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * Real path of a target with symlinks followed before `..` applies, the way
 * the kernel resolves it. `path.resolve` folds `..` lexically instead, so
 * with `link` pointing outside the project, `link/../victim` names the
 * victim beside the link target, not beside `link`. A missing component is
 * appended literally: the nearest existing ancestor is the best proof
 * available, and a call through a nonexistent component fails on its own.
 * Any other error (permissions, symlink loops) leaves the real location
 * unproven, so the caller denies.
 */
async function physicalPathOf(target: string, cwd: string): Promise<string | undefined> {
  const parsed = path.parse(target)
  const absolute = parsed.root !== ""
  let current: string
  if (absolute) current = parsed.root
  else {
    const base = await fs.realpath(path.resolve(cwd)).catch(() => undefined)
    if (base === undefined) return undefined
    current = base
  }
  const rest = absolute ? target.slice(parsed.root.length) : target
  for (const component of rest.split(path.sep)) {
    if (component === "" || component === ".") continue
    // `current` is already a real path, so its parent is the physical parent.
    if (component === "..") {
      current = path.dirname(current)
      continue
    }
    const next = path.join(current, component)
    try {
      current = await fs.realpath(next)
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined
      current = next
    }
  }
  return current
}

/** Physical target of a native tool path; native paths are literal, not shell words. */
async function nativePhysicalPath(raw: string, base: string) {
  const text = slashes(raw.trim())
  if (text === "") return undefined
  return physicalPathOf(text, base)
}

async function realRootsOf(input: EvaluateInput): Promise<string[]> {
  const roots = [input.instance?.directory, input.instance?.worktree, ...input.allowRoots].filter(
    (root): root is string => typeof root === "string" && root !== "" && root !== "/",
  )
  const real = await Promise.all(roots.map((root) => realPathOf(root)))
  return [...new Set(real.filter((root): root is string => root !== undefined))]
}

/**
 * A read whose real target is sensitive even though its spelling is not:
 * `read public.txt` where `public.txt` links to `.env` reads the environment
 * file the lexical check already refuses by name. A missing file makes the
 * tool fail on its own; there is nothing to leak.
 */
async function sensitiveLinkViolation(raw: string, base: string, label: string) {
  const real = await nativePhysicalPath(raw, base)
  if (real === undefined) return undefined
  const category = sensitiveCategory(real)
  return category ? denial(SF_2, label, credentialRead(category, `${real} (through a symlink)`)) : undefined
}

/**
 * A lexical boundary check cannot see symlinks. Resolve the existing path
 * components and refuse an edit whose real location leaves every allowed
 * root, and a read, grep or glob whose real target is a sensitive file. New
 * files are covered through their nearest existing parent.
 */
export async function symlinkViolation(
  input: EvaluateInput,
  options: { readonly moves?: boolean } = {},
): Promise<Violation | undefined> {
  if (input.forced || input.explicit) return undefined
  if (input.permission === "read")
    return sensitiveLinkViolation(input.pattern, input.instance?.worktree ?? input.cwd, "read symlink")
  if (input.permission === "grep" || input.permission === "glob") {
    const raw = input.metadata?.path
    if (typeof raw !== "string") return undefined
    return sensitiveLinkViolation(raw, input.instance?.directory ?? input.cwd, `${input.permission} symlink`)
  }
  if (input.permission !== "edit") return undefined

  const base = input.instance?.worktree ?? input.cwd
  const roots = await realRootsOf(input)
  const raws = [input.pattern, ...(options.moves === false ? [] : editMoveTargets(input.metadata))]
  for (const raw of raws) {
    const target = literalPath(raw, base)
    // Lexical escapes already fail SF-1; only apparently-inside targets need
    // the deeper resolution.
    if (target === undefined || !inside(input, target)) continue
    // Resolve the raw spelling physically: symlinks are followed before `..`
    // applies, unlike the lexical `path.resolve` above.
    const real = await nativePhysicalPath(raw, base)
    if (real === undefined)
      return denial(SF_1, "symlink write", `cannot resolve the write target through symlinks: ${target}`)
    if (!roots.some((root) => FSUtil.contains(root, real)))
      return denial(SF_1, "symlink write", `${writeOutside(real)} (through a symlink)`)
  }
  return undefined
}

/** Local `references` entries are writable whitelist roots, like `agent.ts`. */
export function referenceRoots(value: { readonly references?: unknown; readonly reference?: unknown }, root: string) {
  const out: string[] = []
  const entries = [value.references, value.reference].filter(isRecord)
  for (const record of entries) {
    for (const entry of Object.values(record)) {
      const raw =
        typeof entry === "string" ? entry : isRecord(entry) && typeof entry.path === "string" ? entry.path : undefined
      if (!raw) continue
      if (!(raw.startsWith(".") || raw.startsWith("/") || raw.startsWith("~"))) continue
      out.push(
        raw.startsWith("~/")
          ? path.join(os.homedir(), raw.slice(2))
          : path.isAbsolute(raw)
            ? raw
            : path.resolve(root, raw),
      )
    }
  }
  return out
}

function summaryOf(violation: Violation) {
  const text = `${violation.ruleID} ${violation.label}: ${violation.reason}`
  return text.length > 200 ? `${text.slice(0, 197)}...` : text
}

export const layer = Layer.effect(
  AskAdjudicator.Service,
  Effect.gen(function* () {
    const decide = (input: DecideInput): Effect.Effect<Decision> =>
      Effect.gen(function* () {
        const metadata = input.request.metadata as Record<string, unknown> | undefined
        const instance = yield* InstanceRef
        const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
        const extra = config
          ? (((yield* config.dagGlobal()).safety?.extra as readonly SafetyRule[] | undefined) ?? [])
          : []
        const skill = Option.getOrUndefined(yield* Effect.serviceOption(Skill.Service))
        const skillDirs = skill ? yield* skill.dirs().pipe(Effect.orElseSucceed(() => [] as string[])) : []
        const references = config
          ? yield* config
              .get()
              .pipe(
                Effect.map((value) => referenceRoots(value, instance?.root ?? instance?.directory ?? process.cwd())),
              )
              .pipe(Effect.orElseSucceed(() => [] as string[]))
          : []

        const request: EvaluateInput = {
          permission: input.request.permission,
          pattern: input.pattern,
          metadata,
          forced: input.forced,
          ruleAction: input.rule.action,
          explicit: input.rule.explicit,
          cwd: instance?.directory ?? process.cwd(),
          instance,
          allowRoots: [Global.Path.tmp, TRUNCATION_DIR, ...skillDirs, ...references],
          extra,
        }
        // Symlink resolution runs only when the lexical checks found nothing.
        // Move targets are checked once per ask, not once per permission pattern.
        const violation =
          evaluate(request) ??
          (yield* Effect.promise(() =>
            symlinkViolation(request, { moves: input.request.patterns[0] === input.pattern }),
          ).pipe(Effect.orElseSucceed(() => undefined)))
        if (!violation) return "allow" as const

        if (input.owner.kind === "dag_node") {
          const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service))
          // A malformed internal owner must not turn the guard into a defect;
          // the decision still denies, only the audit row is skipped.
          const dagID = Schema.decodeUnknownOption(DagEvent.DagID)(input.owner.workflowID)
          if (events && Option.isSome(dagID))
            yield* events
              .publish(DagEvent.NodeSafetyDenied, {
                dagID: dagID.value,
                nodeID: DagEvent.NodeID.make(input.owner.nodeID),
                attempt: Math.max(0, Math.trunc(input.owner.attempt)),
                ruleID: violation.ruleID,
                permission: input.request.permission,
                summary: summaryOf(violation),
                timestamp: yield* DateTime.now,
              })
              .pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.logWarning("DAG safety denial could not be recorded", { ruleID: violation.ruleID, cause }),
                ),
              )
        }
        return { deny: { ruleID: violation.ruleID, reason: wording(violation) } } as const
      })
    return AskAdjudicator.Service.of({ decide })
  }),
)

export const defaultLayer = layer
export const node = LayerNode.make(layer, [])
