import { isRecord } from "@/util/record"
import { LocalPermissionStartup } from "@/permission/local-startup"
import { AppRuntime } from "@/effect/app-runtime"
import { HookClientLifecycle } from "@/hook/client-lifecycle"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
// CLI entry point for `opencode run` and `opencode --mini`.
//
// Handles three modes:
//   1. Non-interactive (default): sends a single prompt, streams events to
//      stdout, and exits when the session goes idle.
//   2. Interactive local (`opencode --mini`): boots the split-footer direct mode
//      with an in-process server (no external HTTP).
//   3. Interactive attach (`opencode --mini --attach`): connects to a running
//      opencode server and runs interactive mode against it.
//
// Also supports `--command` for slash-command execution, `--format json` for
// raw event streaming, `--continue` / `--session` for session resumption,
// and `--fork` for forking before continuing.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { open } from "node:fs/promises"
import { Effect, Option } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { createOpencodeClient, type OpencodeClient, type TextPart, type ToolPart } from "@opencode-ai/sdk/v2"
import { FormatError, FormatUnknownError } from "../error"
import { INTERACTIVE_INPUT_ERROR, resolveInteractiveStdin } from "./run/runtime.stdin"
import { DagHold } from "./run/dag-hold"
import { MessageID } from "@/session/schema"

type ModelInput = Parameters<OpencodeClient["session"]["prompt"]>[0]["model"]

function pick(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  } as ModelInput
}

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

async function tool(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    if (next.mode === "block") {
      block(next, next.body)
      return
    }

    inline(next)
  } catch {
    inline({
      icon: "\u2699",
      title: part.tool,
    })
  }
}

async function toolError(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    inline({
      icon: "✗",
      title: `${next.title} failed`,
      ...(next.description && { description: next.description }),
    })
    return
  } catch {
    inline({
      icon: "✗",
      title: `${part.tool} failed`,
    })
  }
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("mini", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("replay", {
        type: "boolean",
        default: true,
        hidden: true,
        describe: "replay interactive session history on resume and after resize (use --no-replay to disable)",
      })
      .option("replay-limit", {
        type: "number",
        hidden: true,
        describe: "cap visible interactive replay to the newest N messages",
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("init", {
        type: "boolean",
        describe: "run Setup hooks for one-time initialization, then continue the run",
        default: false,
      })
      .option("maintenance", {
        type: "boolean",
        describe: "run Setup hooks for maintenance, then continue the run",
        default: false,
      })
      .option("init-only", {
        type: "boolean",
        describe: "run Setup and startup SessionStart hooks, then exit without starting a conversation",
        default: false,
      })
      .option("demo", {
        type: "boolean",
        default: false,
        hidden: true,
        describe: "enable direct interactive demo slash commands; pass one as the message to run it immediately",
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const agentSvc = yield* Agent.Service
    const flags = yield* RuntimeFlags.Service
    const localInstance = yield* InstanceRef
    const { SettingsHook } = yield* Effect.promise(() => import("@/hook/settings"))
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    yield* Effect.promise(async () => {
      const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
      const interactive = args.mini
      const thinking = interactive ? (args.thinking ?? true) : (args.thinking ?? false)
      const die = (message: string): never => {
        UI.error(message)
        process.exit(1)
      }
      const dieInteractive = (error: unknown): never => {
        if (error instanceof Error && error.message === INTERACTIVE_INPUT_ERROR) {
          die(error.message)
        }

        throw error
      }

      let message = [...args.message, ...(args["--"] || [])]
        .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
        .join(" ")

      if (interactive && args.command) {
        die("--mini cannot be used with --command")
      }

      if (interactive && args._?.[0] !== "mini") {
        die("--mini must be used without the run subcommand")
      }

      if (args.demo && !interactive) {
        die("--demo requires --mini")
      }

      if (args.init && args.maintenance) {
        die("--init and --maintenance are mutually exclusive")
      }

      if (args.attach && (args.init || args.maintenance || args["init-only"])) {
        die("--init, --maintenance and --init-only cannot be used with --attach")
      }

      if (interactive && (args.init || args.maintenance || args["init-only"])) {
        die("--init, --maintenance and --init-only require a non-interactive run")
      }

      if (args["init-only"] && (args.session || args.continue || args.fork || args.command)) {
        die("--init-only cannot be combined with --session, --continue, --fork or --command")
      }

      if (interactive && args.format === "json") {
        die("--mini cannot be used with --format json")
      }

      if (args["replay-limit"] !== undefined && !interactive) {
        die("--replay-limit requires --mini")
      }

      if (
        args["replay-limit"] !== undefined &&
        (!Number.isInteger(args["replay-limit"]) || args["replay-limit"] <= 0)
      ) {
        die("--replay-limit must be a positive integer")
      }

      if (interactive && !process.stdout.isTTY) {
        die("--mini requires a TTY stdout")
      }

      if (interactive) {
        try {
          resolveInteractiveStdin().cleanup?.()
        } catch (error) {
          dieInteractive(error)
        }
      }

      const replay = args.replay === false ? false : args.replay || args["replay-limit"] !== undefined

      const localSessionIDs = new Set<string>()
      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          UI.error("Failed to change directory to " + args.dir)
          process.exit(1)
        }
      })()
      const attachHeaders = args.attach
        ? ServerAuth.headers({ password: args.password, username: args.username })
        : undefined
      const attachSDK = (dir?: string) => {
        return createOpencodeClient({
          baseUrl: args.attach!,
          directory: dir,
          headers: attachHeaders,
        })
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(`File not found: ${filePath}`)
            process.exit(1)
          }

          const stat = Filesystem.stat(resolvedPath)
          const isDirectory = stat?.isDirectory() ?? false
          if (args.attach && isDirectory) {
            UI.error(`Cannot attach local directory without a shared filesystem: ${filePath}`)
            process.exit(1)
          }

          const content = await (async () => {
            if (!args.attach) return
            const handle = await open(resolvedPath, "r")
            try {
              const opened = await handle.stat()
              if (!opened.isFile() || Number(opened.size) > ATTACH_FILE_MAX_BYTES) {
                UI.error(`Cannot attach local file larger than 10 MiB or a special file: ${filePath}`)
                process.exit(1)
              }
              if (opened.size === 0) return Buffer.alloc(0)
              const buffer = Buffer.alloc(Number(opened.size))
              let offset = 0
              while (offset < buffer.length) {
                const read = await handle.read(buffer, offset, buffer.length - offset, offset)
                if (read.bytesRead === 0) break
                offset += read.bytesRead
              }
              return buffer.subarray(0, offset)
            } finally {
              await handle.close()
            }
          })()
          const detected = FSUtil.mimeType(resolvedPath)
          const text = content?.toString("utf8")
          const mime = !args.attach
            ? isDirectory
              ? "application/x-directory"
              : "text/plain"
            : content && text !== undefined && Buffer.from(text, "utf8").equals(content)
              ? "text/plain"
              : detected

          files.push({
            type: "file",
            url: content ? `data:${mime};base64,${content.toString("base64")}` : pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
      message = resolveRunInput(message, piped) ?? ""
      const initialInput = resolveRunInput(rawMessage, piped)

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exit(1)
      }

      const rules: PermissionV1.Ruleset = interactive
        ? []
        : [
            {
              permission: "question",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_enter",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_exit",
              action: "deny",
              pattern: "*",
            },
          ]

      function title() {
        if (args.title === undefined) return
        if (args.title !== "") return args.title
        return message.slice(0, 50) + (message.length > 50 ? "..." : "")
      }

      async function session(sdk: OpencodeClient, agent?: string): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.session
            .get({
              sessionID: args.session,
            })
            .catch(() => undefined)

          if (!current?.data) {
            UI.error("Session not found")
            process.exit(1)
          }

          if (args.fork) {
            const forked = await sdk.session.fork({
              sessionID: args.session,
            })
            const id = forked.data?.id
            if (!id) {
              return
            }

            return {
              id,
              title: forked.data?.title ?? current.data.title,
              directory: forked.data?.directory ?? current.data.directory,
            }
          }

          return {
            id: current.data.id,
            title: current.data.title,
            directory: current.data.directory,
          }
        }

        const base = args.continue ? (await sdk.session.list()).data?.find((item) => !item.parentID) : undefined

        if (base && args.fork) {
          const forked = await sdk.session.fork({
            sessionID: base.id,
          })
          const id = forked.data?.id
          if (!id) {
            return
          }

          return {
            id,
            title: forked.data?.title ?? base.title,
            directory: forked.data?.directory ?? base.directory,
          }
        }

        if (base) {
          return {
            id: base.id,
            title: base.title,
            directory: base.directory,
          }
        }

        const name = title()
        const selectedModel = pick(args.model)
        const result = await sdk.session.create({
          title: name,
          agent,
          ...(selectedModel
            ? { model: { providerID: selectedModel.providerID, id: selectedModel.modelID, variant: args.variant } }
            : {}),
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          return
        }

        return {
          id,
          title: result.data?.title ?? name,
          directory: result.data?.directory,
        }
      }

      async function share(sdk: OpencodeClient, sessionID: string) {
        const cfg = await sdk.config.get()
        if (!cfg.data) return
        if (cfg.data.share !== "auto" && !flags.autoShare && !args.share) return
        const res = await sdk.session.share({ sessionID }).catch((error) => {
          if (error instanceof Error && error.message.includes("disabled")) {
            UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
          }
          return { error }
        })
        if (!res.error && "data" in res && res.data?.share?.url) {
          UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + res.data.share.url)
        }
      }

      async function createFreshSession(
        sdk: OpencodeClient,
        input: { agent: string | undefined; model: ModelInput | undefined; variant: string | undefined },
      ): Promise<SessionInfo> {
        const result = await sdk.session.create({
          title: args.title !== undefined && args.title !== "" ? args.title : undefined,
          agent: input.agent,
          model: input.model
            ? {
                providerID: input.model.providerID,
                id: input.model.modelID,
                variant: input.variant,
              }
            : undefined,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          throw new Error("Failed to create session")
        }

        if (!args.attach) localSessionIDs.add(id)
        void share(sdk, id).catch(() => {})
        return {
          id,
          title: result.data?.title,
        }
      }

      async function current(sdk: OpencodeClient): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.path
          .get()
          .then((x) => x.data?.directory)
          .catch(() => undefined)
        if (next) {
          return next
        }

        UI.error("Failed to resolve remote directory")
        process.exit(1)
      }

      async function localAgent() {
        if (!args.agent) return undefined
        const name = args.agent

        const entry = await Effect.runPromise(
          agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance)),
        )
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return name
      }

      async function attachAgent(sdk: OpencodeClient) {
        if (!args.agent) return undefined
        const name = args.agent

        const modes = await sdk.app
          .agents(undefined, { throwOnError: true })
          .then((x) => x.data ?? [])
          .catch(() => undefined)

        if (!modes) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `failed to list agents from ${args.attach}. Falling back to default agent`,
          )
          return undefined
        }

        const agent = modes.find((a) => a.name === name)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }

        if (agent.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }

        return name
      }

      async function pickAgent(sdk: OpencodeClient) {
        if (!args.agent) return undefined
        if (args.attach) {
          return attachAgent(sdk)
        }

        return localAgent()
      }

      async function execute(sdk: OpencodeClient) {
        const localSelectedAgent = args.attach ? undefined : await pickAgent(sdk)
        const sess = await session(sdk, localSelectedAgent)
        if (!sess?.id) {
          UI.error("Session not found")
          process.exit(1)
        }
        const sessionID = sess.id
        if (!args.attach) localSessionIDs.add(sessionID)
        let dagHold: DagHold.DagHold | undefined

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        function renderText(part: TextPart) {
          if (dagHold?.hasText(part)) return
          if (!emit("text", { part })) {
            const text = (part.displayText ?? part.text).trim()
            if (text) {
              if (!process.stdout.isTTY) process.stdout.write(text + EOL)
              else {
                UI.empty()
                UI.println(text)
                UI.empty()
              }
            }
          }
          dagHold?.onText(part)
        }

        // Consume one subscribed event stream for the active session and mirror it
        // to stdout/UI. `client` is passed explicitly because attach mode may
        // rebind the SDK to the session's directory after the subscription is
        // created, and replies issued from inside the loop must use that client.
        async function loop(
          client: OpencodeClient,
          events: Awaited<ReturnType<typeof sdk.event.subscribe>>,
          stop: () => void,
          keepAlive?: () => boolean,
        ) {
          const toggles = new Map<string, boolean>()
          let error: string | undefined
          // Issue 614: consumer-only DAG hold. Poll dag.bySession on the
          // busy/idle transitions of the target session and keep consuming
          // events while a session workflow may still owe a wake turn. Attach
          // mode keeps today's break-on-first-idle exit.

          try {
            for await (const event of dagHold || keepAlive
              ? DagHold.pollEvents(events.stream, sessionID, stop)
              : events.stream) {
              if (
                event.type === "message.updated" &&
                event.properties.sessionID === sessionID &&
                event.properties.info.role === "user" &&
                dagHold
              )
                dagHold.onUserMessage(event.properties.info.id)
              if (
                event.type === "message.updated" &&
                event.properties.sessionID === sessionID &&
                event.properties.info.role === "assistant" &&
                args.format !== "json" &&
                toggles.get("start") !== true
              ) {
                UI.empty()
                UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
                UI.empty()
                toggles.set("start", true)
              }

              if (event.type === "message.part.updated") {
                const part = event.properties.part
                if (part.sessionID !== sessionID) continue

                if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                  if (emit("tool_use", { part })) continue
                  if (part.state.status === "completed") {
                    await tool(part)
                    continue
                  }
                  await toolError(part)
                  UI.error(part.state.error)
                }

                if (
                  part.type === "tool" &&
                  part.tool === "task" &&
                  part.state.status === "running" &&
                  args.format !== "json"
                ) {
                  if (toggles.get(part.id) === true) continue
                  await tool(part)
                  toggles.set(part.id, true)
                }

                if (part.type === "step-start") {
                  if (emit("step_start", { part })) continue
                }

                if (part.type === "step-finish") {
                  if (emit("step_finish", { part })) continue
                }

                if (part.type === "text" && part.time?.end) {
                  renderText(part)
                }

                if (part.type === "reasoning" && part.time?.end && thinking) {
                  if (emit("reasoning", { part })) continue
                  const text = part.text.trim()
                  if (!text) continue
                  const line = `Thinking: ${text}`
                  if (process.stdout.isTTY) {
                    UI.empty()
                    UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                    UI.empty()
                    continue
                  }
                  process.stdout.write(line + EOL)
                }
              }

              if (event.type === "session.error") {
                const props = event.properties
                if (props.sessionID !== sessionID || !props.error) continue
                let err = String(props.error.name)
                if ("data" in props.error && props.error.data && "message" in props.error.data) {
                  err = String(props.error.data.message)
                }
                error = error ? error + EOL + err : err
                if (emit("error", { error: props.error })) continue
                UI.error(err)
              }

              if (event.type === "session.status" && event.properties.sessionID === sessionID) {
                if (event.properties.status.type === "busy") {
                  await dagHold?.onBusy()
                }
                if (event.properties.status.type === "idle" && (await dagHold?.onIdle()) !== "hold" && !keepAlive?.())
                  break
              }

              if (event.type === "permission.asked") {
                const permission = event.properties
                if (permission.sessionID !== sessionID) continue

                if (args["dangerously-skip-permissions"]) {
                  await client.permission.reply({
                    requestID: permission.id,
                    reply: "once",
                  })
                } else {
                  UI.println(
                    UI.Style.TEXT_WARNING_BOLD + "!",
                    UI.Style.TEXT_NORMAL +
                      `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
                  )
                  await client.permission.reply({
                    requestID: permission.id,
                    reply: "reject",
                  })
                }
              }
            }
          } finally {
            stop()
          }
          return error
        }
        const cwd = args.attach ? (directory ?? sess.directory ?? (await current(sdk))) : (directory ?? root)
        const client = args.attach ? attachSDK(cwd) : sdk

        // Validate agent if specified
        const agent = args.attach ? await pickAgent(client) : localSelectedAgent

        await share(client, sessionID)

        if (!interactive) {
          if (args.init || args.maintenance || args["init-only"]) {
            if (!settingsHook) return die("Setup hooks are unavailable in this run")
            const { HookTranscript } = await import("@/hook/transcript")
            const transcriptPath = await Effect.runPromise(
              HookTranscript.materialize({ sessionID, directory: cwd, messages: [] }),
            )
            const environmentFile = await Effect.runPromise(HookTranscript.environmentFile(sessionID))
            await Effect.runPromise(
              settingsHook
                .trigger(
                  { event: "Setup", trigger: args.maintenance ? "maintenance" : "init" },
                  { sessionID, transcriptPath, environmentFile },
                )
                .pipe(Effect.provideService(InstanceRef, localInstance), Effect.ignore),
            )
          }
          // --init-only runs Setup plus the session's startup SessionStart and
          // exits without starting a conversation.
          if (args["init-only"]) return undefined
          const model = pick(args.model)
          let subscription!: AbortController
          let completed!: Promise<string | undefined | void>
          let requestedMessageID: string | undefined
          let requestPending = true
          async function begin() {
            subscription = new AbortController()
            const events = await client.event.subscribe(undefined, { signal: subscription.signal })
            requestedMessageID = args.attach || !hasInput ? undefined : MessageID.ascending()
            dagHold = args.attach
              ? undefined
              : await DagHold.createDagRunHold(client, sessionID, requestedMessageID, renderText)
            completed = loop(
              client,
              events,
              () => subscription.abort(),
              () => requestPending,
            ).catch((error) => {
              if (!subscription.signal.aborted) {
                console.error(error)
                process.exitCode = 1
              }
            })
          }
          async function finish() {
            if (args.attach) return
            if (await completed) process.exitCode = 1
          }
          function fail(error: unknown) {
            requestPending = false
            subscription.abort()
            if (!emit("error", { error })) UI.error(formatRunError(error))
            process.exitCode = 1
          }
          function deferred(
            result: { info: import("@opencode-ai/sdk/v2").Message; parts: Array<unknown> } | null | undefined,
          ) {
            const reason = result?.info.role === "assistant" ? result.info.finish : undefined
            if (!result || (reason !== "tool_deferred" && reason !== "tool_deferred_unavailable")) return false
            const part = result.parts.find((value): value is import("@opencode-ai/sdk/v2").ToolPart => {
              return (
                isRecord(value) &&
                value.type === "tool" &&
                typeof value.callID === "string" &&
                typeof value.tool === "string" &&
                isRecord(value.state) &&
                value.state.status === "pending" &&
                value.state.deferred === true &&
                isRecord(value.state.input)
              )
            })
            emit("result", {
              stop_reason: reason,
              session_id: sessionID,
              ...(part ? { deferred_tool_use: { id: part.callID, name: part.tool, input: part.state.input } } : {}),
              is_error: reason === "tool_deferred_unavailable",
            })
            if (reason === "tool_deferred_unavailable") process.exitCode = 1
            return true
          }
          const hasInput = Boolean(args.command || message.trim() || files.length)
          await begin()
          const initial = await client.session.resume({
            sessionID,
            hookMode: "noninteractive",
            initialOnly: hasInput,
            messageID: requestedMessageID,
            model,
            agent,
            variant: args.variant,
            ...(hasInput
              ? {
                  followup: args.command
                    ? {
                        kind: "command" as const,
                        command: args.command,
                        arguments: message,
                        agent,
                        model: args.model,
                        variant: args.variant,
                        parts: files,
                      }
                    : {
                        kind: "prompt" as const,
                        parts: [...files, { type: "text" as const, text: message }],
                        agent,
                        model,
                        variant: args.variant,
                      },
                }
              : {}),
          })
          if (initial.error) {
            fail(initial.error)
            return
          }
          if (initial.data) {
            requestPending = false
            if (deferred(initial.data)) {
              subscription.abort()
              await completed
              return
            }
            await finish()
            return
          }
          if (args.command) {
            const result = await client.session.command({
              hookMode: "noninteractive",
              sessionID,
              messageID: requestedMessageID,
              agent,
              model: args.model,
              command: args.command,
              arguments: message,
              variant: args.variant,
            })
            if (result.error) {
              fail(result.error)
              return
            }
            requestPending = false
            await finish()
            deferred(result.data)
            return
          }
          const result = await client.session.prompt({
            hookMode: "noninteractive",
            sessionID,
            messageID: requestedMessageID,
            agent,
            model,
            variant: args.variant,
            parts: [...files, { type: "text", text: message }],
          })
          if (result.error) {
            fail(result.error)
            return
          }
          requestPending = false
          await finish()
          deferred(result.data)
          return
        }

        const model = pick(args.model)
        const { runInteractiveMode } = await import("./run/runtime")
        try {
          await runInteractiveMode({
            sdk: client,
            directory: cwd,
            sessionID,
            sessionTitle: sess.title,
            resume: Boolean(args.session || args.continue) && !args.fork,
            replay,
            replayLimit: args["replay-limit"],
            agent,
            model,
            variant: args.variant,
            files,
            initialInput,
            createSession: createFreshSession,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
        return
      }

      try {
        if (interactive && !args.attach && !args.session && !args.continue) {
          const model = pick(args.model)
          const { runInteractiveLocalMode } = await import("./run/runtime")
          const fetchFn = Object.assign(
            async (input: RequestInfo | URL, init?: RequestInit) => {
              const { Server } = await import("@/server/server")
              const request = new Request(input, init)
              const headers = new Headers(request.headers)
              const auth = ServerAuth.header()
              if (auth) headers.set("Authorization", auth)
              const localRequest = new Request(request, { headers })
              if (
                args["dangerously-skip-permissions"] &&
                localRequest.method === "POST" &&
                new URL(localRequest.url).pathname === "/session"
              )
                LocalPermissionStartup.mark(localRequest)
              return Server.Default().app.fetch(localRequest)
            },
            { preconnect: globalThis.fetch.preconnect },
          )

          try {
            return await runInteractiveLocalMode({
              directory: directory ?? root,
              fetch: fetchFn,
              resolveAgent: localAgent,
              session,
              share,
              createSession: createFreshSession,
              agent: args.agent,
              model,
              variant: args.variant,
              replay,
              replayLimit: args["replay-limit"],
              files,
              initialInput,
              thinking,
              backgroundSubagents: flags.experimentalBackgroundSubagents,
              demo: args.demo,
            })
          } catch (error) {
            dieInteractive(error)
          }
        }

        if (args.attach) {
          const sdk = attachSDK(directory)
          return await execute(sdk)
        }

        const fetchFn = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const { Server } = await import("@/server/server")
            const request = new Request(input, init)
            const headers = new Headers(request.headers)
            const auth = ServerAuth.header()
            if (auth) headers.set("Authorization", auth)
            const localRequest = new Request(request, { headers })
            if (args["dangerously-skip-permissions"] && localRequest.method === "POST") {
              const pathname = new URL(localRequest.url).pathname
              if (pathname === "/session") LocalPermissionStartup.mark(localRequest)
              else if (args.session || args.continue || args.fork) {
                const selected = /^\/session\/([^/]+)\/(message|prompt|prompt_async|command|resume)$/.exec(
                  pathname,
                )?.[1]
                if (selected && localSessionIDs.has(selected)) LocalPermissionStartup.mark(localRequest, selected)
              }
            }
            return Server.Default().app.fetch(localRequest)
          },
          { preconnect: globalThis.fetch.preconnect },
        )
        const sdk = createOpencodeClient({
          baseUrl: "http://opencode.internal",
          fetch: fetchFn,
          directory,
        })
        await execute(sdk)
      } finally {
        for (const sessionID of localSessionIDs)
          await AppRuntime.runPromise(
            HookClientLifecycle.endLocalSession({
              sessionID,
              directory: directory ?? root,
              reason: interactive ? "prompt_input_exit" : "other",
            }).pipe(Effect.catchCause(() => Effect.void)),
          )
      }
    })
  }),
})

type MiniCommandInput = {
  directory?: string
  attach?: string
  password?: string
  username?: string
  continue?: boolean
  session?: string
  fork?: boolean
  model?: string
  agent?: string
  prompt?: string
  replay?: boolean
  replayLimit?: number
  demo?: boolean
}

export async function runMini(input: MiniCommandInput) {
  if (!RunCommand.handler) throw new Error("Mini command handler is unavailable")
  await RunCommand.handler({
    $0: "opencode",
    _: ["mini"],
    message: input.prompt ? [input.prompt] : [],
    command: undefined,
    continue: input.continue,
    session: input.session,
    fork: input.fork,
    share: undefined,
    model: input.model,
    agent: input.agent,
    format: "default",
    file: undefined,
    title: undefined,
    attach: input.attach,
    password: input.password,
    username: input.username,
    dir: input.directory,
    port: undefined,
    variant: undefined,
    thinking: undefined,
    mini: true,
    replay: input.replay ?? true,
    "replay-limit": input.replayLimit,
    replayLimit: input.replayLimit,
    "dangerously-skip-permissions": false,
    dangerouslySkipPermissions: false,
    demo: input.demo ?? false,
    init: false,
    maintenance: false,
    "init-only": false,
    initOnly: false,
  })
}
