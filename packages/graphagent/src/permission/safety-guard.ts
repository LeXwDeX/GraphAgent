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
  readonly git: GitState | undefined
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
const DYNAMIC = /\$\(|`|\$\{|\$[A-Za-z_]/
const GLOB = /[*?[]/
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const SAFE_REDIRECTS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"])

function expand(raw: string) {
  const text = ShellParse.unquote(raw)
  if (text === "~") return os.homedir()
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2))
  if (text === "$HOME") return os.homedir()
  if (text.startsWith("$HOME/")) return path.join(os.homedir(), text.slice(6))
  return text
}

/** Resolve one shell word to a project-checkable path; `dynamic` is unknowable. */
export function resolveTarget(raw: string, cwd: string): { path?: string; dynamic: boolean } {
  const expanded = expand(raw)
  // An unexpanded home of another user (`~name`) is not a project path.
  if (expanded === "" || expanded.startsWith("~") || DYNAMIC.test(expanded)) return { dynamic: true }
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
  if (!known && !path.isAbsolute(expand(raw)))
    return sf1(label, `cannot determine the working directory for "${raw.trim()}"`)
  if (!inside(input, target.path)) return sf1(label, `write target is outside the project: ${target.path}`)
  return undefined
}

function readTarget(input: EvaluateInput, raw: string, cwd: string, label: string): Violation | undefined {
  const target = resolveTarget(raw, cwd)
  if (target.dynamic || target.path === undefined) return undefined
  const category = sensitiveCategory(target.path)
  if (category) return sf2(label, `reading a ${category} is not allowed: ${target.path}`)
  return undefined
}

function redirectViolation(
  input: EvaluateInput,
  redirects: readonly ShellParse.Redirect[],
  cwd: string,
  known: boolean,
): Violation | undefined {
  for (const redirect of redirects) {
    if (redirect.op.startsWith("<<") && !redirect.op.startsWith("<<<")) continue
    if (redirect.op.startsWith("<") && !redirect.op.startsWith("<<<")) {
      const violation = readTarget(input, redirect.target, cwd, "shell input redirect")
      if (violation) return violation
      continue
    }
    const expanded = expand(redirect.target)
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

function pushViolation(input: EvaluateInput, argv: readonly string[]): Violation | undefined {
  const args = argv.slice(2)
  const git = input.git
  const pushed = args.filter((value) => !isFlag(value))
  let refs = pushed
  if (pushed.length > 0) {
    if (git?.remotes.includes(pushed[0] ?? "")) refs = pushed.slice(1)
    else if ((git?.remotes.length ?? 0) === 0 && pushed.length >= 2) refs = pushed.slice(1)
    else if (
      (git?.remotes.length ?? 0) === 0 &&
      pushed.length === 1 &&
      !matchesDefault(pushed[0] ?? "", git) &&
      pushed[0] !== "HEAD"
    )
      // A single bare word with no known remotes is treated as the remote
      // name, so the effective target is the current branch.
      refs = []
  }

  if (refs.length === 0) {
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
    if (destination === undefined) return undefined
    if (matchesDefault(destination, git))
      return sf4(
        "git push",
        `pushing to the default branch "${destination}" is a release action; use a feature branch and let the parent merge`,
      )
  }
  return undefined
}

function destructiveViolation(input: EvaluateInput, argv: readonly string[]) {
  const name = (argv[0] ?? "").toLowerCase()
  const args = argv.slice(1)

  if (name === "rm") {
    const recursive = args.some((arg) => arg === "--recursive" || (isShortFlag(arg) && /[rR]/.test(arg)))
    if (!recursive) return undefined
    for (const target of words(args)) {
      const resolved = resolveTarget(target, input.cwd)
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
    const sub = (argv[1] ?? "").toLowerCase()
    if (sub === "push") {
      const forced = args.some(
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
    if (sub === "reset" && args.includes("--hard"))
      return sf3("git reset --hard", "a hard reset discards uncommitted work without recovery")
    if (sub === "clean" && args.some((arg) => arg === "--force" || (isShortFlag(arg) && /f/.test(arg))))
      return sf3("git clean -f", "git clean -f deletes untracked files with no recovery")
  }

  if (name === "chmod" || name === "chown") {
    const recursive = args.some((arg) => arg === "-R" || arg === "--recursive")
    if (!recursive) return undefined
    for (const target of words(args).slice(1)) {
      const resolved = resolveTarget(target, input.cwd)
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

function publishViolation(input: EvaluateInput, argv: readonly string[]) {
  const name = (argv[0] ?? "").toLowerCase()
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
  if (name === "git" && (argv[1] ?? "").toLowerCase() === "push") return pushViolation(input, argv)
  return undefined
}

function sensitiveReadViolation(input: EvaluateInput, seg: ShellParse.Segment, argv: readonly string[]) {
  const name = (argv[0] ?? "").toLowerCase()
  const args = argv.slice(1)
  if (["cat", "less", "more", "head", "tail"].includes(name)) {
    for (const target of words(args)) {
      const violation = readTarget(input, target, input.cwd, name)
      if (violation) return violation
    }
  }
  if (name === "grep" || name === "rg") {
    let patternSeen = false
    for (let index = 0; index < args.length; index++) {
      const arg = args[index] ?? ""
      if (isFlag(arg)) {
        if (["-e", "--regexp", "-f", "--file"].includes(arg)) index++
        continue
      }
      if (!patternSeen) {
        patternSeen = true
        continue
      }
      const violation = readTarget(input, arg, input.cwd, name)
      if (violation) return violation
    }
  }
  if (name === "cp") {
    for (const target of words(args).slice(0, -1)) {
      const violation = readTarget(input, target, input.cwd, name)
      if (violation) return violation
    }
  }
  if (name === "curl") {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index] ?? ""
      const inline = /^--(?:data|data-binary|data-raw|data-urlencode|form)=@(.+)$/.exec(arg)
      if (inline) {
        const violation = readTarget(input, inline[1] ?? "", input.cwd, "curl")
        if (violation) return violation
        continue
      }
      if (["-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "-F", "--form"].includes(arg)) {
        const next = args[index + 1]
        if (next?.startsWith("@")) {
          const violation = readTarget(input, next.slice(1), input.cwd, "curl")
          if (violation) return violation
        }
        index++
      }
    }
  }
  for (const redirect of seg.redirects) {
    if (!redirect.op.startsWith("<") || redirect.op.startsWith("<<<")) continue
    const violation = readTarget(input, redirect.target, input.cwd, "shell input redirect")
    if (violation) return violation
  }
  return undefined
}

function writeViolation(input: EvaluateInput, argv: readonly string[], known = true) {
  const name = (argv[0] ?? "").toLowerCase()
  const args = argv.slice(1)
  const all = words(args)
  const check = (targets: readonly string[], label: string) => {
    for (const target of targets) {
      const violation = writeTarget(input, target, input.cwd, known, label)
      if (violation) return violation
    }
    return undefined
  }
  if (name === "rm") return check(all, "rm")
  if (name === "tee") return check(all, "tee")
  if (name === "cp" || name === "mv") return check(all.slice(-1), name)
  if (name === "ln") return check(all.slice(-1), "ln")
  if (name === "chmod" || name === "chown") return check(all.slice(1), name)
  if (name === "sed" && args.some((arg) => arg === "--in-place" || arg.startsWith("-i"))) {
    const rest = args.filter((arg) => !isFlag(arg))
    return check(rest.slice(1), "sed -i")
  }
  return undefined
}

function bashViolation(input: EvaluateInput): Violation | undefined {
  const segments = input.segments
  if (!segments) return undefined
  let cwd = input.cwd
  let known = true
  for (let index = 0; index < segments.length; index++) {
    const seg = segments[index]
    if (!seg) continue
    const argv = commandArgs(seg.argv)
    const name = (argv[0] ?? "").toLowerCase()
    if (!name) continue
    const redirect = redirectViolation(input, seg.redirects, cwd, known)
    if (redirect) return redirect
    if (name === "cd") {
      const next = argv[1]
      if (next === undefined) cwd = os.homedir()
      else {
        const resolved = resolveTarget(next, cwd)
        if (resolved.dynamic || resolved.path === undefined) known = false
        else cwd = resolved.path
      }
      continue
    }
    const contextual = { ...input, cwd }
    const sensitive = sensitiveReadViolation(contextual, seg, argv)
    if (sensitive) return sensitive
    const destructive = destructiveViolation(contextual, argv)
    if (destructive) return destructive
    const publish = publishViolation(contextual, argv)
    if (publish) return publish
    if (name === "curl" || name === "wget") {
      const next = segments[index + 1]
      const nextName = next ? (commandArgs(next.argv)[0] ?? "").toLowerCase() : ""
      if (next && next.pipeline === seg.pipeline && SHELLS.has(nextName))
        return sf3(`${name} | ${nextName}`, "piping a download into a shell executes unreviewed remote code")
    }
    const write = writeViolation(contextual, argv, known)
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
    const target = resolveTarget(input.pattern, base)
    if (target.dynamic || target.path === undefined)
      return sf1("edit", `cannot determine the write target of "${input.pattern}"`)
    if (!inside(input, target.path)) return sf1("edit", `write target is outside the project: ${target.path}`)
    return extraViolation(input)
  }

  if (input.permission === "read") {
    const target = resolveTarget(input.pattern, base)
    if (target.dynamic || target.path === undefined) return extraViolation(input)
    const category = sensitiveCategory(target.path)
    if (category) return sf2("read", `reading a ${category} is not allowed: ${target.path}`)
    return extraViolation(input)
  }

  if (input.permission === "grep" || input.permission === "glob") {
    const raw = typeof input.metadata?.path === "string" ? input.metadata.path : undefined
    // grep/glob resolve their `path` against the working directory, not the
    // worktree root (the permission pattern is the search pattern, not a path).
    const target = raw ? resolveTarget(raw, input.instance?.directory ?? input.cwd) : undefined
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
        const gitService = Option.getOrUndefined(yield* Effect.serviceOption(Git.Service))
        const git = gitService
          ? yield* Effect.gen(function* () {
              const branch = yield* gitService.branch(cwd).pipe(Effect.orElseSucceed(() => undefined))
              const resolved = yield* gitService.defaultBranch(cwd).pipe(Effect.orElseSucceed(() => undefined))
              const remotes = yield* gitService.run(["remote"], { cwd }).pipe(
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
          : yield* Effect.promise(() => gitStateFromFiles(cwd)).pipe(Effect.orElseSucceed(() => undefined))

        const violation = evaluate({
          permission: input.request.permission,
          pattern: input.pattern,
          metadata,
          explicit: input.rule.explicit,
          cwd,
          instance,
          allowRoots,
          extra,
          git,
          segments,
        })
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