/** Read-only tools for model-driven hooks. Every operation observes the hook abort signal. */
import path from "path"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { type Tool, tool, jsonSchema } from "ai"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { HookEvaluatorOutputSchema, type HookEvaluatorOutput } from "./schema"
import { FORBIDDEN_META, parseReadonlyCommand, readonlyExecutable, whitelistReject } from "./readonly-command"

export const __test__ = { whitelistReject, FORBIDDEN_META }

// ── helpers ─────────────────────────────────────────────────────

function resolvePath(p: string, cwd: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p)
}

const MAX_BASH_OUTPUT = 8000
const MAX_GREP_RESULTS_DEFAULT = 100
const MAX_READ_LINES_DEFAULT = 2000

// ── factory ─────────────────────────────────────────────────────

export interface BuildAgentToolsDeps {
  spawner: ChildProcessSpawner["Service"]
  fs: FSUtil.Interface
  signal: AbortSignal
  cwd: string
  /** Mutable slot the synthetic_output tool writes to. Loop polls .value. */
  captured: { value: HookEvaluatorOutput | null }
}

export function buildAgentTools(deps: BuildAgentToolsDeps): Record<string, Tool> {
  const { spawner, fs, signal, cwd, captured } = deps

  const read_file = tool({
    description: "Read a UTF-8 file. Optional 1-indexed offset and max line limit (default 2000).",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or cwd-relative path" },
        offset: { type: "number", description: "1-indexed line offset (optional)" },
        limit: { type: "number", description: "Max number of lines (default 2000)" },
      },
      required: ["path"],
    }),
    execute: async (args: any) => {
      try {
        const resolved = resolvePath(String(args.path), cwd)
        const text = await Effect.runPromise(fs.readFileString(resolved), { signal })
        const offset = typeof args.offset === "number" && args.offset > 0 ? args.offset - 1 : 0
        const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : MAX_READ_LINES_DEFAULT
        const lines = text.split("\n").slice(offset, offset + limit)
        return { output: lines.join("\n") }
      } catch (e: any) {
        return { output: `Error: ${e?.message ?? String(e)}` }
      }
    },
  })

  const list_dir = tool({
    description: "List directory entries. Directories are suffixed with '/'.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", description: "default false" },
      },
      required: ["path"],
    }),
    execute: async (args: any) => {
      try {
        const root = resolvePath(String(args.path), cwd)
        const recursive = args.recursive === true
        const lines: string[] = []

        const walk = async (dir: string, rel: string): Promise<void> => {
          const entries = await Effect.runPromise(fs.readDirectoryEntries(dir), { signal })
          for (const e of entries) {
            signal.throwIfAborted()
            const display = (rel ? rel + "/" : "") + e.name + (e.type === "directory" ? "/" : "")
            lines.push(display)
            if (recursive && e.type === "directory") {
              await walk(path.join(dir, e.name), (rel ? rel + "/" : "") + e.name)
            }
          }
        }

        await walk(root, "")
        return { output: lines.join("\n") }
      } catch (e: any) {
        return { output: `Error: ${e?.message ?? String(e)}` }
      }
    },
  })

  const grep = tool({
    description:
      "Regex search across a file or directory. Returns matches as 'path:line:content', truncated at max_results (default 100).",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        pattern: { type: "string", description: "JS RegExp pattern" },
        path: { type: "string", description: "File or directory" },
        include: { type: "string", description: "Optional suffix filter, e.g. '.ts' or '*.ts'" },
        max_results: { type: "number", description: "default 100" },
      },
      required: ["pattern", "path"],
    }),
    execute: async (args: any) => {
      try {
        const re = new RegExp(String(args.pattern))
        const root = resolvePath(String(args.path), cwd)
        const max =
          typeof args.max_results === "number" && args.max_results > 0 ? args.max_results : MAX_GREP_RESULTS_DEFAULT
        // Treat include as a suffix filter only — minimatch is not in the
        // hook subsystem's dep set and grep is best-effort here. Strip a
        // leading '*' so '*.ts' and '.ts' both work.
        const includeRaw = typeof args.include === "string" ? args.include : ""
        const suffix = includeRaw.startsWith("*") ? includeRaw.slice(1) : includeRaw

        const out: string[] = []
        let total = 0

        const scanFile = async (filepath: string): Promise<void> => {
          if (suffix && !filepath.endsWith(suffix)) return
          let content: string
          try {
            content = await Effect.runPromise(fs.readFileString(filepath), { signal })
          } catch {
            signal.throwIfAborted()
            return
          }
          const lines = content.split("\n")
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              total++
              if (out.length < max) out.push(`${filepath}:${i + 1}:${lines[i]}`)
            }
          }
        }

        const walk = async (dir: string): Promise<void> => {
          const entries = await Effect.runPromise(fs.readDirectoryEntries(dir), { signal })
          for (const e of entries) {
            signal.throwIfAborted()
            const child = path.join(dir, e.name)
            if (e.type === "directory") await walk(child)
            else if (e.type === "file") await scanFile(child)
          }
        }

        const isDir = await Effect.runPromise(fs.isDir(root), { signal })
        if (isDir) await walk(root)
        else await scanFile(root)

        let body = out.join("\n")
        if (total > out.length) body += `\n... (${total - out.length} more)`
        return { output: body }
      } catch (e: any) {
        return { output: `Error: ${e?.message ?? String(e)}` }
      }
    },
  })

  const bash = tool({
    description:
      "Run one POSIX read-only command with restricted options: ls/cat/grep/find/git status/log/diff/show/sed -n/test/wc/head/tail/sort/uniq/echo/pwd/which/file/stat/du. Quotes are supported; shell syntax, interpreters and output-file options are rejected.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    }),
    execute: async (args: any) => {
      const command = String(args?.command ?? "")
      try {
        signal.throwIfAborted()
        const parsed = parseReadonlyCommand(command)
        const executable = readonlyExecutable(parsed.name)
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(executable, parsed.args, {
                  cwd,
                  extendEnv: true,
                  env: {
                    GIT_OPTIONAL_LOCKS: "0",
                    GIT_CONFIG_NOSYSTEM: "1",
                    GIT_CONFIG_GLOBAL: "/dev/null",
                    GIT_NO_LAZY_FETCH: "1",
                    GIT_TERMINAL_PROMPT: "0",
                  },
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "pipe",
                }),
              )
              const [stdout, stderr, code] = yield* Effect.all(
                [
                  Stream.mkString(Stream.decodeText(handle.stdout)),
                  Stream.mkString(Stream.decodeText(handle.stderr)),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              )
              return { stdout, stderr, code }
            }),
          ),
          { signal },
        )

        const body = `exit=${result.code}\n${result.stdout}` + (result.stderr ? `\n[stderr]\n${result.stderr}` : "")
        return { output: body.length > MAX_BASH_OUTPUT ? body.slice(0, MAX_BASH_OUTPUT) + "\n... (truncated)" : body }
      } catch (e: any) {
        return { output: `Error: ${e?.message ?? String(e)}` }
      }
    },
  })

  const synthetic_output = tool({
    description: "Emit the final hook decision and stop. Call this exactly once when ready to terminate.",
    inputSchema: HookEvaluatorOutputSchema,
    execute: async (args: any) => {
      try {
        signal.throwIfAborted()
        const parsed = HookEvaluatorOutputSchema.parse(args)
        if (!parsed.ok && !parsed.reason) throw new Error("reason is required when ok is false")
        captured.value = parsed
        return { output: "ok" }
      } catch (e: any) {
        return { output: `Error: ${e?.message ?? String(e)}` }
      }
    },
  })

  return { read_file, list_dir, grep, bash, synthetic_output }
}

export * as AgentTools from "./agent-tools"
