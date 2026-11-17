import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import type { WorkerEvents, WorkerMethods } from "../tui/rpc-contract"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@graphagent/tui/util/error"
import { withTimeout } from "@/util/timeout"
import { Filesystem } from "@/util/filesystem"
import type { EventSource } from "@graphagent/tui/context/sdk"
import { writeHeapSnapshot } from "v8"
import { validateSession } from "../tui/validate-session"
import { win32InstallCtrlCGuard } from "@graphagent/tui/terminal-win32"
import { t } from "@graphagent/tui/i18n"

declare global {
  const GRAPHAGENT_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<WorkerMethods, WorkerEvents>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
    const result = await client.call(
      "fetch",
      {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body,
      },
      { signal: request.signal },
    )
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on("global.events", (events) => {
        for (const event of events) handler(event)
      })
    },
    subscribeBatch: async (handler) => client.on("global.events", handler),
    setInterest: (full) => client.call("setInterest", { full }),
  }
}

async function target() {
  if (typeof GRAPHAGENT_WORKER_PATH !== "undefined") return GRAPHAGENT_WORKER_PATH
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("../tui/worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

async function needsTranspileReexec() {
  // The compiled binary embeds its sources; the candidate tsconfig only
  // exists for source-mode runs, which are the only ones Bun re-transpiles.
  const candidate = fileURLToPath(new URL("../../../tsconfig.json", import.meta.url))
  if (!(await Filesystem.exists(candidate))) return false
  const local = path.join(process.cwd(), "tsconfig.json")
  if (!(await Filesystem.exists(local))) return true
  const raw = await Bun.file(local)
    .text()
    .catch(() => "")
  return !raw.includes("@opentui/solid")
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: t("cli.tui.describe"),
  builder: (yargs) =>
    yargs
      .positional("project", {
        type: "string",
        describe: t("cli.tui.option.project"),
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: t("cli.run.option.model"),
      })
      .option("continue", {
        alias: ["c"],
        describe: t("cli.run.option.continue"),
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: t("cli.run.option.session"),
      })
      .option("fork", {
        type: "boolean",
        describe: t("cli.tui.option.fork"),
      })
      .option("prompt", {
        type: "string",
        describe: t("cli.tui.option.prompt"),
      })
      .option("agent", {
        type: "string",
        describe: t("cli.run.option.agent"),
      })
      .option("mini", {
        type: "boolean",
        describe: t("cli.tui.option.mini"),
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: t("cli.tui.option.noReplay"),
      })
      .option("replay-limit", {
        type: "number",
        describe: t("cli.tui.option.replayLimit"),
      })
      .option("demo", {
        type: "boolean",
        hidden: true,
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error(t("cli.tui.error.replayUnsupported"))
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    if (args.mini) {
      const { runMini } = await import("./run")
      await runMini({
        directory: resolveThreadDirectory(args.project),
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        model: args.model,
        agent: args.agent,
        prompt: args.prompt,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
        demo: args.demo,
      })
      return
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
      ["--demo", args.demo !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(t("cli.run.error.requiresMini", { flag: String(unsupported) }))
      process.exitCode = 1
      return
    }

    // Bun snapshots the JSX transpiler config from $cwd/tsconfig.json at
    // startup. Booting the source CLI from a directory without an
    // @opentui/solid jsxImportSource compiles the TUI's solid JSX against the
    // react runtime and dies on the first component. Re-exec from the package
    // directory, which owns a compatible tsconfig; the original directory
    // still reaches the thread/worker via [project] resolution, so project
    // keys stay on the user's directory.
    if (await needsTranspileReexec()) {
      const pkg = fileURLToPath(new URL("../../../", import.meta.url))
      const child = Bun.spawn([process.execPath, ...process.execArgv, Bun.main, ...process.argv.slice(2)], {
        cwd: pkg,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
      process.exit(await child.exited)
    }

    const unguard = win32InstallCtrlCGuard()
    try {
      const { TuiConfig } = await import("@/config/tui")
      if (args.fork && !args.continue && !args.session) {
        UI.error(t("cli.run.error.forkNeedsSession"))
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const next = resolveThreadDirectory(args.project)
      const file = await target()
      try {
        process.chdir(next)
      } catch {
        UI.error(t("cli.run.error.changeDirectory", { dir: next }))
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      const worker = new Worker(file)
      const client = Rpc.client<WorkerMethods, WorkerEvents>(worker)
      const reload = () => {
        client.call("reload").catch(() => {})
      }
      process.on("SIGUSR2", reload)

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        process.off("SIGUSR2", reload)
        await withTimeout(client.call("shutdown"), 5000).catch(() => {})
        worker.terminate()
      }

      // A dead worker leaves every pending RPC hanging forever; surface the
      // crash and exit instead of freezing the TUI with no diagnostics.
      const fatal = (reason: string) => {
        if (stopped) return
        stopped = true
        process.off("SIGUSR2", reload)
        worker.terminate()
        UI.error(t("cli.tui.error.workerCrashed", { reason }))
        process.exit(1)
      }
      client.on("worker.fatal", (data) => fatal(data.message))
      worker.addEventListener("error", (event) => fatal(errorMessage(event.error ?? event.message)))
      worker.addEventListener("close", () => fatal(t("cli.tui.error.workerExited")))

      const prompt = await input(args.prompt)
      const config = await TuiConfig.get()

      const transport = {
        url: "http://graphagent.internal", // check-private-hosts: allow in-process dummy base URL
        fetch: createWorkerFetch(client),
        events: createEventSource(client),
      }

      try {
        await validateSession({
          url: transport.url,
          sessionID: args.session,
          directory: cwd,
          fetch: transport.fetch,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      try {
        const { Effect } = await import("effect")
        const { run } = await import("../tui/layer")
        await Effect.runPromise(
          run({
            url: transport.url,
            async onSnapshot() {
              const tui = writeHeapSnapshot("tui.heapsnapshot")
              const server = await client.call("snapshot")
              return [tui, server]
            },
            config,
            directory: cwd,
            fetch: transport.fetch,
            events: transport.events,
            args: {
              continue: args.continue,
              sessionID: args.session,
              agent: args.agent,
              model: args.model,
              prompt,
              fork: args.fork,
            },
          }),
        )
      } finally {
        await stop()
      }
    } finally {
      try {
        unguard?.()
      } catch {}
    }
    process.exit(0)
  },
})
// scratch
