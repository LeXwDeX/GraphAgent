// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG safety guard (#1031 M7): the `AskAdjudicator` for unattended runs.
 *
 * DAG node attempts and task children of a DAG-on root never reach the user,
 * so every ask they produce is adjudicated here after the deny rules have
 * already won:
 *
 * 1. A user-written allow (`rule.explicit`) settles the pattern as allowed;
 *    role/default wildcard allows are not explicit and never bypass the list.
 * 2. A match in the built-in safety list (SF-1..5) or in `dag.safety.extra`
 *    (SX-n) denies the call. The node receives a tool error carrying the rule
 *    and keeps running; no permission request, no second wake.
 * 3. Everything else — including the ask the rules produced — is allowed.
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
import { Git } from "@/git"
import { containsPath, type InstanceContext } from "@/project/instance-context"
import { Skill } from "@/skill"
import { ShellParse } from "@/tool/shell/parse"
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

/** Git facts a `git push` decision needs. */
export interface GitState {
  readonly branch?: string
  readonly defaultBranch?: string
  readonly remotes: readonly string[]
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
  /** True only when the winning allow is one the user wrote. */
  readonly explicit: boolean
  /** Directory the tool call runs in (bash `workdir` or the instance directory). */
  readonly cwd: string
  /** Project boundary; absent means writes cannot be proven inside and are denied. */
  readonly instance: InstanceContext | undefined
  /** Temp/skill/reference directories the agent defaults already allow. */
  readonly allowRoots: readonly string[]
  readonly extra: readonly SafetyRule[]
  /** Git facts of `cwd`; the layer resolves them lazily, only for pushes. */
  readonly git: GitState | undefined
  /** Facts of repositories reached through `git -C`, keyed by resolved directory. */
  readonly gitStates?: ReadonlyMap<string, GitState | undefined>
  /** Directories statically proven to exist; a `cd` elsewhere may fail and keep the old cwd. */
  readonly knownDirectories?: ReadonlySet<string>
  /** Parsed bash command; absent for non-shell permissions. */
  readonly segments: readonly ShellParse.Segment[] | undefined
}

const SF_1 = "SF-1"
const SF_2 = "SF-2"
const SF_3 = "SF-3"
const SF_4 = "SF-4"
const SF_5 = "SF-5"

const FINAL =
  "Do not retry this call; choose another approach, or complete the rest of your task and mention this in your final response."

const ENV_TEMPLATE = /\.env\.(example|sample|template)$/i
const envSensitive = (base: string) => (base.endsWith(".env") || base.includes(".env.")) && !ENV_TEMPLATE.test(base)
const PRIVATE_KEY = /\.(pem|key|p12|pfx)$/i
const SSH_KEY = /^id_(rsa|ed25519|ecdsa)/i
const CREDENTIAL_FILES = new Set([".npmrc", ".netrc", ".pgpass", ".git-credentials"])
// Positional (`$1`) and special (`$@`, `$*`, `$#`, `$?`, `$$`, `$!`, `$-`)
// parameters are dynamic too: `set -- ../victim; tee "$1"` names whatever the
// shell was given, not a literal file name.
const DYNAMIC = /\$\(|`|\$\{|\$[A-Za-z_0-9@*#?$!-]/
const GLOB = /[*?[]/
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const SAFE_REDIRECTS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"])

/**
 * Decode one static shell word: adjacent quoted and unquoted fragments plus
 * backslash escapes (`..'/'victim` is `../victim`, `.e'n'v` is `.env`).
 * Returns undefined for a malformed word (unterminated quote), which callers
 * treat as an unknowable target.
 */
export function decodeWord(raw: string): string | undefined {
  let out = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index] ?? ""
    if (quote === "'") {
      if (char === "'") quote = undefined
      else out += char
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined
        continue
      }
      if (char === "\\" && index + 1 < raw.length) {
        const next = raw[index + 1] ?? ""
        // In double quotes only these characters are escaped by a backslash.
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          out += next
          index++
          continue
        }
        out += char
        continue
      }
      out += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "\\" && index + 1 < raw.length) {
      out += raw[++index]
      continue
    }
    out += char
  }
  return quote === undefined ? out : undefined
}

/** Static word expansion plus the home forms the guard already understands. */
function expandDecoded(raw: string): string | undefined {
  const text = decodeWord(raw)
  if (text === undefined) return undefined
  if (text === "~") return os.homedir()
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2))
  if (text === "$HOME") return os.homedir()
  if (text.startsWith("$HOME/")) return path.join(os.homedir(), text.slice(6))
  return text
}

/** Best-effort display expansion (a malformed word keeps its unquoted spelling). */
function expand(raw: string) {
  return expandDecoded(raw) ?? ShellParse.unquote(raw)
}

/** Resolve one shell word to a project-checkable path; `dynamic` is unknowable. */
export function resolveTarget(raw: string, cwd: string): { path?: string; dynamic: boolean } {
  const expanded = expandDecoded(raw)
  // An unexpanded home of another user (`~name`) is not a project path.
  if (expanded === undefined || expanded === "" || expanded.startsWith("~") || DYNAMIC.test(expanded))
    return { dynamic: true }
  const glob = GLOB.exec(expanded)
  const literal = glob ? expanded.slice(0, glob.index) : expanded
  const absolute = path.isAbsolute(literal) ? literal : path.resolve(cwd, literal)
  return { path: glob ? path.dirname(absolute) : absolute, dynamic: false }
}

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

/** Resolve a literal tool-provided path; glob characters are file-name bytes. */
function concreteTarget(raw: string, cwd: string): { path?: string; dynamic: boolean } {
  const expanded = expandDecoded(raw)
  if (expanded === undefined || expanded === "" || expanded.startsWith("~") || DYNAMIC.test(expanded))
    return { dynamic: true }
  return { path: path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded), dynamic: false }
}

/**
 * Resolve a native tool path. These permissions carry filesystem paths, not
 * shell words: `user's-guide.md` and `users.$userId.tsx` are literal names,
 * with no quote decoding, expansion or glob interpretation.
 */
function nativeTarget(raw: string, cwd: string): { path?: string; dynamic: boolean } {
  const text = raw.trim()
  if (text === "") return { dynamic: true }
  const normalized = process.platform === "win32" ? text.replaceAll("\\", "/") : text
  return { path: path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(cwd, normalized), dynamic: false }
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

/** Bash does not match a leading dot unless the pattern spells one. */
function matchesSegment(pattern: string, name: string) {
  if (name.startsWith(".") && !dotLeading(pattern)) return false
  return segmentGlob(pattern).test(name)
}

const firstGlob = (pattern: string) => {
  for (let index = 0; index < pattern.length; index++) if ("*?[".includes(pattern[index] ?? "")) return index
  return pattern.length
}

/** Brace alternatives (`*.{pem,key}`) that ripgrep and bash globs accept. */
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
 * Sensitive-file category a glob spelling can select. `cat .env*` and
 * `keys/*.pem` must not slip past SF-2 just because the resolver strips the
 * wildcard and reports the parent directory.
 */
export function sensitiveGlob(raw: string, cwd: string): string | undefined {
  for (const pattern of expandBraces(raw)) {
    const category = sensitiveGlobOne(pattern, cwd)
    if (category) return category
  }
  return undefined
}

/** Sensitive category selected by a tool glob/include, exact names included. */
function sensitiveSelection(selected: string, cwd: string): string | undefined {
  for (const pattern of expandBraces(selected)) {
    const glob = sensitiveGlobOne(pattern, cwd)
    if (glob) return glob
    if (!GLOB_META.test(pattern)) {
      const category = sensitiveCategory(resolveTarget(pattern, cwd).path ?? pattern)
      if (category) return category
    }
  }
  return undefined
}

function sensitiveGlobOne(raw: string, cwd: string): string | undefined {
  const expanded = (expandDecoded(raw) ?? expand(raw)).replaceAll("\\", "/")
  if (!GLOB_META.test(expanded)) return undefined
  // Resolve `..`/relative spellings before the fixed-path checks; glob
  // characters survive `path.resolve`, so the pattern stays a pattern.
  const lower = (path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded)).toLowerCase()
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
  if (extension !== "" && KEY_EXTENSIONS.some((name) => matchesSegment(extension, name)))
    return "private key material"
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

function inside(input: EvaluateInput, target: string) {
  if (inProject(input, target)) return true
  return input.allowRoots.some((root) => FSUtil.contains(root, target))
}

/** The project boundary alone; the destructive list never trusts a whitelist. */
function inProject(input: EvaluateInput, target: string) {
  return input.instance !== undefined && containsPath(target, input.instance)
}

const denial = (ruleID: string, label: string, reason: string): Violation => ({ ruleID, label, reason })
const sf1 = (label: string, reason: string) => denial(SF_1, label, reason)
const sf2 = (label: string, reason: string) => denial(SF_2, label, reason)
const sf3 = (label: string, reason: string) => denial(SF_3, label, reason)
const sf4 = (label: string, reason: string) => denial(SF_4, label, reason)

/** The tool error the deny decision becomes, once the seam prefixes `dag_safety:<rule>`. */
function wording(violation: Violation) {
  return `Denied by DAG safety rule ${violation.ruleID} (${violation.label}): ${violation.reason}. ${FINAL}`
}

/** Strip leading `NAME=value` assignments; they are not part of the command. */
function commandArgs(argv: readonly string[]) {
  let index = 0
  while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index] ?? "")) index++
  return argv.slice(index)
}

const isFlag = (value: string) => value.startsWith("-") && value !== "-"
const isShortFlag = (value: string) => isFlag(value) && !value.startsWith("--")
const words = (argv: readonly string[]) => argv.filter((value) => !isFlag(value))

/** `/bin/rm`, `'rm'` and `rm` must reach the same checks; other platforms' separators too. */
function commandName(argv: readonly string[]) {
  const raw = argv[0] ?? ""
  // Windows-style executables keep backslashes as separators (`C:\bin\rm`).
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\"))
    return path.posix.basename(raw.replaceAll("\\", "/")).toLowerCase()
  // Shell quoting and escapes are not part of the executable: `'cat'`,
  // `"cat"`, `c'a't` and `\c\a\t` all run `cat`.
  const text = decodeWord(raw) ?? raw.replaceAll("'", "").replaceAll('"', "")
  return path.posix.basename(text.replaceAll("\\", "/")).toLowerCase()
}

/** Documented options of one execution wrapper (`env`, `nice`, ...). */
interface WrapperSpec {
  /** Options that consume a value, e.g. `--unset NAME` and `-u NAME`. */
  readonly longValues?: readonly string[]
  readonly shortValues?: readonly string[]
  /** Options that consume nothing. */
  readonly longFlags?: readonly string[]
  readonly shortFlags?: readonly string[]
  /** Options that only query or signal a process, so no command runs. */
  readonly terminal?: readonly string[]
  /** `NAME=VALUE` words belong to the wrapper itself (env). */
  readonly assignments?: boolean
  /** A bare numeric option is the value (`nice -5`). */
  readonly numericValue?: boolean
  /** Called for every value the wrapper consumes; env uses `-C` to move cwd. */
  readonly onValue?: (option: string, value: string) => void
}

interface WrapperCommand {
  /** The command the wrapper runs; empty when it runs none. */
  readonly argv: readonly string[]
  readonly terminal: boolean
  /** An option this guard cannot interpret; it may hide the command. */
  readonly unknown?: string
}

/**
 * Consume one wrapper's documented options. The first remaining word starts
 * the wrapped command. An option outside the documented set may consume the
 * command or run something else, so it is reported instead of guessed.
 */
function wrapperCommand(args: readonly string[], spec: WrapperSpec): WrapperCommand {
  const longValues = new Set(spec.longValues ?? [])
  const longFlags = new Set(spec.longFlags ?? [])
  const shortValues = new Set(spec.shortValues ?? [])
  const shortFlags = new Set(spec.shortFlags ?? [])
  const terminal = new Set(spec.terminal ?? [])
  let index = 0
  while (index < args.length) {
    const token = args[index] ?? ""
    if (token === "--") return { argv: args.slice(index + 1), terminal: false }
    if (spec.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index++
      continue
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=")
      const header = equals >= 0 ? token.slice(0, equals) : token
      if (terminal.has(header)) return { argv: [], terminal: true }
      if (longValues.has(header)) {
        const value = equals >= 0 ? token.slice(equals + 1) : args[index + 1]
        if (value === undefined) return { argv: [], terminal: false, unknown: header }
        spec.onValue?.(header, value)
        index += equals >= 0 ? 1 : 2
        continue
      }
      if (longFlags.has(token)) {
        index++
        continue
      }
      return { argv: [], terminal: false, unknown: token }
    }
    if (token.startsWith("-") && token !== "-") {
      // `nice -5` spells its adjustment as a bare number.
      if (spec.numericValue && /^-\d+$/.test(token)) {
        index++
        continue
      }
      const flags = token.slice(1)
      let step = 1
      for (let at = 0; at < flags.length; at++) {
        const flag = flags[at] ?? ""
        if (shortFlags.has(flag)) continue
        if (terminal.has(flag)) return { argv: [], terminal: true }
        if (shortValues.has(flag)) {
          // `-o0` attaches the value; `-o 0` takes the next word.
          const value = flags.length > at + 1 ? flags.slice(at + 1) : args[index + 1]
          if (value === undefined) return { argv: [], terminal: false, unknown: `-${flag}` }
          spec.onValue?.(`-${flag}`, value)
          if (flags.length === at + 1) step = 2
          break
        }
        return { argv: [], terminal: false, unknown: `-${flag}` }
      }
      index += step
      continue
    }
    return { argv: args.slice(index), terminal: false }
  }
  return { argv: [], terminal: true }
}

/** Prefix wrappers that launch the command in their own arguments. */
const EXECUTION_WRAPPERS = new Set([
  "env",
  "command",
  "exec",
  "nohup",
  "nice",
  "ionice",
  "timeout",
  "stdbuf",
  "time",
])

interface Execution {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly known: boolean
  /** Set when the wrapped command cannot be inspected statically. */
  readonly violation?: Violation
}

interface WrapperStep {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly known: boolean
  readonly violation?: Violation
}

const wrapperDenial = (name: string, detail: string) =>
  sf3(
    "execution wrapper",
    `cannot statically determine the command run through "${name}" (${detail}); unattended runs refuse execution they cannot inspect`,
  )

/** Unwrap one recognized prefix wrapper; the arguments are the wrapper's own. */
function unwrapOne(name: string, args: readonly string[], cwd: string, known: boolean): WrapperStep {
  let effective = cwd
  let effectiveKnown = known
  const move = (value: string) => {
    const resolved = resolveTarget(value, effective)
    const absolute = path.isAbsolute(expandDecoded(value) ?? "")
    if (resolved.dynamic || resolved.path === undefined) {
      effectiveKnown = false
      return
    }
    // Like `cd`: only an absolute target restores a directory after an
    // earlier unknown one; a relative one stays uncertain.
    if (!effectiveKnown && !absolute) return
    effective = resolved.path
    if (absolute) effectiveKnown = true
  }
  const step = (parsed: WrapperCommand): WrapperStep =>
    parsed.unknown === undefined
      ? { argv: parsed.argv, cwd: effective, known: effectiveKnown }
      : {
          argv: [],
          cwd: effective,
          known: effectiveKnown,
          violation: wrapperDenial(name, `unknown option "${parsed.unknown}"`),
        }
  switch (name) {
    case "env":
      return step(
        wrapperCommand(args, {
          longValues: ["--unset", "--chdir"],
          longFlags: ["--ignore-environment", "--null"],
          shortValues: ["u", "C"],
          shortFlags: ["i", "0"],
          assignments: true,
          onValue: (option, value) => {
            if (option === "-C" || option === "--chdir") move(value)
          },
        }),
      )
    case "command":
      return step(wrapperCommand(args, { shortFlags: ["p"], terminal: ["v", "V"] }))
    case "exec":
      return step(wrapperCommand(args, { shortValues: ["a"], shortFlags: ["c", "l"] }))
    case "nohup":
      return step(wrapperCommand(args, {}))
    case "nice":
      return step(wrapperCommand(args, { longValues: ["--adjustment"], shortValues: ["n"], numericValue: true }))
    case "ionice":
      return step(
        wrapperCommand(args, {
          longValues: ["--class", "--classdata"],
          longFlags: ["--ignore"],
          shortValues: ["c", "n"],
          shortFlags: ["t"],
          terminal: ["p", "--pid"],
        }),
      )
    case "stdbuf":
      return step(
        wrapperCommand(args, {
          longValues: ["--input", "--output", "--error"],
          shortValues: ["i", "o", "e"],
        }),
      )
    case "timeout": {
      const parsed = wrapperCommand(args, {
        longValues: ["--signal", "--kill-after"],
        longFlags: ["--foreground", "--preserve-status", "--verbose"],
        shortValues: ["s", "k"],
        shortFlags: ["v"],
      })
      const unwrapped = step(parsed)
      if (unwrapped.violation || parsed.terminal) return unwrapped
      // The first word after the options is the DURATION, never the command.
      return { argv: parsed.argv.slice(1), cwd: effective, known: effectiveKnown }
    }
    case "time": {
      const rest = args.slice()
      while (rest[0] === "-p" || rest[0] === "--portability") rest.shift()
      if (rest[0] === "--") rest.shift()
      // `-f`/`-o` write their own output file and take a value; the command
      // behind them cannot be located reliably.
      else if (rest[0] !== undefined && isFlag(rest[0]))
        return {
          argv: [],
          cwd: effective,
          known: effectiveKnown,
          violation: wrapperDenial(name, `option "${rest[0]}" can write its own file`),
        }
      return { argv: rest, cwd: effective, known: effectiveKnown }
    }
    default:
      return { argv: [], cwd: effective, known: effectiveKnown }
  }
}

/**
 * Strip the wrappers that only launch the command in their arguments, so the
 * classifiers see the executable that actually runs (`env rm -rf` is `rm`).
 * Depth is bounded; wrappers whose command cannot be read statically deny.
 */
function unwrapExecution(rawArgv: readonly string[], cwd: string, known: boolean): Execution {
  let current: readonly string[] = commandArgs(rawArgv)
  let effective = cwd
  let effectiveKnown = known
  for (let depth = 0; ; depth++) {
    const name = commandName(current)
    if (name === "eval")
      return {
        argv: [],
        cwd: effective,
        known: effectiveKnown,
        violation: wrapperDenial(name, "it executes a string this guard cannot read"),
      }
    if (name === "xargs")
      return {
        argv: [],
        cwd: effective,
        known: effectiveKnown,
        violation: wrapperDenial(name, "its arguments come from stdin"),
      }
    if (!EXECUTION_WRAPPERS.has(name)) return { argv: current, cwd: effective, known: effectiveKnown }
    if (depth >= 8)
      return {
        argv: [],
        cwd: effective,
        known: effectiveKnown,
        violation: wrapperDenial(name, "nested wrappers exceed the supported depth"),
      }
    const next = unwrapOne(name, current.slice(1), effective, effectiveKnown)
    effective = next.cwd
    effectiveKnown = next.known
    if (next.violation) return { argv: [], cwd: effective, known: effectiveKnown, violation: next.violation }
    current = next.argv
  }
}

/** Global options that take a value, from `git -h`; both `=` and a separate word. */
const GIT_VALUE_OPTIONS = new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
  "--attr-source",
  "--shallow-file",
])
/** Global options that shape which repository a subcommand reads or writes. */
const GIT_REPO_OPTIONS = new Set(["--git-dir", "--work-tree", "--namespace", "--bare"])
const GIT_BOOLEAN_OPTIONS = new Set([
  "--paginate",
  "--no-pager",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-advice",
  "--bare",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
])
const GIT_TERMINAL_OPTIONS = new Set(["--version", "--help", "--html-path", "--man-path", "--info-path"])
const GIT_SHORT_OPTIONS = new Set(["p", "P", "v", "h"])

interface GitInvocation {
  /** Subcommand after the global options, lowercased. */
  readonly name: string | undefined
  /** Arguments after the subcommand. */
  readonly args: readonly string[]
  /** Working directory after `-C` (relative options resolve cumulatively). */
  readonly cwd: string
  readonly cwdKnown: boolean
  /** An unrecognized global option hides the subcommand, so checks must not trust it. */
  readonly uncertain: boolean
  /** A global option that only prints information and exits. */
  readonly terminal: boolean
}

/**
 * Locate the subcommand behind git's global options. `git -C /repo reset
 * --hard` and `git -c k=v push` must reach the same checks as the plain form.
 */
function parseGit(argv: readonly string[], cwd: string, known = true): GitInvocation {
  let effective = cwd
  let cwdKnown = known
  let index = 1
  const result = (over: Partial<GitInvocation> = {}): GitInvocation => ({
    name: undefined,
    args: [],
    cwd: effective,
    cwdKnown,
    uncertain: false,
    terminal: false,
    ...over,
  })

  while (index < argv.length) {
    const token = argv[index] ?? ""
    if (token === "--") {
      index++
      break
    }
    if (token === "-C" || (token.startsWith("-C") && token.length > 2)) {
      const inline = token.length > 2
      const value = inline ? token.slice(2) : argv[index + 1]
      if (value === undefined) return result({ uncertain: true })
      index += inline ? 1 : 2
      const resolved = concreteTarget(value, effective)
      if (resolved.dynamic || resolved.path === undefined) cwdKnown = false
      else if (cwdKnown || path.isAbsolute(expandDecoded(value) ?? "")) {
        // An absolute -C names the repository regardless of an earlier
        // dynamic `cd`; a relative one does not.
        effective = resolved.path
        cwdKnown = true
      }
      continue
    }
    if (token === "-c" || (token.startsWith("-c") && token.length > 2)) {
      if (token.length > 2) {
        index++
        continue
      }
      if (index + 1 >= argv.length) return result({ uncertain: true })
      index += 2
      continue
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=")
      const header = equals >= 0 ? token.slice(0, equals) : token
      if (GIT_TERMINAL_OPTIONS.has(header) || header === "--list-cmds" || (header === "--exec-path" && equals < 0))
        return result({ terminal: true })
      if (GIT_VALUE_OPTIONS.has(header)) {
        if (GIT_REPO_OPTIONS.has(header)) cwdKnown = false
        if (equals < 0) {
          if (index + 1 >= argv.length) return result({ uncertain: true })
          index += 2
        } else index++
        continue
      }
      if (header === "--exec-path") {
        index++
        continue
      }
      if (GIT_BOOLEAN_OPTIONS.has(token)) {
        if (GIT_REPO_OPTIONS.has(token)) cwdKnown = false
        index++
        continue
      }
      // An unknown global option may consume the next word; the subcommand
      // can no longer be located reliably.
      return result({ uncertain: true })
    }
    if (isShortFlag(token)) {
      const flags = token.slice(1)
      for (const flag of flags) if (!GIT_SHORT_OPTIONS.has(flag)) return result({ uncertain: true })
      if (flags === "v" || flags.includes("h")) return result({ terminal: true })
      index++
      continue
    }
    // Subcommand arguments are quoted shell words; checks compare the value
    // the shell will pass to git, not the spelling with quotes.
    const name = decodeWord(token) ?? ShellParse.unquote(token)
    return result({
      name: name.toLowerCase(),
      args: argv.slice(index + 1).map((value) => decodeWord(value) ?? ShellParse.unquote(value)),
    })
  }
  return result()
}

/** Git facts for the directory a command actually operates in. */
function gitFor(input: EvaluateInput, cwd: string): GitState | undefined {
  const key = path.resolve(cwd)
  if (input.gitStates?.has(key)) return input.gitStates.get(key)
  if (key === path.resolve(input.cwd)) return input.git
  return undefined
}

function writeTarget(
  input: EvaluateInput,
  raw: string,
  cwd: string,
  known: boolean,
  label: string,
): Violation | undefined {
  const target = resolveTarget(raw, cwd)
  if (target.dynamic || target.path === undefined)
    return sf1(label, `cannot determine the write target of "${raw.trim()}"`)
  if (!known && !path.isAbsolute(expandDecoded(raw) ?? ""))
    return sf1(label, `cannot determine the working directory for "${raw.trim()}"`)
  if (!inside(input, target.path)) return sf1(label, `write target is outside the project: ${target.path}`)
  return undefined
}

function readTarget(input: EvaluateInput, raw: string, cwd: string, label: string): Violation | undefined {
  const glob = sensitiveGlob(raw, cwd)
  if (glob) return sf2(label, `reading a ${glob} is not allowed: ${expand(raw)}`)
  const target = resolveTarget(raw, cwd)
  if (target.dynamic || target.path === undefined) return undefined
  const category = sensitiveCategory(target.path)
  if (category) return sf2(label, `reading a ${category} is not allowed: ${target.path}`)
  return undefined
}

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

function redirectViolation(
  input: EvaluateInput,
  redirects: readonly ShellParse.Redirect[],
  cwd: string,
  known: boolean,
): Violation | undefined {
  for (const redirect of redirects) {
    if (redirect.op.startsWith("<<") && !redirect.op.startsWith("<<<")) continue
    // `<>` opens for read and write (and creates the file), so it needs both
    // checks; every other `<` form is a read only.
    if (redirect.op === "<>") {
      const read = readTarget(input, redirect.target, cwd, "shell read-write redirect")
      if (read) return read
      const write = writeTarget(input, redirect.target, cwd, known, "shell read-write redirect")
      if (write) return write
      continue
    }
    if (redirect.op.startsWith("<") && !redirect.op.startsWith("<<<")) {
      const violation = readTarget(input, redirect.target, cwd, "shell input redirect")
      if (violation) return violation
      continue
    }
    const expanded = expandDecoded(redirect.target) ?? expand(redirect.target)
    if (SAFE_REDIRECTS.has(expanded) || expanded.startsWith("/dev/fd/") || /^&\d+$/.test(expanded)) continue
    const violation = writeTarget(input, redirect.target, cwd, known, "shell output redirect")
    if (violation) return violation
  }
  return undefined
}

function matchesDefault(name: string, git: GitState | undefined) {
  return git?.defaultBranch ? name === git.defaultBranch : name === "main" || name === "master"
}

/** Destination branch of one push refspec, or undefined when it cannot be named. */
function refspecDestination(refspec: string, git: GitState | undefined) {
  let value = refspec.replace(/^\+/, "")
  const colon = value.indexOf(":")
  if (colon >= 0) {
    const source = value.slice(0, colon)
    const destination = value.slice(colon + 1)
    value = destination === "" ? source : destination
  }
  if (value === "HEAD") return git?.branch
  value = value.replace(/^refs\/heads\//, "")
  for (const remote of git?.remotes ?? []) {
    if (value.startsWith(`${remote}/`)) return value.slice(remote.length + 1)
  }
  return value
}

/** True when a refspec's source side is the current branch, spelled `HEAD`. */
function headRefspec(refspec: string) {
  const value = refspec.replace(/^\+/, "")
  const colon = value.indexOf(":")
  return (colon >= 0 ? value.slice(0, colon) : value) === "HEAD"
}

function pushViolation(
  input: EvaluateInput,
  argv: readonly string[],
  cwd: string,
  known: boolean,
  branchMutated = false,
): Violation | undefined {
  const invocation = parseGit(argv, cwd, known)
  if (invocation.uncertain || invocation.name !== "push") return undefined
  const args = invocation.args
  const facts = invocation.cwdKnown ? gitFor(input, invocation.cwd) : undefined
  // A preceding command in the same line (`git switch main && git push`) may
  // have moved HEAD. The facts were captured before execution, so the named
  // branch no longer proves what a bare push or a `HEAD` refspec publishes.
  const git = facts && branchMutated ? { ...facts, branch: undefined } : facts
  // Bulk selectors publish every branch or ref, including the default branch,
  // whatever the current branch or the explicit refs say. A wildcard refspec
  // (`refs/heads/*:refs/heads/*`) selects the same set as `--all`.
  const bulk = args.find(
    (arg) =>
      arg === "--all" ||
      arg === "--mirror" ||
      arg === "--branches" ||
      arg.startsWith("--branches=") ||
      arg === "--tags" ||
      arg === "--follow-tags" ||
      (!isFlag(arg) && arg.includes("*")),
  )
  if (bulk !== undefined)
    return sf4(
      "git push bulk refs",
      `"${bulk}" publishes or updates every branch/ref, including the default branch; push an explicit feature branch instead`,
    )
  const deleting = args.some((arg) => arg === "--delete" || arg === "-d")
  // `git push [<repository> [<refspec>...]]`: the first positional is the
  // repository whatever its spelling (configured remote, URL or path), so
  // only the later positionals are refspecs. `--repo` and the value-taking
  // options below move their value out of the positional list.
  let repositoryOption: string | undefined
  const positionals: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    if (arg === "--repo") {
      const next = args[index + 1]
      if (next !== undefined) {
        repositoryOption = next
        index++
      }
      continue
    }
    if (arg.startsWith("--repo=")) {
      repositoryOption = arg.slice("--repo=".length)
      continue
    }
    if (arg === "-o" || arg === "--push-option" || arg === "--receive-pack" || arg === "--exec") {
      index++
      continue
    }
    if (isFlag(arg)) continue
    positionals.push(arg)
  }
  const refs = repositoryOption !== undefined ? positionals : positionals.slice(1)

  if (refs.length === 0) {
    // `git push --delete <remote>` names no ref; git refuses it, so nothing
    // is removed and the bare-push release check does not apply.
    if (deleting) return undefined
    if (!git || git.branch === undefined)
      return sf4(
        "git push",
        "cannot determine the pushed branch of a bare git push; it could publish the default branch",
      )
    if (matchesDefault(git.branch, git))
      return sf4(
        "git push",
        `a bare git push publishes the default branch "${git.branch}"; push an explicit feature branch instead`,
      )
    return undefined
  }

  for (const ref of refs) {
    const destination = refspecDestination(ref, git)
    // `--delete` and the `:<ref>` refspec remove a remote ref. Removing the
    // default branch is destructive (SF-3); a feature ref stays allowed.
    const removes = deleting || /^\+?:/.test(ref)
    if (removes) {
      if (destination === undefined)
        return sf3("git push --delete", "cannot determine which remote ref the delete removes")
      if (matchesDefault(destination, git))
        return sf3(
          "git push --delete",
          `deleting the default branch "${destination}" is a destructive release action; delete a feature branch only`,
        )
      continue
    }
    if (destination === undefined) {
      // `HEAD` names the branch the push runs on; with the branch facts
      // invalidated, that branch could be the default branch.
      if (headRefspec(ref))
        return sf4("git push", "cannot determine the pushed branch of a HEAD push; it could publish the default branch")
      return undefined
    }
    if (matchesDefault(destination, git))
      return sf4(
        "git push",
        `pushing to the default branch "${destination}" is a release action; use a feature branch and let the parent merge`,
      )
  }
  return undefined
}

function destructiveViolation(input: EvaluateInput, argv: readonly string[], cwd: string, known: boolean) {
  const name = commandName(argv)
  const args = argv.slice(1)

  if (name === "rm") {
    const recursive = args.some((arg) => arg === "--recursive" || (isShortFlag(arg) && /[rR]/.test(arg)))
    if (!recursive) return undefined
    for (const target of words(args)) {
      const resolved = resolveTarget(target, cwd)
      if (resolved.dynamic || resolved.path === undefined)
        return sf3("rm -r", `cannot determine the recursive delete target of "${target.trim()}"`)
      if (
        resolved.path === path.parse(resolved.path).root ||
        resolved.path === os.homedir() ||
        !inProject(input, resolved.path)
      )
        return sf3("rm -r", `recursive delete outside the project: ${resolved.path}`)
    }
    return undefined
  }

  if (name === "git") {
    const invocation = parseGit(argv, cwd, known)
    // An unrecognized global option could hide `push`, `reset` or `clean`;
    // unattended runs refuse rather than guess.
    if (invocation.uncertain)
      return sf3("git global options", "cannot determine the git subcommand behind unrecognized global options")
    const sub = invocation.name
    const gitArgs = invocation.args
    if (sub === "push") {
      const forced = gitArgs.some(
        (arg) =>
          arg === "--force" ||
          arg === "-f" ||
          arg.startsWith("--force-with-lease") ||
          arg.startsWith("--force-if-includes") ||
          (arg.startsWith("+") && arg.length > 1),
      )
      if (forced)
        return sf3("git push --force", "force pushing rewrites remote history and can destroy other people's commits")
    }
    if (sub === "reset" && gitArgs.includes("--hard"))
      return sf3("git reset --hard", "a hard reset discards uncommitted work without recovery")
    if (sub === "clean" && gitArgs.some((arg) => arg === "--force" || (isShortFlag(arg) && /f/.test(arg))))
      return sf3("git clean -f", "git clean -f deletes untracked files with no recovery")
  }

  if (name === "chmod" || name === "chown") {
    const recursive = args.some((arg) => arg === "-R" || arg === "--recursive")
    if (!recursive) return undefined
    for (const target of words(args).slice(1)) {
      const resolved = resolveTarget(target, cwd)
      if (resolved.dynamic || resolved.path === undefined)
        return sf3(`${name} -R`, `cannot determine the recursive target of "${target.trim()}"`)
      if (resolved.path === path.parse(resolved.path).root || !inProject(input, resolved.path))
        return sf3(`${name} -R`, `recursive permission change outside the project: ${resolved.path}`)
    }
  }

  if (name === "dd" && args.some((arg) => arg.startsWith("of=/dev/")))
    return sf3("dd of=/dev/*", "writing raw bytes to a device can destroy the system disk")
  if (name.startsWith("mkfs")) return sf3(name, "formatting a filesystem destroys its contents")
  if (name === "sudo") return sf3("sudo", "unattended runs must not escalate privileges")
  if (name === "shutdown" || name === "reboot")
    return sf3(name, "powering off the host would kill every running workflow")
  if (name === "kill" && args.includes("-9") && args.includes("-1"))
    return sf3("kill -9 -1", "signalling every process on the host would kill the agent and its workflows")
  return undefined
}

function publishViolation(
  input: EvaluateInput,
  argv: readonly string[],
  cwd: string,
  known: boolean,
  branchMutated = false,
) {
  const name = commandName(argv)
  const args = argv.slice(1)
  if (["npm", "pnpm", "yarn"].includes(name) && args.includes("publish"))
    return sf4(`${name} publish`, "publishing a package is a release action; finish the work and ask the user to release")
  if (name === "docker" && (argv[1] ?? "").toLowerCase() === "push")
    return sf4("docker push", "pushing an image is a release action; ask the user to publish it")
  if (name === "gh") {
    const sub = (argv[1] ?? "").toLowerCase()
    if (sub === "release") return sf4("gh release", "creating or editing a release is a release action")
    if (sub === "pr" && (argv[2] ?? "").toLowerCase() === "merge")
      return sf4("gh pr merge", "merging a pull request is a delivery action owned by the main agent and the user")
  }
  if (name === "git") return pushViolation(input, argv, cwd, known, branchMutated)
  return undefined
}

/** One file a simple command reads, with the label used in the denial reason. */
interface ReadWord {
  readonly raw: string
  readonly label: string
}

/**
 * The files a simple command reads: reader arguments, grep/rg targets, cp
 * sources, curl `@file` inputs and input redirections. The lexical check and
 * the symlink pass share this list so both inspect the same words.
 */
function readTargetList(seg: ShellParse.Segment, argv: readonly string[]): ReadWord[] {
  const name = commandName(argv)
  const args = argv.slice(1)
  const out: ReadWord[] = []
  if (["cat", "less", "more", "head", "tail"].includes(name))
    for (const target of words(args)) out.push({ raw: target, label: name })
  if (name === "grep" || name === "rg") {
    let patternSeen = false
    let options = true
    for (let index = 0; index < args.length; index++) {
      const arg = args[index] ?? ""
      if (options && arg === "--") {
        options = false
        continue
      }
      if (options && arg.startsWith("--")) {
        const equals = arg.indexOf("=")
        const header = equals >= 0 ? arg.slice(0, equals) : arg
        if (header === "--regexp") {
          // The pattern is supplied here, so every positional is a file.
          patternSeen = true
          if (equals < 0) index++
          continue
        }
        if (header === "--file") {
          // A pattern file is read by grep itself; the positionals are files.
          patternSeen = true
          const value = equals >= 0 ? arg.slice(equals + 1) : args[index + 1]
          if (equals < 0) index++
          if (value !== undefined && value !== "") out.push({ raw: value, label: name })
          continue
        }
        continue
      }
      if (options && isFlag(arg)) {
        // A short bundle may carry `e`/`f`; the rest of the bundle or the next
        // word is that option's value. Other flags consume nothing here.
        const flags = arg.slice(1)
        const at = flags.search(/[ef]/)
        if (at < 0) continue
        patternSeen = true
        const attached = flags.slice(at + 1)
        if (attached !== "") {
          if (flags[at] === "f") out.push({ raw: attached, label: name })
          continue
        }
        const value = args[index + 1]
        index++
        if (flags[at] === "f" && value !== undefined) out.push({ raw: value, label: name })
        continue
      }
      if (!patternSeen) {
        patternSeen = true
        continue
      }
      out.push({ raw: arg, label: name })
    }
  }
  if (name === "cp") for (const target of words(args).slice(0, -1)) out.push({ raw: target, label: name })
  if (name === "curl") {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index] ?? ""
      const inline = /^--(?:data|data-binary|data-raw|data-urlencode|form)=@(.+)$/.exec(arg)
      if (inline) {
        out.push({ raw: inline[1] ?? "", label: "curl" })
        continue
      }
      if (["-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "-F", "--form"].includes(arg)) {
        const next = args[index + 1]
        if (next?.startsWith("@")) out.push({ raw: next.slice(1), label: "curl" })
        index++
      }
    }
  }
  for (const redirect of seg.redirects) {
    if (!redirect.op.startsWith("<") || redirect.op.startsWith("<<<")) continue
    out.push({ raw: redirect.target, label: "shell input redirect" })
  }
  return out
}

function sensitiveReadViolation(input: EvaluateInput, seg: ShellParse.Segment, argv: readonly string[], cwd: string) {
  for (const word of readTargetList(seg, argv)) {
    const violation = readTarget(input, word.raw, cwd, word.label)
    if (violation) return violation
  }
  return undefined
}

/** `-t`/`--target-directory` destinations, including their `=`/attached forms. */
function targetDirectories(args: readonly string[]) {
  const out: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    if (arg === "-t" || arg === "--target-directory") {
      const next = args[index + 1]
      if (next !== undefined) {
        out.push(next)
        index++
      }
      continue
    }
    if (arg.startsWith("--target-directory=")) out.push(arg.slice("--target-directory=".length))
    else if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
      // `-t` may be bundled with other flags (`-vt dir`, `-vtdir`).
      const at = arg.indexOf("t", 1)
      if (at < 0) continue
      const attached = arg.slice(at + 1)
      if (attached !== "") out.push(attached)
      else {
        const next = args[index + 1]
        if (next !== undefined) {
          out.push(next)
          index++
        }
      }
    }
  }
  return out
}

/** Long curl options whose value names a file curl writes. */
const CURL_FILE_OPTIONS = new Set([
  "--output",
  "--dump-header",
  "--cookie-jar",
  "--trace",
  "--trace-ascii",
  "--stderr",
])

/** Short curl options whose value names a file curl writes. */
const CURL_SHORT_FILE_OPTIONS = /[oDc]/

/** Files and directories a curl invocation writes, including remote-name output. */
function curlWriteTargets(args: readonly string[]): string[] {
  const targets: string[] = []
  let outputDir: string | undefined
  let remoteName = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    if (arg === "--") break
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=")
      const header = equals >= 0 ? arg.slice(0, equals) : arg
      if (header === "--output-dir") {
        const value = equals >= 0 ? arg.slice(equals + 1) : args[index + 1]
        if (equals < 0) index++
        // `-o` and `-O` resolve relative names against this directory.
        if (value !== undefined && value !== "") {
          outputDir = value
          targets.push(value)
        }
        continue
      }
      if (header === "--remote-name" || header === "--remote-name-all") {
        remoteName = true
        continue
      }
      if (CURL_FILE_OPTIONS.has(header)) {
        const value = equals >= 0 ? arg.slice(equals + 1) : args[index + 1]
        if (equals < 0) index++
        if (value !== undefined && value !== "") targets.push(value)
        continue
      }
      continue
    }
    if (!isShortFlag(arg)) continue
    // A short bundle may carry `o`, `D` or `c`; the rest of the bundle is the
    // attached value, otherwise the next word is.
    const flags = arg.slice(1)
    const at = flags.search(CURL_SHORT_FILE_OPTIONS)
    if (at < 0) continue
    const attached = flags.slice(at + 1)
    if (attached !== "") {
      targets.push(attached)
      continue
    }
    const value = args[index + 1]
    if (value !== undefined) {
      targets.push(value)
      index++
    }
  }
  // The remote file name is chosen by the server, but its directory decides
  // the boundary: a directory inside the project keeps every direct child
  // inside, a directory outside does not.
  if (remoteName) targets.push(outputDir ?? ".")
  return targets
}

/** The write destinations of one simple command, independent of evaluation. */
function writeTargetList(argv: readonly string[]): { targets: readonly string[]; label: string } | undefined {
  const name = commandName(argv)
  const args = argv.slice(1)
  const all = words(args)
  if (name === "rm") return { targets: all, label: "rm" }
  if (name === "tee") return { targets: all, label: "tee" }
  if (name === "curl") return { targets: curlWriteTargets(args), label: "curl" }
  // `mv` removes every source; each one mutates the filesystem. `cp` only
  // writes the destination (sources are reads). `-t` moves the destination
  // out of the trailing slot.
  if (name === "mv" || name === "cp") {
    const directories = targetDirectories(args)
    if (directories.length > 0)
      return { targets: name === "mv" ? [...all, ...directories] : directories, label: name }
    return { targets: name === "mv" ? all : all.slice(-1), label: name }
  }
  if (name === "ln") return { targets: all.slice(-1), label: "ln" }
  if (name === "chmod" || name === "chown") return { targets: all.slice(1), label: name }
  if (name === "sed" && args.some((arg) => arg === "--in-place" || arg.startsWith("-i"))) {
    const rest = args.filter((arg) => !isFlag(arg))
    return { targets: rest.slice(1), label: "sed -i" }
  }
  return undefined
}

function writeViolation(input: EvaluateInput, argv: readonly string[], cwd: string, known = true) {
  const list = writeTargetList(argv)
  if (!list) return undefined
  for (const target of list.targets) {
    const violation = writeTarget(input, target, cwd, known, list.label)
    if (violation) return violation
  }
  return undefined
}

/** One write destination of an ask, with the directory it resolves against. */
interface WritePath {
  readonly raw: string
  readonly cwd: string
  readonly known: boolean
}

/** Write destinations the lexical checks inspect; used again for symlink resolution. */
function writePaths(input: EvaluateInput, moves: boolean): WritePath[] {
  const base = input.instance?.worktree ?? input.cwd
  if (input.permission === "edit") {
    const paths: WritePath[] = [{ raw: input.pattern, cwd: base, known: true }]
    if (moves) for (const raw of editMoveTargets(input.metadata)) paths.push({ raw, cwd: base, known: true })
    return paths
  }
  if (input.permission !== "bash" || !input.segments) return []
  const paths: WritePath[] = []
  const functions = functionTable(input.segments)
  for (const context of segmentContexts(input.segments, input.cwd, input.knownDirectories, { functions })) {
    for (const redirect of context.segment.redirects) {
      // `<` is a read, but `<>` also writes (and creates) the target.
      if (redirect.op.startsWith("<") && redirect.op !== "<>") continue
      const expanded = expandDecoded(redirect.target) ?? expand(redirect.target)
      if (SAFE_REDIRECTS.has(expanded) || expanded.startsWith("/dev/fd/") || /^&\d+$/.test(expanded)) continue
      paths.push({ raw: redirect.target, cwd: context.cwd, known: context.known })
    }
    const list = writeTargetList(context.argv)
    if (list) for (const target of list.targets) paths.push({ raw: target, cwd: context.cwd, known: context.known })
  }
  return paths
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
 * available, and a command through a nonexistent component fails on its own.
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

/** A static shell word, decoded but not path-normalized; undefined when unknowable. */
function staticShellText(raw: string) {
  const expanded = expandDecoded(raw)
  if (expanded === undefined || expanded === "" || expanded.startsWith("~") || DYNAMIC.test(expanded)) return undefined
  return expanded
}

/** Physical target of a shell word (write destination or read source). */
async function shellPhysicalPath(raw: string, cwd: string) {
  const text = staticShellText(raw)
  return text === undefined ? undefined : physicalPathOf(text, cwd)
}

/** Physical target of a native tool path; native paths are literal, not shell words. */
async function nativePhysicalPath(raw: string, cwd: string) {
  const text = raw.trim()
  if (text === "") return undefined
  return physicalPathOf(process.platform === "win32" ? text.replaceAll("\\", "/") : text, cwd)
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
 * `cat public.txt` where `public.txt` links to `.env` reads the environment
 * file the lexical check already refuses by name.
 */
async function readSymlinkViolation(raw: string, cwd: string, known: boolean, label: string) {
  const target = resolveTarget(raw, cwd)
  if (target.dynamic || target.path === undefined) return undefined
  // A relative word under an unknown cwd names no provable file.
  if (!known && !path.isAbsolute(expandDecoded(raw) ?? "")) return undefined
  const real = await shellPhysicalPath(raw, cwd)
  // A missing file makes `read` fail on its own; there is nothing to leak.
  if (real === undefined) return undefined
  const category = sensitiveCategory(real)
  if (category) return sf2(`${label} symlink`, `reading a ${category} through a symlink is not allowed: ${real}`)
  return undefined
}

/** Native `read` carries a literal path; resolve it before the category check. */
async function nativeReadSymlinkViolation(input: EvaluateInput) {
  const base = input.instance?.worktree ?? input.cwd
  const target = nativeTarget(input.pattern, base)
  if (target.dynamic || target.path === undefined) return undefined
  const real = await nativePhysicalPath(input.pattern, base)
  if (real === undefined) return undefined
  const category = sensitiveCategory(real)
  if (category) return sf2("read symlink", `reading a ${category} through a symlink is not allowed: ${real}`)
  return undefined
}

/** Bash readers go through the same word list the lexical check uses. */
async function bashReadSymlinkViolation(input: EvaluateInput) {
  if (!input.segments) return undefined
  const functions = functionTable(input.segments)
  for (const context of segmentContexts(input.segments, input.cwd, input.knownDirectories, { functions })) {
    for (const word of readTargetList(context.segment, context.argv)) {
      const violation = await readSymlinkViolation(word.raw, context.cwd, context.known, word.label)
      if (violation) return violation
    }
  }
  return undefined
}

/**
 * A lexical boundary check cannot see symlinks. Resolve the existing path
 * components and refuse a write whose real location leaves every allowed
 * root, and a read whose real target is a sensitive file. New files are
 * covered through their nearest existing parent.
 */
export async function symlinkViolation(
  input: EvaluateInput,
  options: { readonly moves?: boolean } = {},
): Promise<Violation | undefined> {
  if (input.explicit) return undefined
  if (input.permission === "read") return nativeReadSymlinkViolation(input)
  if (input.permission !== "edit" && input.permission !== "bash") return undefined
  if (input.permission === "bash") {
    const read = await bashReadSymlinkViolation(input)
    if (read) return read
  }
  const paths = writePaths(input, options.moves !== false)
  if (paths.length === 0) return undefined
  const roots = await realRootsOf(input)
  for (const entry of paths) {
    // Edit patterns and move targets are literal native paths; bash targets
    // keep shell-word decoding.
    const target = input.permission === "edit" ? nativeTarget(entry.raw, entry.cwd) : resolveTarget(entry.raw, entry.cwd)
    if (target.dynamic || target.path === undefined) continue
    if (!entry.known && !path.isAbsolute(expandDecoded(entry.raw) ?? "")) continue
    // Lexical escapes already fail SF-1; only apparently-inside targets need
    // the deeper resolution.
    if (!inside(input, target.path)) continue
    // Resolve the raw spelling physically: symlinks are followed before `..`
    // applies, unlike the lexical `path.resolve` above.
    const real =
      input.permission === "edit"
        ? await nativePhysicalPath(entry.raw, entry.cwd)
        : await shellPhysicalPath(entry.raw, entry.cwd)
    if (real === undefined)
      return sf1("symlink write", `cannot resolve the write target through symlinks: ${target.path}`)
    if (!roots.some((root) => FSUtil.contains(root, real)))
      return sf1("symlink write", `write target resolves outside the project: ${real}`)
  }
  return undefined
}

interface SegmentContext {
  readonly segment: ShellParse.Segment
  /** The command after execution wrappers are unwrapped. */
  readonly argv: readonly string[]
  readonly cwd: string
  readonly known: boolean
  /** An earlier command in the same line may have moved the branch of this directory. */
  readonly branchMutated?: boolean
  /** A wrapper whose inner command cannot be inspected; deny before classifying. */
  readonly wrapperViolation?: Violation
  /** A user-defined function call whose body cannot be expanded; deny before classifying. */
  readonly callViolation?: Violation
}

/** User-defined function bodies of one parsed command, with their cwd effects. */
interface FunctionTable {
  /** Direct body commands per function name. */
  readonly bodies: ReadonlyMap<string, readonly ShellParse.Segment[]>
  /** Functions whose body may `cd` in the caller's shell. */
  readonly changesCwd: ReadonlySet<string>
}

/** Bound on nested function expansion; a deeper call cannot be reviewed. */
const MAX_FUNCTION_DEPTH = 8

/**
 * Collect the function definitions of a command. A body runs only when the
 * function is called, so its commands are deferred at definition time and
 * re-analyzed at each call site. Duplicate or recursive definitions stay
 * over-approximated: every body is reviewed, which can only deny more.
 */
function functionTable(segments: readonly ShellParse.Segment[]): FunctionTable | undefined {
  const bodies = new Map<string, ShellParse.Segment[]>()
  for (const segment of segments) {
    const name = segment.functions?.[0]
    if (name === undefined) continue
    const body = bodies.get(name)
    if (body) body.push(segment)
    else bodies.set(name, [segment])
  }
  if (bodies.size === 0) return undefined
  const memo = new Map<string, boolean>()
  const visiting = new Set<string>()
  const mayMove = (name: string): boolean => {
    const cached = memo.get(name)
    if (cached !== undefined) return cached
    // A recursive definition cannot be proven not to move the caller.
    if (visiting.has(name)) return true
    visiting.add(name)
    const direct = bodies.get(name) ?? []
    // A body's own top-level scope is its shortest scope; a `cd` inside a
    // subshell or pipeline element stays in that scope and never moves the
    // caller.
    const scope = direct.reduce(
      (shortest, segment) =>
        (segment.scope ?? "").split("/").length < shortest.split("/").length ? (segment.scope ?? "") : shortest,
      direct[0]?.scope ?? "",
    )
    const result = direct.some((segment) => {
      if (segment.run === "never") return false
      const called = commandName(unwrapExecution(segment.argv, "", true).argv)
      if (called === "cd") return (segment.scope ?? "") === scope
      return bodies.has(called) && mayMove(called)
    })
    visiting.delete(name)
    memo.set(name, result)
    return result
  }
  const changesCwd = new Set<string>()
  for (const name of bodies.keys()) if (mayMove(name)) changesCwd.add(name)
  return { bodies, changesCwd }
}

const parentScope = (scope: string) => {
  const cut = scope.lastIndexOf("/")
  return cut < 0 ? "" : scope.slice(0, cut)
}

interface ContextOptions {
  /** Expand calls to these user-defined functions into their bodies. */
  readonly functions?: FunctionTable
  /** Body segments execute because a call is being analyzed. */
  readonly deferred?: boolean
  readonly depth?: number
  readonly calls?: ReadonlySet<string>
  /** Branch-mutation state shared by nested function-body expansions. */
  readonly branchState?: BranchState
}

/** Branch facts gathered before execution become stale when a command moves HEAD. */
interface BranchState {
  /** Directories whose branch an earlier command in the line may have moved. */
  readonly dirs: Set<string>
  /** A moving command ran under an unproven cwd, so no directory can be named. */
  unproven: boolean
}

/** `git checkout` options that move HEAD whatever the pathspec says. */
const CHECKOUT_BRANCH_OPTIONS = new Set(["-b", "-B", "--detach", "--orphan", "--track", "-t"])

/** Whether `git checkout` switches branches rather than restoring files. */
function checkoutMovesHead(args: readonly string[]) {
  if (args.some((arg) => CHECKOUT_BRANCH_OPTIONS.has(arg))) return true
  // `--` separates pathspecs: `git checkout -- <path>` and
  // `git checkout <ref> -- <path>` restore files and leave HEAD alone.
  if (args.includes("--")) return false
  const first = args.find((arg) => !isFlag(arg))
  if (first === undefined) return true
  // `.`-relative words are pathspecs; anything else may name a branch.
  return !(first === "." || first === ".." || first.startsWith("./") || first.startsWith("../"))
}

/** Whether `git branch` arguments rename a branch (`-m`, `-M`, `--move`). */
function branchRenames(args: readonly string[]) {
  return args.some((arg) => arg === "--move" || (isShortFlag(arg) && /[mM]/.test(arg.slice(1))))
}

/** Whether `git symbolic-ref` rewrites HEAD to a branch. */
function symbolicRefMovesHead(args: readonly string[]) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    // `-m`/`--message` takes the reflog message, not the ref.
    if (arg === "-m" || arg === "--message") {
      index++
      continue
    }
    if (isFlag(arg)) continue
    return arg === "HEAD" && (args[index + 1] ?? "").startsWith("refs/heads/")
  }
  return false
}

/**
 * The repository directory a command may move HEAD in, or undefined when the
 * command leaves the checked-out branch alone. A later `git push` in the same
 * line must not trust the branch facts captured before execution.
 */
function branchMoveOf(argv: readonly string[], cwd: string, known: boolean) {
  if (commandName(argv) !== "git") return undefined
  const invocation = parseGit(argv, cwd, known)
  if (invocation.uncertain || invocation.name === undefined) return undefined
  const moves =
    invocation.name === "switch" ||
    (invocation.name === "checkout" && checkoutMovesHead(invocation.args)) ||
    (invocation.name === "branch" && branchRenames(invocation.args)) ||
    (invocation.name === "symbolic-ref" && symbolicRefMovesHead(invocation.args))
  return moves ? { cwd: invocation.cwd, known: invocation.cwdKnown } : undefined
}

/**
 * One working-directory state per shell scope: a `cd` inside `( ... )` or
 * `$()` never moves the parent shell, and a pipeline element runs in its own
 * subshell. States are inherited from the nearest enclosing scope.
 *
 * A function body is skipped at definition time and expanded at each call:
 * the body runs in the caller's shell, so its commands are analyzed against
 * the call-time directory. A call to a function that may `cd` leaves the
 * caller's directory unproven.
 *
 * Commands run in order, so a `git switch`/`checkout`/`branch -m`/
 * `symbolic-ref HEAD` marks its repository directory; a later push there is
 * flagged `branchMutated` because the git facts predate the branch change.
 */
function segmentContexts(
  segments: readonly ShellParse.Segment[],
  cwd: string,
  knownDirectories?: ReadonlySet<string>,
  options: ContextOptions = {},
): SegmentContext[] {
  const functions = options.functions
  const depth = options.depth ?? 0
  const calls = options.calls ?? new Set<string>()
  const branchState = options.branchState
  const states = new Map<string, { cwd: string; known: boolean }>()
  const stateFor = (scope: string) => {
    for (let current = scope; ; current = parentScope(current)) {
      const found = states.get(current)
      if (found) return found
      if (current === "") return { cwd, known: true }
    }
  }
  const out: SegmentContext[] = []
  for (const segment of segments) {
    // A statically skipped statement never runs: no target, no cwd change.
    if (segment.run === "never") continue
    // A function body runs only when the function is called.
    if (segment.functions !== undefined && options.deferred !== true) continue
    const scope = segment.scope ?? ""
    const state = stateFor(scope)
    const execution = unwrapExecution(segment.argv, state.cwd, state.known)
    const called = commandName(execution.argv)
    const body = functions?.bodies.get(called)
    // A recursive or too deeply nested call cannot be reviewed statically.
    const callViolation =
      body !== undefined && (calls.has(called) || depth >= MAX_FUNCTION_DEPTH)
        ? sf3("function call", `cannot statically prove the side effects of the call to "${called}"`)
        : undefined
    // Read the mutation state before recording this command: a `git push`
    // after a `git switch` sees the earlier change, the switch itself does not.
    const branchMutated =
      branchState !== undefined &&
      (branchState.unproven || branchState.dirs.has(path.resolve(execution.cwd)))
    out.push({
      segment,
      argv: execution.argv,
      cwd: execution.cwd,
      known: execution.known,
      ...(branchMutated ? { branchMutated: true } : {}),
      ...(execution.violation ? { wrapperViolation: execution.violation } : {}),
      ...(callViolation ? { callViolation } : {}),
    })
    const moved = branchState !== undefined ? branchMoveOf(execution.argv, execution.cwd, execution.known) : undefined
    if (moved !== undefined && branchState !== undefined) {
      // An unproven cwd cannot name the repository the change landed in.
      if (moved.known) branchState.dirs.add(path.resolve(moved.cwd))
      else branchState.unproven = true
    }
    if (body !== undefined && callViolation === undefined) {
      const nextCalls = new Set(calls)
      nextCalls.add(called)
      out.push(
        ...segmentContexts(body, execution.cwd, knownDirectories, {
          functions,
          deferred: true,
          depth: depth + 1,
          calls: nextCalls,
          ...(branchState ? { branchState } : {}),
        }),
      )
    }
    // A user-defined function shadows a builtin of the same name; the body
    // analysis proves its side effects, and the call itself moves no cwd.
    if (body !== undefined) {
      if (functions?.changesCwd.has(called)) states.set(scope, { cwd: execution.cwd, known: false })
      continue
    }
    if (called !== "cd") continue
    if (segment.run === "maybe") {
      // The conditional cd may not run, so later commands cannot trust
      // either the old or the new directory.
      states.set(scope, { cwd: execution.cwd, known: false })
      continue
    }
    const next = execution.argv[1]
    if (next === undefined) {
      states.set(scope, { cwd: os.homedir(), known: true })
      continue
    }
    const resolved = resolveTarget(next, execution.cwd)
    // A relative `cd` resolves against the real cwd; once that is unknown the
    // result stays unknown. Only an absolute target names a proven directory.
    // When the caller proved which directories exist, a target outside that
    // set may fail and leave the old cwd, so the result stays uncertain.
    const proven = knownDirectories === undefined || (resolved.path !== undefined && knownDirectories.has(resolved.path))
    const certain = (execution.known || path.isAbsolute(expandDecoded(next) ?? "")) && proven
    states.set(
      scope,
      resolved.dynamic || resolved.path === undefined
        ? { cwd: execution.cwd, known: false }
        : { cwd: resolved.path, known: certain },
    )
  }
  return out
}

/** Directories a `git push` in this command needs facts for; empty for every other ask. */
export function gitStateRequests(
  segments: readonly ShellParse.Segment[],
  cwd: string,
  knownDirectories?: ReadonlySet<string>,
) {
  const requests = new Map<string, string>()
  const functions = functionTable(segments)
  for (const context of segmentContexts(segments, cwd, knownDirectories, { functions })) {
    if (commandName(context.argv) !== "git") continue
    const invocation = parseGit(context.argv, context.cwd, context.known)
    if (invocation.uncertain || invocation.name !== "push" || !invocation.cwdKnown) continue
    const key = path.resolve(invocation.cwd)
    if (!requests.has(key)) requests.set(key, invocation.cwd)
  }
  return [...requests.values()]
}

function bashViolation(input: EvaluateInput): Violation | undefined {
  const segments = input.segments
  if (!segments) return undefined
  const functions = functionTable(segments)
  const branchState: BranchState = { dirs: new Set(), unproven: false }
  const contexts = segmentContexts(segments, input.cwd, input.knownDirectories, { functions, branchState })
  for (let index = 0; index < contexts.length; index++) {
    const context = contexts[index]
    if (!context) continue
    const { segment: seg, argv, cwd, known } = context
    // A wrapper that may run something this guard cannot read denies before
    // any classifier gets to trust the visible arguments.
    if (context.wrapperViolation) return context.wrapperViolation
    if (context.callViolation) return context.callViolation
    // A commandless redirect carries its own write target.
    const redirect = redirectViolation(input, seg.redirects, cwd, known)
    if (redirect) return redirect
    const name = commandName(argv)
    if (!name) continue
    if (name === "cd") continue
    const sensitive = sensitiveReadViolation(input, seg, argv, cwd)
    if (sensitive) return sensitive
    const destructive = destructiveViolation(input, argv, cwd, known)
    if (destructive) return destructive
    const publish = publishViolation(input, argv, cwd, known, context.branchMutated === true)
    if (publish) return publish
    if (name === "curl" || name === "wget") {
      const next = contexts[index + 1]
      const nextName = next ? commandName(next.argv) : ""
      if (next && next.segment.pipeline === seg.pipeline && SHELLS.has(nextName))
        return sf3(`${name} | ${nextName}`, "piping a download into a shell executes unreviewed remote code")
    }
    const write = writeViolation(input, argv, cwd, known)
    if (write) return write
  }
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

/**
 * Pure adjudication of one pattern. The caller resolves the project instance,
 * the whitelist roots, the git facts and (for bash) the parsed command.
 */
export function evaluate(input: EvaluateInput): Violation | undefined {
  if (input.explicit) return undefined

  if (input.permission === "doom_loop")
    return denial(
      SF_5,
      "doom_loop",
      "the same tool call was repeated three times without progress; repeating it will not change the result",
    )

  const base = input.instance?.worktree ?? input.cwd

  if (input.permission === "edit") {
    // Native file tools supply literal filesystem paths, not shell words.
    const target = nativeTarget(input.pattern, base)
    if (target.dynamic || target.path === undefined)
      return sf1("edit", `cannot determine the write target of "${input.pattern}"`)
    if (!inside(input, target.path)) return sf1("edit", `write target is outside the project: ${target.path}`)
    // apply_patch names only the source in the permission patterns; a move
    // writes its destination, so that path must pass the same boundary.
    for (const raw of editMoveTargets(input.metadata)) {
      const moved = nativeTarget(raw, base)
      if (moved.dynamic || moved.path === undefined)
        return sf1("apply_patch move", `cannot determine the move target of "${raw}"`)
      if (!inside(input, moved.path)) return sf1("apply_patch move", `move target is outside the project: ${moved.path}`)
    }
    return extraViolation(input)
  }

  if (input.permission === "read") {
    // The read tool also supplies a literal path; bash readers go through
    // `readTarget` with shell-word decoding instead.
    const target = nativeTarget(input.pattern, base)
    if (target.dynamic || target.path === undefined) return extraViolation(input)
    const category = sensitiveCategory(target.path)
    if (category) return sf2("read", `reading a ${category} is not allowed: ${target.path}`)
    return extraViolation(input)
  }

  if (input.permission === "grep" || input.permission === "glob") {
    const raw = typeof input.metadata?.path === "string" ? input.metadata.path : undefined
    // grep/glob resolve their `path` against the working directory, not the
    // worktree root (the permission pattern is the search pattern, not a path).
    const directory = input.instance?.directory ?? input.cwd
    const target = raw ? nativeTarget(raw, directory) : undefined
    // The include glob (grep) or the search glob (glob) selects the files the
    // tool reads; a sensitive selection must not pass on the directory alone.
    const include = typeof input.metadata?.include === "string" ? input.metadata.include : undefined
    const selected = input.permission === "glob" ? input.pattern : include
    if (selected) {
      const base = target?.path !== undefined && !target.dynamic ? target.path : directory
      const selection = sensitiveSelection(selected, base)
      if (selection)
        return sf2(input.permission, `searching a ${selection} is not allowed: ${expand(selected)}`)
    }
    const glob = raw ? sensitiveGlob(raw, directory) : undefined
    if (glob) return sf2(input.permission, `reading a ${glob} is not allowed: ${expand(raw ?? "")}`)
    if (!target || target.dynamic || target.path === undefined) return extraViolation(input)
    const category = sensitiveCategory(target.path)
    if (category) return sf2(input.permission, `reading a ${category} is not allowed: ${target.path}`)
    return extraViolation(input)
  }

  if (input.permission === "bash") return bashViolation(input) ?? extraViolation(input)
  return extraViolation(input)
}

function commandOf(metadata: Record<string, unknown> | undefined) {
  const command = metadata?.command
  return typeof command === "string" ? command : undefined
}

function cwdOf(metadata: Record<string, unknown> | undefined, instance: InstanceContext | undefined) {
  const cwd = metadata?.cwd
  if (typeof cwd === "string" && cwd !== "") return cwd
  return instance?.directory ?? process.cwd()
}

function shellIsPowerShell(metadata: Record<string, unknown> | undefined) {
  const shell = metadata?.shell
  if (typeof shell !== "string") return process.platform === "win32"
  const base = path.basename(shell).toLowerCase()
  return base.includes("pwsh") || base.includes("powershell")
}

async function gitDirectory(cwd: string) {
  let directory = cwd
  for (;;) {
    const dot = path.join(directory, ".git")
    const stat = await fs.stat(dot).catch(() => undefined)
    if (stat?.isDirectory()) return dot
    if (stat?.isFile()) {
      const text = await fs.readFile(dot, "utf8").catch(() => undefined)
      const declared = text ? /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim() : undefined
      if (declared) return path.resolve(directory, declared)
    }
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** Filesystem fallback used only when the Git service is unavailable. */
export async function gitStateFromFiles(cwd: string): Promise<GitState | undefined> {
  const directory = await gitDirectory(cwd)
  if (!directory) return undefined
  const common = await fs
    .readFile(path.join(directory, "commondir"), "utf8")
    .then((text) => path.resolve(directory, text.trim()))
    .catch(() => directory)
  const headText = await fs.readFile(path.join(directory, "HEAD"), "utf8").catch(() => undefined)
  const branch = headText ? /^ref: refs\/heads\/(.+)$/m.exec(headText.trim())?.[1]?.trim() : undefined
  let defaultBranch: string | undefined
  for (const root of new Set([directory, common])) {
    const origin = await fs
      .readFile(path.join(root, "refs", "remotes", "origin", "HEAD"), "utf8")
      .catch(() => undefined)
    const packed = await fs.readFile(path.join(root, "packed-refs"), "utf8").catch(() => undefined)
    const packedHead = packed
      ?.split(/\r?\n/)
      .find((line) => line.endsWith(" refs/remotes/origin/HEAD"))
    const source = origin ?? packedHead
    if (source && source.startsWith("ref:"))
      defaultBranch = source.replace(/^ref:\s*refs\/remotes\/origin\//, "").trim()
    if (defaultBranch) break
  }
  const config = await fs.readFile(path.join(common, "config"), "utf8").catch(() => undefined)
  const remotes = config
    ? Array.from(config.matchAll(/^\[remote "(.+)"\]$/gm), (match) => match[1] ?? "").filter(Boolean)
    : []
  return { ...(branch ? { branch } : {}), ...(defaultBranch ? { defaultBranch } : {}), remotes }
}

/** Local `references` entries are writable whitelist roots, like `agent.ts`. */
export function referenceRoots(value: { readonly references?: unknown; readonly reference?: unknown }, root: string) {
  const out: string[] = []
  const entries = [value.references, value.reference].filter(isRecord)
  for (const record of entries) {
    for (const entry of Object.values(record)) {
      const raw =
        typeof entry === "string"
          ? entry
          : isRecord(entry) && typeof entry.path === "string"
            ? entry.path
            : undefined
      if (!raw) continue
      if (!(raw.startsWith(".") || raw.startsWith("/") || raw.startsWith("~"))) continue
      out.push(
        raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : path.isAbsolute(raw) ? raw : path.resolve(root, raw),
      )
    }
  }
  return out
}

/**
 * Existing directories a `cd` in this command may enter. A `cd` elsewhere may
 * fail and leave the old cwd, so consumers keep that path uncertain.
 */
async function provenDirectories(segments: readonly ShellParse.Segment[], cwd: string): Promise<Set<string>> {
  const proven = new Set<string>()
  const functions = functionTable(segments)
  for (const context of segmentContexts(segments, cwd, undefined, { functions })) {
    if (commandName(context.argv) !== "cd") continue
    const next = context.argv[1]
    if (next === undefined) {
      proven.add(os.homedir())
      continue
    }
    const resolved = resolveTarget(next, context.cwd)
    if (resolved.dynamic || resolved.path === undefined) continue
    const stat = await fs.stat(resolved.path).catch(() => undefined)
    if (stat?.isDirectory()) proven.add(resolved.path)
  }
  return proven
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
              .pipe(Effect.map((value) => referenceRoots(value, instance?.root ?? instance?.directory ?? process.cwd())))
              .pipe(Effect.orElseSucceed(() => [] as string[]))
          : []
        const allowRoots = [Global.Path.tmp, TRUNCATION_DIR, ...skillDirs, ...references]
        const cwd = cwdOf(metadata, instance)
        const command = commandOf(metadata)
        const segments =
          input.request.permission === "bash" && command
            ? yield* ShellParse.segments(command, shellIsPowerShell(metadata)).pipe(
                Effect.catchCause(() => Effect.succeed(undefined)),
              )
            : undefined
        // A `cd` may fail; prove which directories exist before trusting it.
        const knownDirectories =
          !input.rule.explicit && segments
            ? yield* Effect.promise(() => provenDirectories(segments, cwd)).pipe(Effect.orElseSucceed(() => undefined))
            : undefined
        // Git facts are only consumed by SF-4 push checks. Resolve them for
        // the repositories a push actually targets, and never for ordinary
        // read/edit/other asks: each lookup costs several Git subprocesses.
        const requests = !input.rule.explicit && segments ? gitStateRequests(segments, cwd, knownDirectories) : []
        const gitStates = new Map<string, GitState | undefined>()
        if (requests.length > 0) {
          const gitService = Option.getOrUndefined(yield* Effect.serviceOption(Git.Service))
          for (const directory of requests) {
            const key = path.resolve(directory)
            if (gitStates.has(key)) continue
            const state = gitService
              ? yield* Effect.gen(function* () {
                  const branch = yield* gitService.branch(directory).pipe(Effect.orElseSucceed(() => undefined))
                  const resolved = yield* gitService.defaultBranch(directory).pipe(Effect.orElseSucceed(() => undefined))
                  const remotes = yield* gitService.run(["remote"], { cwd: directory }).pipe(
                    Effect.map((result) =>
                      result.exitCode === 0
                        ? result
                            .text()
                            .split(/\r?\n/)
                            .map((line) => line.trim())
                            .filter(Boolean)
                        : [],
                    ),
                    Effect.orElseSucceed(() => [] as string[]),
                  )
                  return {
                    ...(branch ? { branch } : {}),
                    ...(resolved ? { defaultBranch: resolved.name } : {}),
                    remotes,
                  } satisfies GitState
                })
              : yield* Effect.promise(() => gitStateFromFiles(directory)).pipe(Effect.orElseSucceed(() => undefined))
            gitStates.set(key, state)
          }
        }

        const request: EvaluateInput = {
          permission: input.request.permission,
          pattern: input.pattern,
          metadata,
          explicit: input.rule.explicit,
          cwd,
          instance,
          allowRoots,
          extra,
          git: undefined,
          ...(gitStates.size > 0 ? { gitStates } : {}),
          ...(knownDirectories !== undefined ? { knownDirectories } : {}),
          segments,
        }
        // Lexical checks stay pure; symlink resolution runs only when they
        // found nothing. Move targets are checked once per ask, not once per
        // permission pattern.
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