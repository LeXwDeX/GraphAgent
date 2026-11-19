import { isRecord } from "@/util/record"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { LocalPermissionStartup } from "@/permission/local-startup"
import { ClientSessions } from "@/session/client-sessions"
import { AppRuntime } from "@/effect/app-runtime"
import { ClientDetach } from "@/session/client-detach"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { APP_NAME } from "@graphagent/core/brand"
// CLI entry point for `graphagent run` and `graphagent --mini`.
//
// Handles three modes:
//   1. Non-interactive (default): sends a single prompt, streams events to
//      stdout, and exits when the session goes idle.
//   2. Interactive local (`graphagent --mini`): boots the split-footer direct mode
//      with an in-process server (no external HTTP).
//
// Also supports `--command` for slash-command execution, `--format json` for
// raw event streaming, `--continue` / `--session` for session resumption,
// and `--fork` for forking before continuing.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Option } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { createClient, type Client, type TextPart, type ToolPart } from "@graphagent/sdk"
import { FormatError, FormatUnknownError } from "../error"
import { INTERACTIVE_INPUT_ERROR, resolveInteractiveStdin } from "./run/runtime.stdin"
import { readPipedInput, resolveRunInput } from "./run/piped-input"
import { DagHold } from "./run/dag-hold"
import { interactiveMarkable, nonInteractiveMarkable, type LocalFetchMark } from "./run/authorization"
import { askedPermission, locationHeaders, permissionAnswerer } from "./run/permission-answer"
import { sessionTree } from "./run/permission-tree"
import { MessageID } from "@/session/schema"
import { t } from "@graphagent/tui/i18n"

type ModelInput = Parameters<Client["session"]["prompt"]>[0]["model"]

function pick(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  } as ModelInput
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

/**
 * The in-process transport for `run` and `--mini`.
 *
 * The request is constructed exactly once and `LocalPermissionStartup.mark`
 * runs on that final object: marking a copy would drop the startup grant.
 * Each mode supplies its own authorisation rule so `--mini` cannot widen the
 * non-interactive scope.
 */
function createLocalFetch(options: {
  skipPermissions: boolean
  markable: (method: string, pathname: string) => LocalFetchMark
}): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { Server } = await import("@/server/server")
    const request = new Request(input, init)
    if (options.skipPermissions) {
      const mark = options.markable(request.method, new URL(request.url).pathname)
      if (mark) LocalPermissionStartup.mark(request, mark.sessionID)
    }
    return Server.Default().app.fetch(request)
  }
  return Object.assign(fn, { preconnect: globalThis.fetch.preconnect })
}

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
      title: t("cli.run.toolFailed", { title: next.title }),
      ...(next.description && { description: next.description }),
    })
    return
  } catch {
    inline({
      icon: "✗",
      title: t("cli.run.toolFailed", { title: part.tool }),
    })
  }
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: t("cli.run.describe", { app: APP_NAME }),
  // For --dir, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  loadOptions: (args) => (args["trust-project"] ? { trustProject: true } : {}),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: t("cli.run.option.message"),
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: t("cli.run.option.command"),
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: t("cli.run.option.continue"),
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: t("cli.run.option.session"),
        type: "string",
      })
      .option("fork", {
        describe: t("cli.run.option.fork"),
        type: "boolean",
      })
      .option("dag-mode", {
        describe: t("cli.run.option.dagMode"),
        type: "string",
        choices: ["on", "off"] as const,
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: t("cli.run.option.model"),
      })
      .option("agent", {
        type: "string",
        describe: t("cli.run.option.agent"),
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: t("cli.run.option.format"),
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: t("cli.run.option.file"),
      })
      .option("title", {
        type: "string",
        describe: t("cli.run.option.title"),
      })
      .option("dir", {
        type: "string",
        describe: t("cli.run.option.dir"),
      })
      .option("variant", {
        type: "string",
        describe: t("cli.run.option.variant"),
      })
      .option("thinking", {
        type: "boolean",
        describe: t("cli.run.option.thinking"),
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
        describe: t("cli.run.option.replay"),
      })
      .option("replay-limit", {
        type: "number",
        hidden: true,
        describe: t("cli.run.option.replayLimit"),
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        describe: t("cli.run.option.dangerouslySkipPermissions"),
        default: false,
      })
      .option("init", {
        type: "boolean",
        describe: t("cli.run.option.init"),
        default: false,
      })
      .option("maintenance", {
        type: "boolean",
        describe: t("cli.run.option.maintenance"),
        default: false,
      })
      .option("init-only", {
        type: "boolean",
        describe: t("cli.run.option.initOnly"),
        default: false,
      })
      .option("demo", {
        type: "boolean",
        default: false,
        hidden: true,
        describe: t("cli.run.option.demo"),
      })
      .option("trust-project", {
        type: "boolean",
        describe: t("cli.run.option.trustProject"),
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const agentSvc = yield* Agent.Service
    const localInstance = yield* InstanceRef
    const { SettingsHook } = yield* Effect.promise(() => import("@/hook"))
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    // #1324: the permission tier of unattended sessions tells this run what happens to a node's question.
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const dagPermission = (yield* Config.use.dagGlobal()).permission
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
          die(t("cli.run.error.miniNeedsInput"))
        }

        throw error
      }

      let message = [...args.message, ...(args["--"] || [])]
        .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
        .join(" ")

      if (interactive && args.command) {
        die(t("cli.run.error.miniWithCommand"))
      }

      // yargs' `conflicts` treats the `--mini` default as provided, which would
      // reject every plain `run --trust-project`; check the resolved values instead.
      if (interactive && args["trust-project"]) {
        die(t("cli.run.error.trustProjectWithMini"))
      }

      if (interactive && args._?.[0] !== "mini") {
        die(t("cli.run.error.miniSubcommand"))
      }

      if (args.demo && !interactive) {
        die(t("cli.run.error.requiresMini", { flag: "--demo" }))
      }

      if (args.init && args.maintenance) {
        die(t("cli.run.error.initAndMaintenance"))
      }

      if (interactive && (args.init || args.maintenance || args["init-only"])) {
        die(t("cli.run.error.setupNeedsNonInteractive"))
      }

      if (args["init-only"] && (args.session || args.continue || args.fork || args.command)) {
        die(t("cli.run.error.initOnlyConflicts"))
      }

      if (interactive && args.format === "json") {
        die(t("cli.run.error.miniWithJson"))
      }

      if (args["replay-limit"] !== undefined && !interactive) {
        die(t("cli.run.error.requiresMini", { flag: "--replay-limit" }))
      }

      if (
        args["replay-limit"] !== undefined &&
        (!Number.isInteger(args["replay-limit"]) || args["replay-limit"] <= 0)
      ) {
        die(t("cli.run.error.replayLimitPositive"))
      }

      if (interactive && !process.stdout.isTTY) {
        die(t("cli.run.error.miniNeedsTty"))
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
        if (!args.dir) return root

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          UI.error(t("cli.run.error.changeDirectory", { dir: args.dir }))
          process.exit(1)
        }
      })()

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(directory ?? root, filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(t("cli.run.error.fileNotFound", { file: filePath }))
            process.exit(1)
          }

          const stat = Filesystem.stat(resolvedPath)
          const isDirectory = stat?.isDirectory() ?? false
          files.push({
            type: "file",
            url: pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime: isDirectory ? "application/x-directory" : "text/plain",
          })
        }
      }

      // With a message on the command line, a pipe that stays silent is not waited for (#1546).
      const piped = process.stdin.isTTY
        ? undefined
        : await readPipedInput({ stream: Bun.stdin.stream(), hasMessage: message !== "" })
      message = resolveRunInput(message, piped) ?? ""
      const initialInput = resolveRunInput(rawMessage, piped)

      if (args.fork && !args.continue && !args.session) {
        UI.error(t("cli.run.error.forkNeedsSession"))
        process.exit(1)
      }

      if (args["dag-mode"] && args.session) {
        UI.error(t("cli.run.error.dagModeWithSession"))
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

      async function session(sdk: Client, agent?: string): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.session
            .get({
              sessionID: args.session,
            })
            .catch(() => undefined)

          if (!current?.data) {
            UI.error(t("cli.run.error.sessionNotFound"))
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

        const base = args.continue ? (await sdk.session.list()).data?.find((item) => item.role === "root") : undefined

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
          ...(args["dag-mode"] ? { dagMode: args["dag-mode"] } : {}),
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          return
        }
        if (args["dag-mode"])
          UI.println(
            UI.Style.TEXT_DIM +
              t(args["dag-mode"] === "on" ? "cli.run.dagMode.on" : "cli.run.dagMode.off") +
              UI.Style.TEXT_NORMAL,
          )

        return {
          id,
          title: result.data?.title ?? name,
          directory: result.data?.directory,
        }
      }

      async function createFreshSession(
        sdk: Client,
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
          ...(args["dag-mode"] ? { dagMode: args["dag-mode"] } : {}),
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          throw new Error(t("cli.run.error.sessionCreateFailed"))
        }
        if (args["dag-mode"])
          UI.println(
            UI.Style.TEXT_DIM +
              t(args["dag-mode"] === "on" ? "cli.run.dagMode.on" : "cli.run.dagMode.off") +
              UI.Style.TEXT_NORMAL,
          )

        localSessionIDs.add(id)
        ClientSessions.touch({ sessionID: id, directory })
        return {
          id,
          title: result.data?.title,
        }
      }

      async function localAgent() {
        if (!args.agent) return undefined
        const name = args.agent

        const entry = await Effect.runPromise(
          agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance)),
        )
        if (!entry) {
          UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL, t("cli.run.agentNotFound", { name }))
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL, t("cli.run.agentIsSubagent", { name }))
          return undefined
        }
        return name
      }

      async function pickAgent() {
        return localAgent()
      }

      async function execute(sdk: Client) {
        const localSelectedAgent = await pickAgent()
        const sess = await session(sdk, localSelectedAgent)
        if (!sess?.id) {
          UI.error(t("cli.run.error.sessionNotFound"))
          process.exit(1)
        }
        const sessionID = sess.id
        localSessionIDs.add(sessionID)
        ClientSessions.touch({ sessionID, directory })
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
        // to stdout/UI.
        async function loop(
          client: Client,
          events: Awaited<ReturnType<typeof sdk.event.subscribe>>,
          stop: () => void,
          keepAlive?: () => boolean,
        ) {
          const toggles = new Map<string, boolean>()
          const tree = sessionTree(sessionID, async (id) => {
            const found = await client.session.get({ sessionID: id })
            if (!found.data) throw new Error(`session ${id} not found`)
            return found.data.parentID ?? undefined
          })
          const warn = (line: string) => UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL + line)
          const answer = permissionAnswerer({
            sessionID,
            tree,
            approveOwn: args["dangerously-skip-permissions"],
            say: warn,
            reply: async (requestID, reply, location) => {
              const result = await client.permission.reply(
                { requestID, reply },
                location ? { headers: locationHeaders(location) } : undefined,
              )
              if (result.error) warn(t("cli.run.permissionUnanswered", { id: requestID }))
            },
          })
          // A node that runs in another directory (isolated in a worktree, or bound to one) asks
          // there. The server filters the event stream by the client's directory, so that request
          // never reaches this stream; the process-wide bus carries every directory's events, and
          // the answer goes to the directory that holds the request (#1324).
          const onBus = (event: GlobalEvent) => {
            if (!isRecord(event.payload) || event.payload.type !== "permission.asked") return
            const request = askedPermission(event.payload.properties)
            if (!request) return
            answer(request, { directory: event.directory, workspace: event.workspace }).catch((cause) =>
              warn(t("cli.run.permissionUnansweredBecause", { id: request.id, reason: formatRunError(cause) })),
            )
          }
          GlobalBus.on("event", onBus)
          let error: string | undefined
          // Issue 614: consumer-only DAG hold. Sample dag.bySession on the
          // busy/idle transitions of the target session and on the DAG summary
          // pushes that replace the old 1s poll (#1027 PR5); keep consuming
          // events while a session workflow may still owe a wake turn. The
          // recheck channel carries a grace verdict back to the event loop so
          // it can schedule the one check no event will drive.
          const recheck: DagHold.DagHoldRecheck = { pending: false }

          try {
            for await (const event of dagHold || keepAlive
              ? DagHold.pollEvents(events.stream, sessionID, stop, keepAlive, undefined, recheck)
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
                  const line = t("cli.run.thinking", { text })
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
                const data: unknown = props.error.data
                if (typeof data === "object" && data !== null && "message" in data) {
                  err = String(data.message)
                }
                error = error ? error + EOL + err : err
                if (emit("error", { error: props.error })) continue
                UI.error(err)
              }

              if (event.type === "session.status" && event.properties.sessionID === sessionID) {
                if (event.properties.status.type === "busy") {
                  await dagHold?.onBusy()
                }
                if (event.properties.status.type === "idle") {
                  const decision = await dagHold?.onIdle()
                  if (dagHold?.needsRecheck()) recheck.pending = true
                  if (decision !== "hold" && !keepAlive?.()) break
                }
              }

              // The run answers for its whole session tree: a workflow node or a task agent asks
              // as a session of its own, and nobody else could answer it here (#1324). The skip
              // flag covers the session the run drives; descendants are never approved by it.
              if (event.type === "permission.asked") await answer(event.properties)
            }
          } finally {
            GlobalBus.off("event", onBus)
            stop()
          }
          return error
        }
        const cwd = directory ?? root
        const client = sdk
        const agent = localSelectedAgent

        if (!interactive) {
          if (args.init || args.maintenance || args["init-only"]) {
            if (!settingsHook) return die(t("cli.run.error.setupHooksUnavailable"))
            await Effect.runPromise(
              settingsHook
                .trigger({ event: "Setup", trigger: args.maintenance ? "maintenance" : "init" }, { sessionID })
                .pipe(Effect.provideService(InstanceRef, localInstance), Effect.ignore),
            )
          }
          // --init-only runs Setup plus the session's startup SessionStart and
          // exits without starting a conversation.
          if (args["init-only"]) return undefined
          if (dagPermission === "ask")
            UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL + t("cli.run.dagPermissionAsk"))
          const model = pick(args.model)
          let subscription!: AbortController
          let completed!: Promise<string | undefined | void>
          let requestedMessageID: string | undefined
          let requestPending = true
          async function begin() {
            subscription = new AbortController()
            const events = await client.event.subscribe({ signal: subscription.signal })
            requestedMessageID = !hasInput ? undefined : MessageID.ascending()
            dagHold = await DagHold.createDagRunHold(client, sessionID, requestedMessageID, renderText)
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
            if (await completed) process.exitCode = 1
          }
          function fail(error: unknown) {
            requestPending = false
            subscription.abort()
            if (!emit("error", { error })) UI.error(formatRunError(error))
            process.exitCode = 1
          }
          function deferred(
            result: { info: import("@graphagent/sdk").Message; parts: Array<unknown> } | null | undefined,
          ) {
            const reason = result?.info.role === "assistant" ? result.info.finish : undefined
            if (!result || (reason !== "tool_deferred" && reason !== "tool_deferred_unavailable")) return false
            const part = result.parts.find((value): value is import("@graphagent/sdk").ToolPart => {
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
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
        return
      }

      try {
        if (interactive && !args.session && !args.continue) {
          const model = pick(args.model)
          const { runInteractiveLocalMode } = await import("./run/runtime")
          const fetchFn = createLocalFetch({
            skipPermissions: Boolean(args["dangerously-skip-permissions"]),
            markable: interactiveMarkable,
          })

          try {
            return await runInteractiveLocalMode({
              directory: directory ?? root,
              fetch: fetchFn,
              resolveAgent: localAgent,
              session,
              createSession: createFreshSession,
              agent: args.agent,
              model,
              variant: args.variant,
              replay,
              replayLimit: args["replay-limit"],
              files,
              initialInput,
              thinking,
              demo: args.demo,
            })
          } catch (error) {
            dieInteractive(error)
          }
        }

        const fetchFn = createLocalFetch({
          skipPermissions: Boolean(args["dangerously-skip-permissions"]),
          markable: nonInteractiveMarkable(
            { session: args.session, continue: args.continue, fork: args.fork },
            localSessionIDs,
          ),
        })
        const sdk = createClient({
          baseUrl: "http://graphagent.internal", // check-private-hosts: allow in-process dummy base URL
          fetch: fetchFn,
          directory,
        })
        await execute(sdk)
      } finally {
        for (const { sessionID, directory } of ClientSessions.list())
          await AppRuntime.runPromise(
            ClientDetach.local({
              sessionID,
              directory,
              reason: interactive ? "prompt_input_exit" : "other",
            }).pipe(Effect.catchCause(() => Effect.void)),
          )
        ClientSessions.clear()
      }
    })
  }),
})

type MiniCommandInput = {
  directory?: string
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
    $0: "graphagent",
    _: ["mini"],
    message: input.prompt ? [input.prompt] : [],
    command: undefined,
    continue: input.continue,
    session: input.session,
    fork: input.fork,
    "dag-mode": undefined,
    dagMode: undefined,
    model: input.model,
    agent: input.agent,
    format: "default",
    file: undefined,
    title: undefined,
    dir: input.directory,
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
    "trust-project": false,
    trustProject: false,
  })
}
