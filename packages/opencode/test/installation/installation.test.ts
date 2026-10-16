import { describe, expect, mock } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { AppProcess } from "@opencode-ai/core/process"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const appProcess = AppProcess.layer.pipe(Layer.provide(mockSpawner(spawnHandler)))
  return Installation.layer.pipe(Layer.provide(mockHttpClient(httpHandler)), Layer.provide(appProcess))
}

describe("retired application updating", () => {
  const http = mock(() => jsonResponse({ tag_name: "graphagent-v99.0.0" }))
  const spawn = mock(() => "")
  const it = testEffect(testLayer(http, spawn))

  it.effect("compatibility version accessors do not check releases or start processes", () =>
    Effect.gen(function* () {
      http.mockClear()
      spawn.mockClear()
      expect(yield* Installation.use.latest()).toBe(InstallationVersion)
      const service = yield* Installation.Service
      expect(yield* service.info()).toEqual({ version: InstallationVersion, latest: InstallationVersion })
      expect(http).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    }),
  )

  it.effect("rejects every legacy install method without network or process side effects", () =>
    Effect.gen(function* () {
      http.mockClear()
      spawn.mockClear()
      for (const method of ["curl", "npm", "yarn", "pnpm", "bun", "brew", "scoop", "choco", "unknown"] as const) {
        const error = yield* Effect.flip(Installation.use.upgrade(method, "99.0.0"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe(Installation.UPDATES_DISABLED)
      }
      expect(http).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    }),
  )

  it.effect("preserves installation detection for uninstall", () =>
    Effect.gen(function* () {
      expect(["curl", "unknown"]).toContain(yield* Installation.use.method())
    }),
  )
})
