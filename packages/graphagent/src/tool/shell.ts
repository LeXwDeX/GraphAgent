import { HookTranscript, type Message } from "@/hook/transcript"
import { promptIdentity } from "@/hook/prompt-identity"
import { Cause, Effect, Exit, Fiber, Option, Semaphore, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"
import { BackgroundJob } from "@/background/job"
import { Identifier } from "@graphagent/core/id/id"
import type { TaskPromptOps } from "./task"

import { FSUtil } from "@graphagent/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@graphagent/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { ShellPrompt, SHELL_TAIL_LINES, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"

export { Parameters } from "./shell/prompt"

export const SHELL_ABORT_NOTE =
  "The command was aborted before completion (client interrupt or session cancel). For long-running work, bound it with `timeout <seconds>` and stream progress instead of piping into a silent buffer."

const DEFAULT_SILENCE_WARN_MS = 5 * 60 * 1000

const shellSilenceNote = (ms: number) =>
  `shell tool emitted an inactivity warning after ${ms} ms without output; the command was left running. If this command is expected to stay silent, pass expectedSilent: true to opt out.`

/**
 * Structural guard for the prompt capability carried in `ctx.extra`. Kept as a
 * type predicate so the tools never narrow `unknown` with an assertion.
 */
function isTaskPromptOps(value: unknown): value is TaskPromptOps {
  if (typeof value !== "object" || value === null) return false
  if (!("cancel" in value) || typeof value.cancel !== "function") return false
  if (!("resolvePromptParts" in value) || typeof value.resolvePromptParts !== "function") return false
  if (!("prompt" in value) || typeof value.prompt !== "function") return false
  return true
}

const MAX_METADATA_LENGTH = 30_000
const METADATA_INTERVAL_MS = 200
/** Non-durable preview payload bound (#1016 HS4a). */
const PREVIEW_MAX_BYTES = 4 * 1024
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

/** Keep the last whole UTF-8 code points that fit the preview byte budget. */
function previewTail(text: string) {
  if (Buffer.byteLength(text, "utf-8") <= PREVIEW_MAX_BYTES) return text
  let bytes = 0
  let index = text.length
  while (index > 0) {
    const low = text.charCodeAt(index - 1)
    const size = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? 2 : 1
    const charBytes = Buffer.byteLength(text.slice(index - size, index), "utf-8")
    if (bytes + charBytes > PREVIEW_MAX_BYTES) break
    bytes += charBytes
    index -= size
  }
  return text.slice(index)
}

function pageRanges(totalLines: number, pages: number) {
  const range = (page: number) =>
    `${(page - 1) * Truncate.PAGE_LINES + 1}-${Math.min(page * Truncate.PAGE_LINES, totalLines)}`
  if (pages > 4) return `${range(1)}, ${range(2)}, ... ${range(pages)}`
  return Array.from({ length: pages }, (_, i) => range(i + 1)).join(", ")
}

/**
 * The complete stream lives in the tool-output file even when the inline
 * preview keeps only its tail. The footer names the file, its size, and the
 * exact read/grep calls that continue from either edge, so the model never
 * reruns the command to see an earlier chunk.
 */
export function outputFooter(
  file: string,
  totalLines: number,
  totalBytes: number,
  shownLines: number,
  partialBytes?: number,
  partialLineBytes?: number,
) {
  const pages = Math.max(1, Math.ceil(totalLines / Truncate.PAGE_LINES))
  // Advertise only pages that exist: read rejects a negative page before the
  // first page, so a hint such as page=-4 on a three-page output is a dead end.
  const further =
    pages === 3
      ? "   (page=-3)"
      : pages === 4
        ? "   (page=-3, -4)"
        : pages > 4
          ? `   (page=-3, -4, ... back to -${pages})`
          : ""
  const summary =
    partialBytes !== undefined
      ? `[truncated: showing the last ${Truncate.formatSize(partialBytes)} of line ${totalLines} ` +
        `(line is ${Truncate.formatSize(partialLineBytes ?? totalBytes)}; ` +
        `${Truncate.formatSize(totalBytes)} total output). Full output saved.]`
      : `[truncated: showing the last ${shownLines} of ${totalLines} lines ` +
        `(${Truncate.formatSize(totalBytes)} total). Full output saved.]`
  return [
    summary,
    "",
    "--------- full output ---------",
    `path: ${file}`,
    `size: ${Truncate.formatSize(totalBytes)} (${totalBytes} bytes), ${totalLines} lines, ${pages} pages of ${Truncate.PAGE_LINES} lines`,
    ...(pages > 1 ? [`pages: ${pageRanges(totalLines, pages)}`] : []),
    `start:  read filePath="${file}"`,
    `last:   read filePath="${file}" page=-1   (last page; follow its notice if the read byte cap stops early)`,
    ...(pages > 1 ? [`back:   read filePath="${file}" page=-2${further}`] : []),
    `search: grep pattern="<regex>" path="${file}" context=10   (grep reports the match count; narrow the pattern instead of paging blindly)`,
  ].join("\n")
}

/**
 * Drops the fragment before the first newline when dropped chunks left a
 * partial line. If that newline is the last character, the retained prefix is
 * all that remains of one line: keep it as a partial line instead of trimming
 * to nothing, so a single huge line still shows its tail.
 */
export function trimPartialHead(raw: string): { text: string; partialHead: boolean } {
  const boundary = raw.indexOf("\n")
  if (boundary < 0) return { text: raw, partialHead: true }
  if (boundary === raw.length - 1) return { text: raw.slice(0, boundary), partialHead: true }
  return { text: raw.slice(boundary + 1), partialHead: false }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      extendEnv: false,
      stdin: "ignore",
      detached: false,
      stdout: "pipe",
      stderr: "pipe",
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    extendEnv: false,
    stdin: "ignore",
    detached: process.platform !== "win32",
    stdout: "pipe",
    stderr: "pipe",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const background = yield* BackgroundJob.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000
    const silenceWarnMs = flags.bashSilenceWarnMs ?? DEFAULT_SILENCE_WARN_MS

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text], { stdout: "pipe", stderr: "pipe" }))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const base = { ...process.env }
      const env = HookTranscript.applyEnvironment(
        base,
        yield* HookTranscript.environment(ctx.sessionID, undefined, base).pipe(Effect.orDie),
      )
      // CC exports the active effort to model-run shells; the newest prompt's model
      // variant is authoritative, so a hook-exported value never overrides it.
      const effort = promptIdentity(ctx.messages as readonly Message[]).effort
      return effort ? { ...env, CLAUDE_EFFORT: effort } : env
    })

    // A goal waiting on this background job registers its job id. Wake only
    // that wait; see watch_pr for the evaluate semantics.
    const wakeJob = (
      ctx: Tool.Context,
      jobID: string,
      payload: string,
      evaluate: boolean,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { GoalLoop } = yield* Effect.promise(() => import("@/goal/loop"))
        const loops = Option.getOrUndefined(yield* Effect.serviceOption(GoalLoop.Service))
        if (!loops) return
        yield* loops.wake(ctx.sessionID, { source: "background_job", ids: [jobID] }, payload, { evaluate })
      }).pipe(Effect.ignore)

    const notifyBackground = Effect.fn("ShellTool.notifyBackground")(function* (
      input: {
        jobID: string
        payload: string
        output: string
        logPath: string
      },
      ctx: Tool.Context,
    ) {
      yield* wakeJob(ctx, input.jobID, input.payload, false)
      const ops = ctx.extra?.promptOps
      if (!isTaskPromptOps(ops)) return
      yield* ops
        .prompt(
          {
            sessionID: ctx.sessionID,
            agent: ctx.agent,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: `${input.payload}\njob: ${input.jobID}\nlog: ${input.logPath}\n\n${input.output}`,
              },
            ],
          },
          { continueToolBudget: true },
        )
        .pipe(Effect.ignore)
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        /** `undefined` means no timeout (background jobs without an explicit bound). */
        timeout: number | undefined
        expectedSilent: boolean
        /** Present only for a background job: the id to wake and the log file to append. */
        background?: { jobID: string; logPath: string }
      },
      ctx: Tool.Context,
    ) {
      const background = input.background
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = background?.logPath ?? ""
      let sink: ReturnType<typeof createWriteStream> | undefined =
        file === "" ? undefined : createWriteStream(file, { flags: "a" })
      let cut = false
      let headPartial = false
      // Bytes in the most recently completed line and in the trailing line
      // that has no terminator yet. The last one is the true size of the final
      // line even when a huge line ends with a newline.
      let completedLineBytes = 0
      let currentLineBytes = 0
      let expired = false
      let aborted = false
      let lastActivity = Date.now()
      let silenceWarned = false
      let silenceWarnings = 0
      // Exact counters for the complete stream: the preview buffer may drop
      // earlier chunks, but the saved file always holds the whole output.
      let streamBytes = 0
      let streamNewlines = 0

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      // Each preview is a non-durable tail event (#1016 HS4a), so chunk bursts
      // coalesce into at most one publish per interval without touching the
      // part row. The lock keeps the stream, the trailing flush and the silence
      // guard from publishing out of order. Only output whose chunk was fully
      // handled (including any spill to the truncation file) is published, so a
      // visible preview never runs ahead of it.
      const publishLock = Semaphore.makeUnsafe(1)
      let published = 0
      let pending = false
      let settled = ""
      const emit = (output?: string) => {
        // A background job outlives the tool call: its result is delivered as a
        // notice instead of streaming into a tool part that no longer exists.
        if (background) return Effect.void
        return publishLock.withPermits(1)(
          Effect.suspend(() => {
            pending = false
            published = Date.now()
            const text = output ?? settled
            if (ctx.preview) return ctx.preview({ tail: previewTail(text), totalLength: streamBytes })
            // Hosts without a preview stream keep the old durable metadata path.
            return ctx.metadata({ metadata: { output: text } })
          }),
        )
      }
      const streamPreview = Effect.suspend(() => {
        if (background) return Effect.void
        settled = last
        if (Date.now() - published >= METADATA_INTERVAL_MS) return emit()
        pending = true
        return Effect.void
      })
      const flushPreview = Effect.suspend(() => (background || !pending ? Effect.void : emit()))

      if (!background) {
        yield* ctx.metadata({
          metadata: {
            output: "",
          },
        })
      }

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          const readerFiber = yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              lastActivity = Date.now()
              silenceWarned = false
              const size = Buffer.byteLength(chunk, "utf-8")
              streamBytes += size
              for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 10) streamNewlines++
              // Track the full length of the final line. A chunk with newlines
              // completes every part before the last one (the first part also
              // carries the previous chunk's unterminated prefix); the last
              // part becomes the new trailing line.
              const parts = chunk.split("\n")
              if (parts.length === 1) currentLineBytes += size
              else {
                for (let i = 0; i < parts.length - 1; i++) {
                  completedLineBytes = (i === 0 ? currentLineBytes : 0) + Buffer.byteLength(parts[i]!, "utf-8")
                  currentLineBytes = 0
                }
                currentLineBytes = Buffer.byteLength(parts[parts.length - 1]!, "utf-8")
              }
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
                headPartial = !item.text.endsWith("\n")
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(streamPreview),
                  )
                }
              }

              return streamPreview
            }),
          )

          // Trailing edge of the preview throttle: a command that pauses after a
          // burst still shows its latest output without waiting for exit.
          yield* Effect.forkScoped(
            Effect.forever(Effect.sleep(`${METADATA_INTERVAL_MS} millis`).pipe(Effect.andThen(flushPreview))),
          )

          // Warn-only silence guard: lives on its own fiber and must never
          // join the race below — a silence warning may not change exit.kind.
          if (!background && !input.expectedSilent) {
            yield* Effect.forkScoped(
              Effect.forever(
                Effect.gen(function* () {
                  const idle = Date.now() - lastActivity
                  yield* Effect.sleep(`${idle < silenceWarnMs ? silenceWarnMs - idle : silenceWarnMs} millis`)
                  if (silenceWarned || Date.now() - lastActivity < silenceWarnMs) return
                  silenceWarned = true
                  silenceWarnings++
                  yield* emit(last + `\n\n${shellSilenceNote(silenceWarnMs)}`)
                }),
              ),
            )
          }

          // A background job must not die with the tool call or a client
          // interrupt: its lifetime is owned by the BackgroundJob scope and
          // session cancellation, not by ctx.abort.
          const abort = background
            ? Effect.never
            : Effect.callback<void>((resume) => {
                if (ctx.abort.aborted) return resume(Effect.void)
                const handler = () => resume(Effect.void)
                ctx.abort.addEventListener("abort", handler, { once: true })
                return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
              })

          // Background jobs have no default bound; an explicit timeout still
          // applies as a hard cap on how long the job may run.
          const timeout =
            input.timeout === undefined ? Effect.never : Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          if (exit.kind === "exit") {
            // The process can exit before the reader drains stdout. Join it so
            // the final lines reach the truncation buffer; a child that keeps
            // the pipe open is bounded by the timeout.
            yield* Fiber.join(readerFiber).pipe(
              Effect.catchCause(() => Effect.void),
              Effect.timeoutOption("5 seconds"),
            )
          } else {
            // A killed shell can leave a child holding stdout open (for example a
            // sleeping pipeline), so joining the reader may outlive session
            // cleanup and turn this result into a forced abort. Stop the reader
            // and finalize the output already collected; the truncation footer is
            // built from that retained list below.
            yield* Fiber.interrupt(readerFiber)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)
      yield* flushPreview

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push(SHELL_ABORT_NOTE)
      for (let i = 0; i < silenceWarnings; i++) meta.push(shellSilenceNote(silenceWarnMs))
      if (code !== null && code !== 0) meta.push(`Command exited with code ${code}`)
      let raw = list.map((item) => item.text).join("")
      // The retained tail inherits the stream's ending even after the partial
      // head is trimmed, so capture it before the trim changes raw.
      const endsWithNewline = raw.endsWith("\n")
      // Dropping whole chunks can leave a partial first line. Show only whole
      // lines so the footer's line count does not present a fragment as a line;
      // a retained suffix with no whole line is reported as a partial line.
      let partialHead = false
      if (headPartial) {
        const trimmed = trimPartialHead(raw)
        raw = trimmed.text
        partialHead = trimmed.partialHead
      }
      const totalLines = streamNewlines + (streamBytes > 0 && !endsWithNewline ? 1 : 0)
      const lastLineBytes = endsWithNewline ? completedLineBytes : currentLineBytes
      const end = Truncate.tailPreview(raw, SHELL_TAIL_LINES, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        const shownLines = Truncate.countLines(end.text)
        const partialBytes = end.details?.partialLine
          ? end.details.outputBytes
          : partialHead
            ? Buffer.byteLength(raw, "utf-8")
            : undefined
        const partialLineBytes = partialHead
          ? lastLineBytes
          : end.details?.partialLine
            ? end.details.lineBytes
            : undefined
        output =
          `${output}\n\n` + outputFooter(file, totalLines, streamBytes, shownLines, partialBytes, partialLineBytes)
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      if (background) {
        const payload = expired
          ? `Background shell timed out after ${input.timeout} ms: ${input.command}`
          : code === null
            ? `Background shell ended without an exit code: ${input.command}`
            : code === 0
              ? `Background shell completed: ${input.command}`
              : `Background shell failed (exit ${code}): ${input.command}`
        yield* notifyBackground({ jobID: background.jobID, payload, output, logPath: file }, ctx)
      }
      // A nonzero exit is a completed command whose output the model still
      // needs, so it stays a normal result. The hook-facing failure is carried
      // separately; the dispatcher turns it into PostToolUseFailure. A
      // background job has no synchronous tool result to attach hooks to.
      const hookFailure = !background && code !== null && code !== 0 ? `Exit code ${code}\n\n${output}` : undefined
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
        ...(hookFailure ? { hookFailure } : {}),
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs, silenceWarnMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          effects: "unknown",
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const backgroundMode = params.background === true
              // Background jobs have no default bound: a host CI or build may
              // legitimately run for hours. An explicit timeout still caps it.
              const timeout = params.timeout ?? (backgroundMode ? undefined : defaultTimeoutMs)
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              const env = yield* shellEnv(ctx, cwd)
              if (backgroundMode) {
                // Without a prompt context the job could run but never deliver
                // its result or wake a waiting goal, so refuse it up front.
                const ops = ctx.extra?.promptOps
                if (!isTaskPromptOps(ops)) {
                  throw new Error(
                    "The shell tool's background mode requires a session prompt context (ctx.extra.promptOps).",
                  )
                }
                const logPath = yield* trunc.write("")
                const jobID = Identifier.ascending("job")
                const info = yield* background.start({
                  id: jobID,
                  type: "bash",
                  title: params.command,
                  metadata: { sessionID: ctx.sessionID, command: params.command },
                  run: run(
                    {
                      shell,
                      command: params.command,
                      cwd,
                      env,
                      timeout,
                      expectedSilent: params.expectedSilent === true,
                      background: { jobID, logPath },
                    },
                    ctx,
                  ).pipe(
                    Effect.map((result) => result.output),
                    Effect.onInterrupt(() =>
                      wakeJob(ctx, jobID, `Background shell cancelled: ${params.command}`, true),
                    ),
                    Effect.onExit((exit) => {
                      if (!Exit.isFailure(exit) || Cause.hasInterruptsOnly(exit.cause)) return Effect.void
                      return wakeJob(ctx, jobID, `Background shell failed: ${params.command}`, true)
                    }),
                  ),
                })
                return {
                  title: params.command,
                  metadata: {
                    output: "Background shell started",
                    exit: null,
                    truncated: false,
                  },
                  output: [
                    `Background shell started: ${params.command}`,
                    `job: ${info.id}`,
                    `log: ${logPath}`,
                    "The command keeps running after this tool call; completion arrives as a result notice.",
                    `To wait for it, declare goal intent=await with wait_source=background_job and wait_id=${info.id}. Do not poll with a foreground sleep loop.`,
                  ].join("\n"),
                }
              }
              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env,
                  timeout,
                  expectedSilent: params.expectedSilent === true,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
