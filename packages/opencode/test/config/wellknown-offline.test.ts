import { expect } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { logLines } from "effect/testing/TestConsole"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { readdir } from "fs/promises"
import path from "path"

import { Config } from "@/config/config"
import { Auth } from "../../src/auth"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { Env } from "../../src/env"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const testFlock = EffectFlock.defaultLayer

const wellKnownAuth = (url: string, token = "test-token") =>
  Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        [url]: new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token }),
      }),
  })

const configLayer = (client: HttpClient.HttpClient, url = "https://example.com", token = "test-token") =>
  Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(Env.defaultLayer),
    Layer.provide(wellKnownAuth(url, token)),
    Layer.provideMerge(infra),
    Layer.provide(NpmTest.noop),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provideMerge(FSUtil.defaultLayer),
  )

const it = (client: HttpClient.HttpClient, url?: string, token?: string) => testEffect(configLayer(client, url, token))

const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const jsonText = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: string) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )

const LkgEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  writtenAt: Schema.String,
  body: Schema.String,
})

const transportFailure = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], description: string) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description }),
    }),
  )

const lkgFile = (digest: string) => path.join(Global.Path.cache, "remote-config-lkg", `${digest}.json`)

const writeLkgFile = (digest: string, content: string) =>
  Effect.promise(() => Bun.write(lkgFile(digest), content, { mode: 0o600 }))

// Well-known endpoint unreachable (DNS/connection failure): the transport never answers.
const unreachable = HttpClient.make((request) => transportFailure(request, "connect ECONNREFUSED"))

// Well-known endpoint answers, but the remote_config URL is unreachable.
const remoteConfigUnreachable = (seen: { wellKnown?: string; remote?: string }, remoteUrl: string) =>
  HttpClient.make((request) => {
    const parsedUrl = new URL(request.url)
    if (parsedUrl.pathname.includes("/.well-known/opencode")) {
      seen.wellKnown = request.url
      return Effect.succeed(
        json(request, {
          config: { model: "embedded/model" },
          remote_config: { url: remoteUrl },
        }),
      )
    }
    if (request.url === remoteUrl) {
      seen.remote = request.url
      return transportFailure(request, "connect timeout")
    }
    return Effect.succeed(json(request, {}, 404))
  })

// Both hops succeed: remote config must merge exactly as before.
const remoteOk = (seen: { wellKnown?: string; remote?: string }) =>
  HttpClient.make((request) => {
    const parsedUrl = new URL(request.url)
    if (parsedUrl.pathname.includes("/.well-known/opencode")) {
      seen.wellKnown = request.url
      return Effect.succeed(json(request, { remote_config: { url: "https://config.example.com/opencode.json" } }))
    }
    if (parsedUrl.hostname === "config.example.com") {
      seen.remote = request.url
      return Effect.succeed(
        json(request, {
          config: { mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } } },
        }),
      )
    }
    return Effect.succeed(json(request, {}, 404))
  })

// Gateway answers the remote_config URL with an HTML login page (auth proxy, not an offline failure).
const loginPage = (seen: { wellKnown?: string; remote?: string }) =>
  HttpClient.make((request) => {
    if (request.url.includes(".well-known/opencode")) {
      seen.wellKnown = request.url
      return Effect.succeed(json(request, { remote_config: { url: "https://config.example.com/opencode.json" } }))
    }
    const requestHost = new URL(request.url).hostname
    if (requestHost === "config.example.com") {
      seen.remote = request.url
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("<!DOCTYPE html><html><head><title>Sign in</title></head><body>Login required</body></html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        ),
      )
    }
    return Effect.succeed(json(request, {}, 404))
  })

// Well-known endpoint answers 200-OK with JSON content-type, but the body stream
// errors mid-read (truncated transfer / connection reset). Exercises the body-read
// degrade path (config.ts:210-217) distinct from the transport-level fetch degrade.
const bodyReadFails = HttpClient.make((request) => {
  if (request.url.includes(".well-known/opencode")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body stream interrupted"))
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    )
  }
  return Effect.succeed(json(request, {}, 404))
})

const onlineThenFailureState = { mode: "online" }
const onlineThenAllowedFailure = HttpClient.make((request) => {
  if (request.url.includes("/.well-known/opencode")) {
    if (onlineThenFailureState.mode === "wellknown-transport") {
      return transportFailure(request, "offline after initial success")
    }
    if (onlineThenFailureState.mode === "wellknown-status") {
      return Effect.succeed(json(request, { error: "temporarily unavailable" }, 503))
    }
    if (onlineThenFailureState.mode === "wellknown-body") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }),
        ),
      )
    }
    return Effect.succeed(
      json(request, { remote_config: { url: "https://lkg-transport-config.example.com/opencode.json" } }),
    )
  }
  if (new URL(request.url).hostname === "lkg-transport-config.example.com") {
    if (onlineThenFailureState.mode === "remote-transport") {
      return transportFailure(request, "remote config offline after initial success")
    }
    if (onlineThenFailureState.mode === "remote-status") {
      return Effect.succeed(json(request, { error: "temporarily unavailable" }, 502))
    }
    if (onlineThenFailureState.mode === "remote-body") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }),
        ),
      )
    }
    return Effect.succeed(json(request, { config: { model: "lkg/transport-model" } }))
  }
  return Effect.succeed(json(request, {}, 404))
})

const onlineThenAllowedFailureIt = it(onlineThenAllowedFailure, "https://lkg-transport.example.com")

onlineThenAllowedFailureIt.live(
  "online success persists both remote responses for allowed-failure reuse in new instances",
  Effect.gen(function* () {
    const online = yield* provideTmpdirInstance(() => Config.use.get())
    expect(online.model).toBe("lkg/transport-model")

    yield* Effect.forEach(
      ["wellknown-transport", "remote-transport", "wellknown-status", "remote-status", "wellknown-body", "remote-body"],
      (mode) =>
        Effect.gen(function* () {
          onlineThenFailureState.mode = mode
          const fallback = yield* provideTmpdirInstance(() => Config.use.get())
          expect(fallback.model).toBe("lkg/transport-model")
        }),
      { discard: true },
    )
  }),
)

type HardFailureMode =
  | "online"
  | "transport"
  | "remote-401"
  | "remote-403"
  | "remote-html"
  | "wellknown-schema"
  | "remote-nonobject"
  | "final-config-decode"

const hardFailureClient = (origin: string, state: { mode: HardFailureMode }) =>
  HttpClient.make((request) => {
    if (state.mode === "transport") return transportFailure(request, "offline after hard failure")
    if (request.url.includes("/.well-known/opencode")) {
      if (state.mode === "wellknown-schema") return Effect.succeed(json(request, ["not-an-object"]))
      return Effect.succeed(json(request, { remote_config: { url: `${origin}/remote-config.json` } }))
    }
    if (state.mode === "remote-401") return Effect.succeed(json(request, { error: "sign in" }, 401))
    if (state.mode === "remote-403") return Effect.succeed(json(request, { error: "forbidden" }, 403))
    if (state.mode === "remote-html") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("<!DOCTYPE html><html><body>Sign in</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        ),
      )
    }
    if (state.mode === "remote-nonobject") return Effect.succeed(json(request, ["not-an-object"]))
    if (state.mode === "final-config-decode") {
      return Effect.succeed(json(request, { config: { model: 42 } }))
    }
    return Effect.succeed(json(request, { config: { model: "lkg/hard-boundary-model" } }))
  })

const hardFailureCases: { mode: HardFailureMode; title: string }[] = [
  { mode: "remote-401", title: "401" },
  { mode: "remote-403", title: "403" },
  { mode: "remote-html", title: "HTML login" },
  { mode: "wellknown-schema", title: "well-known schema decode" },
  { mode: "remote-nonobject", title: "remote non-object" },
  { mode: "final-config-decode", title: "final config decode" },
]

hardFailureCases.forEach((scenario) => {
  const origin = `https://lkg-hard-${scenario.mode}.example.com`
  const state: { mode: HardFailureMode } = { mode: "online" }
  const boundaryIt = it(hardFailureClient(origin, state), origin)

  boundaryIt.live(
    `${scenario.title} remains a hard failure and preserves the previous LKG`,
    Effect.gen(function* () {
      const online = yield* provideTmpdirInstance(() => Config.use.get())
      expect(online.model).toBe("lkg/hard-boundary-model")

      state.mode = scenario.mode
      const failure = yield* provideTmpdirInstance(() => Config.use.get().pipe(Effect.exit))
      expect(Exit.isFailure(failure)).toBe(true)

      state.mode = "transport"
      const fallback = yield* provideTmpdirInstance(() => Config.use.get())
      expect(fallback.model).toBe("lkg/hard-boundary-model")
    }),
  )
})

const unavailableWellKnownCases = [
  {
    title: "empty",
    origin: "https://lkg-empty-first.example.com",
    digest: "89173d6feff949ddb9265e9b19b142875971bf40065fd88b76223612d0b0e705",
    content: "",
  },
  {
    title: "corrupt",
    origin: "https://lkg-corrupt-first.example.com",
    digest: "f92edb1dcc30a66dee91cb91d73925019660bcd6a87b9db15dd00e527a89245b",
    content: "{CORRUPT_CACHE_CREDENTIAL_MARKER",
  },
]

unavailableWellKnownCases.forEach((scenario) => {
  const unavailableIt = it(unreachable, scenario.origin)

  unavailableIt.instance(
    `${scenario.title} first-hop LKG warns and preserves the existing skip result`,
    () =>
      Effect.gen(function* () {
        yield* writeLkgFile(scenario.digest, scenario.content)
        const config = yield* Config.use.get()
        expect(config.model).toBe("local/unavailable-cache-model")
        const logs = JSON.stringify(yield* logLines)
        expect(logs).toContain("remote config LKG unavailable")
        expect(logs).not.toContain("CORRUPT_CACHE_CREDENTIAL_MARKER")
      }),
    { config: { model: "local/unavailable-cache-model" } },
  )
})

const unavailableRemoteCases = [
  {
    title: "empty",
    origin: "https://lkg-empty-remote.example.com",
    digest: "8c123b509f8a3a6c1f06c8103d2c1da2f12d4ba58d12d0059da22a986ea8018a",
    content: "",
  },
  {
    title: "corrupt",
    origin: "https://lkg-corrupt-remote.example.com",
    digest: "74f3bb458fa277ba39d92a3874d58a0c0095831a90fa0cbc39ad701ca3d68c8b",
    content: "{CORRUPT_REMOTE_CACHE_CREDENTIAL_MARKER",
  },
]

unavailableRemoteCases.forEach((scenario) => {
  const client = HttpClient.make((request) => {
    if (request.url.includes("/.well-known/opencode")) {
      return Effect.succeed(
        json(request, {
          config: { model: "embedded/unavailable-cache-model" },
          remote_config: { url: `${scenario.origin}/remote-config.json` },
        }),
      )
    }
    return transportFailure(request, "remote config unavailable")
  })
  const unavailableIt = it(client, scenario.origin)

  unavailableIt.live(
    `${scenario.title} second-hop LKG warns and preserves embedded well-known config`,
    Effect.gen(function* () {
      yield* writeLkgFile(scenario.digest, scenario.content)
      const config = yield* provideTmpdirInstance(() => Config.use.get())
      expect(config.model).toBe("embedded/unavailable-cache-model")
      const logs = JSON.stringify(yield* logLines)
      expect(logs).toContain("remote config LKG unavailable")
      expect(logs).not.toContain("CORRUPT_REMOTE_CACHE_CREDENTIAL_MARKER")
    }),
  )
})

const oldLkgOrigin = "https://lkg-old.example.com"
const oldLkgIt = it(unreachable, oldLkgOrigin)

oldLkgIt.live(
  "very old LKG remains usable and reports only safe age diagnostics",
  Effect.gen(function* () {
    yield* writeLkgFile(
      "1675a350c4b8aa9887c0fad04fa378818761901440a26f5e78e0429786712889",
      JSON.stringify({
        version: 1,
        writtenAt: "2000-01-01T00:00:00.000Z",
        body: JSON.stringify({ remote_config: { url: `${oldLkgOrigin}/remote-config.json` } }),
      }),
    )
    yield* writeLkgFile(
      "0c467a2ce6c5e997d510fec8d4d3a3115a53ba26509732ad07b84069605e7ad1",
      JSON.stringify({
        version: 1,
        writtenAt: "2000-01-01T00:00:00.000Z",
        body: JSON.stringify({ config: { model: "lkg/very-old-model" } }),
      }),
    )

    const config = yield* provideTmpdirInstance(() => Config.use.get())
    expect(config.model).toBe("lkg/very-old-model")
    const logs = JSON.stringify(yield* logLines)
    expect(logs).toContain("using remote config LKG")
    expect(logs).toContain("ageSeconds")
    expect(logs).not.toContain("lkg/very-old-model")
  }),
)

const safetyOrigin = "https://lkg-safety.example.com"
const safetyRemoteUrl = "https://lkg-safety-config.example.com/opencode.json?credential=QUERY_SECRET_MARKER"
const safetyToken = "AUTH_TOKEN_SECRET_MARKER"
const safetyWellKnownBody = JSON.stringify({
  config: { username: "{env:TEST_TOKEN}" },
  remote_config: {
    url: safetyRemoteUrl,
    headers: {
      Authorization: "Bearer {env:TEST_TOKEN}",
      "X-Header-Marker": "HEADER_SECRET_MARKER",
    },
  },
})
const safetyRemoteBody = JSON.stringify({
  config: {
    model: "BODY_MARKER/model",
    username: "{env:TEST_TOKEN}",
  },
})
const safetyState = { online: true }
const safetyClient = HttpClient.make((request) => {
  if (!safetyState.online) return transportFailure(request, "offline for safety diagnostics")
  if (request.url.includes("/.well-known/opencode")) return Effect.succeed(jsonText(request, safetyWellKnownBody))
  return Effect.succeed(jsonText(request, safetyRemoteBody))
})
const safetyIt = it(safetyClient, safetyOrigin, safetyToken)

safetyIt.live(
  "cache identity, envelope metadata, and remote diagnostics do not leak credentials or body values",
  Effect.gen(function* () {
    const online = yield* provideTmpdirInstance(() => Config.use.get())
    expect(online.model).toBe("BODY_MARKER/model")
    expect(online.username).toBe(safetyToken)

    const digests = [
      "505f8fee6f34341c3236d9240b99654fa1e3d237a020a450b0cc5e0fc373ad0e",
      "690e1cb0aeb039cd6a0206ada563856113c8f76c7345fadca285e7bf369b54ba",
    ]
    const filenames = yield* Effect.promise(() => readdir(path.join(Global.Path.cache, "remote-config-lkg")))
    expect(filenames.filter((name) => digests.some((digest) => name === `${digest}.json`)).toSorted()).toEqual(
      digests.map((digest) => `${digest}.json`).toSorted(),
    )
    expect(filenames.join(" ")).not.toContain("QUERY_SECRET_MARKER")
    expect(filenames.join(" ")).not.toContain("HEADER_SECRET_MARKER")
    expect(filenames.join(" ")).not.toContain("BODY_MARKER")
    expect(filenames.join(" ")).not.toContain(safetyToken)

    const wellKnownContent = yield* Effect.promise(() => Bun.file(lkgFile(digests[0])).text())
    const remoteContent = yield* Effect.promise(() => Bun.file(lkgFile(digests[1])).text())
    const wellKnownUnknown = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(wellKnownContent)
    const remoteUnknown = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(remoteContent)
    if (typeof wellKnownUnknown !== "object" || wellKnownUnknown === null || Array.isArray(wellKnownUnknown)) {
      throw new Error("well-known LKG is not an object")
    }
    if (typeof remoteUnknown !== "object" || remoteUnknown === null || Array.isArray(remoteUnknown)) {
      throw new Error("remote-config LKG is not an object")
    }
    expect(Object.keys(wellKnownUnknown).sort()).toEqual(["body", "version", "writtenAt"])
    expect(Object.keys(remoteUnknown).sort()).toEqual(["body", "version", "writtenAt"])
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(LkgEnvelope))(wellKnownContent).body).toBe(
      safetyWellKnownBody,
    )
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(LkgEnvelope))(remoteContent).body).toBe(safetyRemoteBody)
    expect(wellKnownContent).not.toContain(safetyToken)
    expect(remoteContent).not.toContain(safetyToken)

    safetyState.online = false
    const fallback = yield* provideTmpdirInstance(() => Config.use.get())
    expect(fallback.model).toBe("BODY_MARKER/model")
    expect(fallback.username).toBe(safetyToken)

    const logs = JSON.stringify(yield* logLines)
    for (const marker of ["QUERY_SECRET_MARKER", "HEADER_SECRET_MARKER", "BODY_MARKER", safetyToken]) {
      expect(logs).not.toContain(marker)
    }
  }),
)

const missingWellKnownOrigin = "https://missing-wellknown.example.com"
const unreachableIt = it(unreachable, missingWellKnownOrigin)

unreachableIt.instance(
  "wellknown transport failure degrades: config loads, local config intact, warning logged",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.model).toBe("local/model")
      expect(config.mcp?.jira?.enabled).toBe(true)
      const logs = JSON.stringify(yield* logLines)
      expect(logs).toContain("failed to fetch remote config")
      expect(logs).toContain("6b8f8396ae9f582f48dad65f38f88caf722d177638e6d3cadc1d1e7cea36b312")
      expect(logs).toContain("well-known")
      expect(logs).not.toContain(`${missingWellKnownOrigin}/.well-known/opencode`)
    }),
  {
    config: {
      model: "local/model",
      mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } },
    },
  },
)

const remoteUnreachableSeen: { wellKnown?: string; remote?: string } = {}
const missingRemoteOrigin = "https://missing-remote.example.com"
const missingRemoteUrl = "https://missing-remote-config.example.com/opencode.json"
const remoteUnreachableIt = it(remoteConfigUnreachable(remoteUnreachableSeen, missingRemoteUrl), missingRemoteOrigin)

remoteUnreachableIt.instance(
  "remote_config transport failure degrades: embedded wellknown config still merges, warning logged",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(remoteUnreachableSeen.wellKnown).toBe(`${missingRemoteOrigin}/.well-known/opencode`)
      expect(remoteUnreachableSeen.remote).toBe(missingRemoteUrl)
      expect(config.model).toBe("embedded/model")
      const logs = JSON.stringify(yield* logLines)
      expect(logs).toContain("failed to fetch remote config")
      expect(logs).toContain("f71d054e157edfcdd072de9b3c9ccbe82c4330d9a054116dc0c920236a7a8e92")
      expect(logs).toContain("remote-config")
      expect(logs).not.toContain(missingRemoteUrl)
    }),
)

const remoteOkSeen: { wellKnown?: string; remote?: string } = {}
const remoteOkIt = it(remoteOk(remoteOkSeen))

remoteOkIt.instance("success path unchanged: remote config merges, no degradation warning", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(remoteOkSeen.wellKnown).toBe("https://example.com/.well-known/opencode")
    expect(remoteOkSeen.remote).toBe("https://config.example.com/opencode.json")
    expect(config.mcp?.confluence?.enabled).toBe(true)
    expect(JSON.stringify(yield* logLines)).not.toContain("failed to fetch remote config")
  }),
)

const loginPageSeen: { wellKnown?: string; remote?: string } = {}
const loginPageIt = it(loginPage(loginPageSeen))

loginPageIt.instance("HTML login page stays a hard auth failure even with degradation enabled", () =>
  Effect.gen(function* () {
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(loginPageSeen.remote).toBe("https://config.example.com/opencode.json")
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

const bodyReadMissingOrigin = "https://body-read-missing.example.com"
const bodyReadFailsIt = it(bodyReadFails, bodyReadMissingOrigin)

bodyReadFailsIt.instance(
  "wellknown body-read failure degrades: config loads, local config intact, warning logged",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.model).toBe("local/model")
      expect(config.mcp?.jira?.enabled).toBe(true)
      const logs = JSON.stringify(yield* logLines)
      expect(logs).toContain("failed to read remote config")
      expect(logs).toContain("d0d0bbaef7a071d010d7223883169215741dd80cbb362b68b93e30d5f531013a")
      expect(logs).toContain("well-known")
      expect(logs).not.toContain(`${bodyReadMissingOrigin}/.well-known/opencode`)
    }),
  {
    config: {
      model: "local/model",
      mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } },
    },
  },
)
