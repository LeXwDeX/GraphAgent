/**
 * End-to-end exerciser for the Effect HttpApi routes.
 *
 * The goal is not to be a normal unit test file. This is a route-coverage harness:
 * every public route should have a small scenario that proves the route decodes
 * requests, uses the right instance context, mutates storage when expected, and
 * returns the expected response shape.
 *
 * The script intentionally isolates `GRAPHAGENT_DB` before importing modules that touch
 * storage. Scenarios may create/delete sessions and reset the database after each run,
 * so this must never point at a developer's real session database.
 *
 * DSL shape:
 * - `http.protected.get/post/...` starts a scenario for one OpenAPI route key.
 * - `.seeded(...)` creates typed per-scenario state using Effect helpers on `ctx`.
 * - `.at(...)` builds the request from that typed state.
 * - `.json(...)` / `.jsonEffect(...)` assert response shape and optional side effects.
 * - `.mutating()` tells the runner to reset isolated state after destructive routes.
 */
import { Effect, Fiber } from "effect"
import { OpenApi } from "effect/http-api"
import { TestLLMServer } from "../../lib/llm-server"
import path from "path"
import { array, boolean, check, isRecord, message, object, stable } from "./assertions"
import { http, route } from "./dsl"
import {
  enterExerciseWorkingDirectory,
  exerciseConfigDirectory,
  exerciseDataDirectory,
  exerciseDatabasePath,
  exerciseGlobalRoot,
  invokingWorktrees,
} from "./environment"
import { color, printHeader, printResults } from "./report"
import { coverageResult, parseOptions, routeKey, routeKeys, selectedScenarios } from "./routing"
import { runScenario } from "./runner"
import { runtime } from "./runtime"
import { runMainWithHardExit, teardown } from "./teardown"
import { type Options, type Scenario, type ScenarioContext } from "./types"
import { startProgressWatchdog } from "./watchdog"

enterExerciseWorkingDirectory()

// #1026: a child session (parentID != null) only takes input from its parent
// agent. These seed a parent + child through the in-process Session service
// (the way task/DAG create one) and drive the HTTP route against the child.
const seedChild = (ctx: ScenarioContext) =>
  Effect.gen(function* () {
    const parent = yield* ctx.session({ title: "Child guard parent" })
    return yield* ctx.session({ title: "Child guard child", parentID: parent.id })
  })

type SessionWrite = ReturnType<typeof http.protected.post>

/** A write the guard refuses: 409 with the ChildSessionReadOnlyError envelope naming the session. */
const refusedForChild = (
  builder: SessionWrite,
  template: string,
  input: { params?: Record<string, string>; body?: unknown } = {},
) =>
  builder
    .mutating()
    .seeded(seedChild)
    .at((ctx) => ({
      path: route(template, { sessionID: ctx.state.id, ...input.params }),
      headers: ctx.headers(),
      body: input.body,
    }))
    .status(409, (ctx, result) =>
      Effect.sync(() => {
        const body = result.body
        object(body)
        check(body.name === "ChildSessionReadOnlyError", "a child-session write should name ChildSessionReadOnlyError")
        object(body.data)
        check(body.data.sessionID === ctx.state.id, "the error should name the child session")
        check(typeof body.data.message === "string", "the error should carry a message")
        check(!("code" in body) && !("code" in body.data), "the unified error shape has no code field")
      }),
    )

const scenarios: Scenario[] = [
  http.protected
    .get("/global/health", "global.health")
    .global()
    .json(200, (body) => {
      object(body)
      check(body.healthy === true, "server should report healthy")
    }),
  http.protected.get("/global/config", "global.config.get").global().json(),
  http.protected
    .patch("/global/config", "global.config.update")
    .global()
    .seeded(() =>
      Effect.promise(() =>
        Bun.write(
          path.join(exerciseConfigDirectory, "graphagent.jsonc"),
          JSON.stringify({ username: "httpapi-global" }, null, 2),
        ),
      ),
    )
    .at(() => ({ path: "/global/config", body: { username: "httpapi-global" } }))
    .jsonEffect(
      200,
      (body) =>
        Effect.gen(function* () {
          object(body)
          check(body.username === "httpapi-global", "global config update should return patched config")
          const text = yield* Effect.promise(() =>
            Bun.file(path.join(exerciseConfigDirectory, "graphagent.jsonc")).text(),
          )
          check(text.includes('"username": "httpapi-global"'), "global config update should write isolated config file")
        }),
      "status",
    ),
  http.protected
    .post("/global/dispose", "global.dispose")
    .global()
    .mutating()
    .json(
      200,
      (body) => {
        check(body === true, "global dispose should return true")
      },
      "status",
    ),
  http.protected.get("/path", "path.get").json(200, (body, ctx) => {
    object(body)
    check(body.directory === ctx.directory, "directory should resolve from x-graphagent-directory")
    check(body.worktree === ctx.directory, "worktree should resolve from x-graphagent-directory")
  }),
  http.protected.get("/vcs", "vcs.get").json(),
  http.protected.get("/vcs/status", "vcs.status").json(200, array),
  http.protected
    .get("/vcs/diff", "vcs.diff")
    .at((ctx) => ({ path: "/vcs/diff?mode=git", headers: ctx.headers() }))
    .json(200, array),
  http.protected.get("/vcs/diff/raw", "vcs.diff.raw").status(
    200,
    (_ctx, result) =>
      Effect.sync(() => {
        check(typeof result.text === "string", "raw VCS diff should return text")
      }),
    "status",
  ),
  http.protected
    .post("/vcs/apply", "vcs.apply")
    .inProject({ git: false })
    .at((ctx) => ({ path: "/vcs/apply", headers: ctx.headers(), body: { patch: "" } }))
    .status(400, undefined, "status"),
  http.protected.get("/command", "command.list").json(200, array, "status"),
  http.protected.get("/agent", "app.agents").json(200, array, "status"),
  http.protected.get("/skill", "app.skills").json(200, array, "status"),
  http.protected.get("/lsp", "lsp.status").json(200, array),
  http.protected.get("/formatter", "formatter.status").json(200, array),
  http.protected
    .get("/config", "config.get")
    .inProject({ config: { maxToolCalls: 0 } })
    .json(
      200,
      (body) => {
        object(body)
        check(body.maxToolCalls === 0, "config get should accept an explicit unlimited maxToolCalls")
      },
      "status",
    ),
  http.protected
    .patch("/config", "config.update")
    .mutating()
    .at((ctx) => ({
      path: "/config",
      headers: ctx.headers(),
      body: {
        username: "httpapi-local",
        maxToolCalls: 41,
        reasoningDistillation: { enabled: true },
        provider: {
          "test-provider": {
            models: {
              "test-key": {
                reasoningDistillation: { enabled: false },
                cost: {
                  input: 10,
                  output: 50,
                  tiers: [{ input: 20, output: 75, tier: { type: "context", size: 272_000 } }],
                },
              },
            },
          },
        },
      },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(body.username === "httpapi-local", "local config update should return patched config")
          check(body.maxToolCalls === 41, "local config update should return maxToolCalls")
          object(body.reasoningDistillation)
          check(body.reasoningDistillation.enabled === true, "global reasoning distillation should stay enabled")
          object(body.provider)
          object(body.provider["test-provider"])
          object(body.provider["test-provider"].models)
          object(body.provider["test-provider"].models["test-key"])
          object(body.provider["test-provider"].models["test-key"].reasoningDistillation)
          check(
            body.provider["test-provider"].models["test-key"].reasoningDistillation.enabled === false,
            "model reasoning distillation override should stay disabled",
          )
          const cost = body.provider["test-provider"].models["test-key"].cost
          object(cost)
          check(
            JSON.stringify(cost.tiers) ===
              JSON.stringify([{ input: 20, output: 75, tier: { type: "context", size: 272_000 } }]),
            "local config update should return configured context pricing tiers",
          )
          const directory = ctx.directory
          check(directory !== undefined, "config patch should run in a project directory")
          const saved = JSON.parse(
            yield* Effect.promise(() => Bun.file(path.join(directory, ".agents", "settings.json")).text()),
          )
          object(saved.provider)
          object(saved.provider["test-provider"])
          object(saved.provider["test-provider"].models)
          object(saved.provider["test-provider"].models["test-key"])
          object(saved.provider["test-provider"].models["test-key"].reasoningDistillation)
          check(
            saved.provider["test-provider"].models["test-key"].reasoningDistillation.enabled === false,
            "local config update should persist the per-model reasoning override",
          )
          object(saved.provider["test-provider"].models["test-key"].cost)
          check(
            JSON.stringify(saved.provider["test-provider"].models["test-key"].cost.tiers) ===
              JSON.stringify(cost.tiers),
            "local config update should persist configured context pricing tiers",
          )
        }),
      "status",
    ),
  http.protected
    .patch("/config", "config.update.invalid")
    .at((ctx) => ({ path: "/config", headers: ctx.headers(), body: { maxToolCalls: -1 } }))
    .status(400),
  http.protected.get("/config/providers", "config.providers").json(),
  http.protected.get("/project", "project.list").json(200, array, "status"),
  http.protected.get("/project/current", "project.current").json(
    200,
    (body, ctx) => {
      object(body)
      check(body.worktree === ctx.directory, "current project should resolve from scenario directory")
    },
    "status",
  ),
  http.protected
    .patch("/project/{projectID}", "project.update")
    .mutating()
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/project/{projectID}", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: { name: "HTTP API Project", commands: { start: "bun --version" } },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.name === "HTTP API Project", "project update should return patched name")
        check(
          isRecord(body.commands) && body.commands.start === "bun --version",
          "project update should return patched command",
        )
      },
      "status",
    ),
  http.protected
    .patch("/project/{projectID}", "project.update.missing")
    .mutating()
    .at((ctx) => ({
      path: route("/project/{projectID}", { projectID: "project_httpapi_missing" }),
      headers: ctx.headers(),
      body: { name: "Missing Project" },
    }))
    .json(404, object, "status"),
  http.protected.get("/project/trust", "project.trust.list.empty").json(200, (body) => {
    object(body)
    check(Array.isArray(body.entries) && body.entries.length === 0, "a project without a layer should have no entries")
  }),
  http.protected
    .get("/project/trust", "project.trust.list.entries")
    .inProject({ git: true })
    .seeded((ctx) => ctx.file(".agents/hooks.json", `{"Stop":[{"hooks":[{"type":"command","command":"./check.sh"}]}]}`))
    .json(200, (body) => {
      object(body)
      const entries = body.entries
      check(Array.isArray(entries) && entries.length === 1, "project trust should list the seeded hook")
      const entry = entries[0]
      check(isRecord(entry), "a trust entry should be an object")
      if (!isRecord(entry)) return
      check(entry.id === "hooks.json|hook|Stop||1", "trust entry should use the location id")
      check(entry.state === "pending" && entry.change === "new", "a new entry should be pending")
      check(entry.when === "Stop", "a hook entry should report its event as the trigger")
      check(entry.command === "./check.sh", "trust entry should carry the full command")
      check(
        typeof entry.fp === "string" && /^[0-9a-f]{64}$/.test(entry.fp),
        "trust entry should carry a sha256 fingerprint",
      )
      check(Array.isArray(entry.risks), "trust entry should carry risk notes")
    }),
  http.protected
    .post("/project/trust", "project.trust.decide")
    .mutating()
    .inProject({ git: true })
    .seeded((ctx) => ctx.file(".agents/hooks.json", `{"Stop":[{"hooks":[{"type":"command","command":"./check.sh"}]}]}`))
    .at((ctx) => ({
      path: "/project/trust",
      headers: ctx.headers(),
      body: { decisions: [{ id: "hooks.json|hook|Stop||1", state: "trusted" }] },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        const entries = body.entries
        check(Array.isArray(entries) && entries.length === 1, "decide should return the updated list")
        const entry = entries[0]
        check(isRecord(entry) && entry.state === "trusted", "decide should mark the entry trusted")
        const followup = yield* ctx.request({ method: "GET", path: "/project/trust", headers: ctx.headers() })
        check(followup.status === 200, `follow-up trust list should succeed: ${followup.text}`)
        const next = followup.body
        check(isRecord(next) && Array.isArray(next.entries), "follow-up trust list should return entries")
        if (!isRecord(next) || !Array.isArray(next.entries)) return
        const persisted = next.entries[0]
        check(isRecord(persisted) && persisted.state === "trusted", "decide should persist the trust decision")
      }),
    ),
  http.protected
    .post("/project/trust", "project.trust.decide.unknown")
    .inProject({ git: true })
    .at((ctx) => ({
      path: "/project/trust",
      headers: ctx.headers(),
      body: { decisions: [{ id: "hooks.json|hook|Stop||1", state: "trusted" }] },
    }))
    .status(400),
  http.protected
    .post("/project/git/init", "project.initGit")
    .mutating()
    .inProject({ git: false })
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.worktree === ctx.directory, "git init should return current project")
        check(body.vcs === "git", "git init should mark the project as git-backed")
      },
      "status",
    ),
  http.protected
    .get("/project/{projectID}/directories", "project.directories")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/project/{projectID}/directories", { projectID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, array, "status"),
  http.protected
    .post("/experimental/project/{projectID}/copy/generate-name", "experimental.projectCopy.generateName")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy/generate-name", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.name === "string" && body.name.length > 0, "generated copy name should be non-empty")
    }),
  http.protected
    .post("/experimental/project/{projectID}/copy", "experimental.projectCopy.create")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .delete("/experimental/project/{projectID}/copy", "experimental.projectCopy.remove")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/experimental/project/{projectID}/copy/refresh", "experimental.projectCopy.refresh")
    .mutating()
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy/refresh", { projectID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .status(204, undefined, "status"),
  http.protected.get("/provider", "provider.list").json(),
  http.protected.get("/provider/auth", "provider.auth").json(),
  http.protected
    .post("/provider/{providerID}/oauth/authorize", "provider.oauth.authorize")
    .at((ctx) => ({
      path: route("/provider/{providerID}/oauth/authorize", { providerID: "httpapi" }),
      headers: ctx.headers(),
      body: { method: "bad" },
    }))
    .status(400),
  http.protected
    .post("/provider/{providerID}/oauth/callback", "provider.oauth.callback")
    .at((ctx) => ({
      path: route("/provider/{providerID}/oauth/callback", { providerID: "httpapi" }),
      headers: ctx.headers(),
      body: { method: "bad" },
    }))
    .status(400),
  http.protected.get("/permission", "permission.list").json(200, array),
  http.protected
    .post("/permission/{requestID}/reply", "permission.reply.invalid")
    .at((ctx) => ({
      path: route("/permission/{requestID}/reply", { requestID: "per_httpapi" }),
      headers: ctx.headers(),
      body: { reply: "bad" },
    }))
    .status(400),
  http.protected
    .post("/permission/{requestID}/reply", "permission.reply")
    .at((ctx) => ({
      path: route("/permission/{requestID}/reply", { requestID: "per_httpapi" }),
      headers: ctx.headers(),
      body: { reply: "once" },
    }))
    .json(404, object, "status"),
  http.protected.get("/question", "question.list").json(200, array),
  http.protected
    .post("/question/{requestID}/reply", "question.reply.invalid")
    .at((ctx) => ({
      path: route("/question/{requestID}/reply", { requestID: "que_httpapi_reply" }),
      headers: ctx.headers(),
      body: { answers: "Yes" },
    }))
    .status(400),
  http.protected
    .post("/question/{requestID}/reply", "question.reply")
    .at((ctx) => ({
      path: route("/question/{requestID}/reply", { requestID: "que_httpapi_reply" }),
      headers: ctx.headers(),
      body: { answers: [["Yes"]] },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/question/{requestID}/reject", "question.reject")
    .at((ctx) => ({
      path: route("/question/{requestID}/reject", { requestID: "que_httpapi_reject" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/question/{requestID}/interact", "question.interact")
    .at((ctx) => ({
      path: route("/question/{requestID}/interact", { requestID: "que_httpapi_interact" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/file", "file.list")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/file?${new URLSearchParams({ path: "." })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/file/content", "file.read")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/file/content?${new URLSearchParams({ path: "hello.txt" })}`, headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.content === "hello", `content should match seeded file: ${JSON.stringify(body)}`)
    }),
  http.protected
    .get("/file/content", "file.read.missing")
    .at((ctx) => ({ path: `/file/content?${new URLSearchParams({ path: "missing.txt" })}`, headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.type === "text" && body.content === "", "missing file content should return an empty text result")
    }),
  http.protected.get("/file/status", "file.status").json(200, array),
  http.protected
    .get("/find", "find.text")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/find?${new URLSearchParams({ pattern: "hello" })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/find/file", "find.files")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({
      path: `/find/file?${new URLSearchParams({ query: "hello", dirs: "false" })}`,
      headers: ctx.headers(),
    }))
    .json(200, array),
  http.protected
    .get("/find/symbol", "find.symbols")
    .seeded((ctx) => ctx.file("hello.ts", "export const hello = 1\n"))
    .at((ctx) => ({ path: `/find/symbol?${new URLSearchParams({ query: "hello" })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/event", "event.stream")
    .stream()
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.contentType.includes("text/event-stream"), "event should be an SSE stream")
          check(result.text.includes("server.connected"), "event should emit initial connection event")
        }),
      "status",
    ),
  http.protected.get("/mcp", "mcp.status").json(
    200,
    (body) => {
      object(body)
      for (const entry of Object.values(body)) {
        object(entry)
        if (entry.status === "connected") {
          check(
            entry.era === undefined || entry.era === "modern" || entry.era === "legacy",
            "connected MCP status era should be modern or legacy when present",
          )
          check(
            entry.protocolVersion === undefined || typeof entry.protocolVersion === "string",
            "connected MCP status protocolVersion should be a string when present",
          )
        } else {
          check(entry.era === undefined, "MCP era field should only appear on connected statuses")
          check(
            entry.protocolVersion === undefined,
            "MCP protocolVersion field should only appear on connected statuses",
          )
        }
      }
    },
    "status",
  ),
  http.protected
    .post("/mcp", "mcp.add")
    .mutating()
    .at((ctx) => ({
      path: "/mcp",
      headers: ctx.headers(),
      body: { name: "httpapi-disabled", config: { type: "local", command: ["bun", "--version"], disabled: true } },
    }))
    .json(
      200,
      (body) => {
        object(body)
        object(body["httpapi-disabled"])
        check(body["httpapi-disabled"].status === "disabled", "disabled MCP server should be added without spawning")
      },
      "status",
    ),
  http.protected
    .post("/mcp", "mcp.add.invalid")
    .at((ctx) => ({
      path: "/mcp",
      headers: ctx.headers(),
      body: { name: "httpapi-invalid", config: { type: "invalid" } },
    }))
    .status(400),
  http.protected
    .post("/mcp/{name}/auth", "mcp.auth.start")
    .at((ctx) => ({ path: route("/mcp/{name}/auth", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .delete("/mcp/{name}/auth", "mcp.auth.remove")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/auth", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/auth/authenticate", "mcp.auth.authenticate")
    .at((ctx) => ({
      path: route("/mcp/{name}/auth/authenticate", { name: "httpapi-missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/auth/callback", "mcp.auth.callback")
    .at((ctx) => ({
      path: route("/mcp/{name}/auth/callback", { name: "httpapi-missing" }),
      headers: ctx.headers(),
      body: { code: "code" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/connect", "mcp.connect")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/connect", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/disconnect", "mcp.disconnect")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/disconnect", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected.get("/experimental/workspace/adapter", "experimental.workspace.adapter.list").json(200, array),
  http.protected.get("/experimental/workspace", "experimental.workspace.list").json(200, array),
  http.protected.get("/experimental/workspace/status", "experimental.workspace.status").json(200, array),
  http.protected
    .post("/experimental/workspace", "experimental.workspace.create")
    .at((ctx) => ({ path: "/experimental/workspace", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/experimental/workspace/sync-list", "experimental.workspace.syncList")
    .status(204, undefined, "status"),
  http.protected
    .delete("/experimental/workspace/{id}", "experimental.workspace.remove")
    .mutating()
    .at((ctx) => ({
      path: route("/experimental/workspace/{id}", { id: "wrk_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(200),
  http.protected
    .post("/experimental/workspace/warp", "experimental.workspace.warp")
    .at((ctx) => ({
      path: "/experimental/workspace/warp",
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/experimental/control-plane/move-session", "experimental.controlPlane.moveSession")
    .global()
    .at(() => ({
      path: "/experimental/control-plane/move-session",
      body: {},
    }))
    .status(400),
  http.protected.get("/experimental/capabilities", "experimental.capabilities.get").json(200, (body) => {
    check(typeof body === "object" && body !== null, "capabilities should be an object")
  }),
  http.protected
    .post("/experimental/session/{sessionID}/background", "experimental.session.background")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Background route owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/background", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      check(body === false, "background route should be a no-op without running subagents")
    }),
  http.protected.get("/experimental/resource", "experimental.resource.list").json(),
  http.protected
    .post("/instance/dispose", "instance.dispose")
    .mutating()
    .json(200, (body) => {
      check(body === true, "instance dispose should return true")
    }),
  http.protected
    .post("/log", "app.log")
    .global()
    .at(() => ({ path: "/log", body: { service: "httpapi-exercise", level: "info", message: "route coverage" } }))
    .json(200, (body) => {
      check(body === true, "log route should return true")
    }),
  http.protected
    .put("/auth/{providerID}", "auth.set")
    .global()
    .at(() => ({ path: route("/auth/{providerID}", { providerID: "test" }), body: { type: "api", key: "test-key" } }))
    .jsonEffect(200, (body) =>
      Effect.gen(function* () {
        check(body === true, "auth set should return true")
        const auth = yield* Effect.promise(() => Bun.file(path.join(exerciseDataDirectory, "auth.json")).json())
        object(auth)
        check(isRecord(auth.test) && auth.test.key === "test-key", "auth set should write isolated auth file")
      }),
    ),
  http.protected
    .delete("/auth/{providerID}", "auth.remove")
    .global()
    .seeded(() =>
      Effect.promise(() =>
        Bun.write(
          path.join(exerciseDataDirectory, "auth.json"),
          JSON.stringify({ test: { type: "api", key: "remove-me" } }),
        ),
      ),
    )
    .at(() => ({ path: route("/auth/{providerID}", { providerID: "test" }) }))
    .jsonEffect(200, (body) =>
      Effect.gen(function* () {
        check(body === true, "auth remove should return true")
        const auth = yield* Effect.promise(() => Bun.file(path.join(exerciseDataDirectory, "auth.json")).json())
        object(auth)
        check(auth.test === undefined, "auth remove should delete provider from isolated auth file")
      }),
    ),
  http.protected.get("/reference", "reference.list").json(200, array),
  http.protected
    .get("/session", "session.list")
    .seeded((ctx) => ctx.session({ title: "List me" }))
    .at((ctx) => ({ path: "/session?roots=true", headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      array(body)
      check(
        body.some((item) => isRecord(item) && item.id === ctx.state.id && item.title === "List me"),
        "seeded session should be listed",
      )
    }),
  http.protected
    .get("/session/status", "session.status")
    .seeded((ctx) => ctx.session({ title: "Status session" }))
    .json(200, object),
  http.protected
    .post("/session/{sessionID}/btw", "session.btw")
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({
          title: "btw side question",
          model: { id: "test-model", providerID: "test" },
        })
        yield* ctx.message(session.id, { text: "What did I ask you to inspect?" })
        yield* ctx.llmText("The repository layout.")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/btw", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { id: "httpapi-btw", question: "What did I ask about?" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.id === "httpapi-btw", "btw should echo the requested id")
      check(body.answer === "The repository layout.", "btw should return the fake LLM answer")
      check(isRecord(body.model) && body.model.modelID === "test-model", "btw should report the resolved model")
      check(isRecord(body.context), "btw should report context statistics")
      check(body.context?.inFlightDropped === false, "btw should not drop an in-flight turn when history is complete")
    }),
  http.protected
    .post("/session/{sessionID}/btw", "session.btw.busy")
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "btw concurrent", model: { id: "test-model", providerID: "test" } })
        yield* ctx.message(session.id, { text: "context" })
        yield* ctx.llmHang()
        const first = yield* ctx
          .request({
            method: "POST",
            path: route("/session/{sessionID}/btw", { sessionID: session.id }),
            headers: ctx.headers(),
            body: { id: "first", question: "first side question" },
          })
          .pipe(Effect.forkDetach)
        yield* ctx.llmWait(1)
        return { session, first }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/btw", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { id: "second", question: "second side question" },
    }))
    .jsonEffect(
      409,
      (body, ctx) =>
        Effect.gen(function* () {
          const cancelled = yield* ctx.request({
            method: "DELETE",
            path: route("/session/{sessionID}/btw/{btwID}", {
              sessionID: ctx.state.session.id,
              btwID: "first",
            }),
            headers: ctx.headers(),
          })
          check(
            cancelled.status === 204,
            `cancelling the first side question should return 204, got ${cancelled.status}`,
          )
          object(body)
          check(body.name === "BtwBusy", "a concurrent side question should report BtwBusy")
          const first = yield* Fiber.join(ctx.state.first)
          check(
            first.status === 409,
            `the cancelled side question should return 409, got ${first.status}: ${first.text}`,
          )
          check(
            isRecord(first.body) && first.body.name === "BtwCancelled",
            "the cancelled side question should report BtwCancelled",
          )
          const again = yield* ctx.request({
            method: "DELETE",
            path: route("/session/{sessionID}/btw/{btwID}", {
              sessionID: ctx.state.session.id,
              btwID: "first",
            }),
            headers: ctx.headers(),
          })
          check(again.status === 204, "cancelling an unknown side question should be idempotent")
        }),
      "status",
    ),
  http.protected
    .delete("/session/{sessionID}/btw/{btwID}", "session.btw.cancel")
    .seeded((ctx) => ctx.session({ title: "btw cancel" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/btw/{btwID}", { sessionID: ctx.state.id, btwID: "unknown" }),
      headers: ctx.headers(),
    }))
    .status(204),
  http.protected
    .delete("/session/{sessionID}/btw/{btwID}", "session.btw.cancel.missingSession")
    .at((ctx) => ({
      path: route("/session/{sessionID}/btw/{btwID}", {
        sessionID: "ses_httpapi_missing",
        btwID: "unknown",
      }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .post("/session", "session.create")
    .mutating()
    .at((ctx) => ({
      path: "/session",
      headers: ctx.headers(),
      body: { title: "Created session", dagMode: "on" },
    }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.title === "Created session", "created session should use requested title")
        check(body.directory === ctx.directory, "created session should use scenario directory")
        check(body.dagMode === "on", "created session should use requested dagMode")
        check(body.dagBudgetTokens === null, "created session should start without a DAG budget")
      },
      "status",
    ),
  http.protected
    .get("/session/{sessionID}", "session.get")
    .seeded((ctx) => ctx.session({ title: "Get me" }))
    .at((ctx) => ({ path: route("/session/{sessionID}", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      object(body)
      check(body.id === ctx.state.id, "should return requested session")
      check(body.title === "Get me", "should preserve seeded title")
    }),
  http.protected
    .get("/session/{sessionID}", "session.get.missing")
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .get("/session/{sessionID}/dag-mode", "session.dagMode")
    .seeded((ctx) => ctx.session({ title: "DAG status" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/dag-mode", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      check(body.mode === "off", "seeded session should report the default DAG mode")
      check(body.defaultMode === "off", "global default DAG mode should be off")
      check(body.availability === "available" || body.availability === "unavailable", "availability should be an enum")
      check(
        body.availability === "unavailable"
          ? typeof body.unavailableReason === "string"
          : body.unavailableReason === null,
        "unavailableReason should be set exactly when unavailable",
      )
      object(body.budget)
      check(body.budget.tokens === null, "unset budget should be null")
      check(body.budget.used === 0, "a fresh session should have no DAG usage")
      check(body.budget.usedCacheRead === 0, "a fresh session should have no cache-read usage")
      check(body.budget.warnRatio === 0.8, "warnRatio should default to 0.8")
      object(body.limits)
      check(typeof body.limits.concurrency === "number", "concurrency limit should be numeric")
      check(typeof body.limits.maxTotalNodes === "number", "node limit should be numeric")
      check(body.limits.running === 0, "no workflow nodes should be running")
      check(body.quality === null, "quality summary is null until E2 D6 lands")
    }),
  http.protected
    .patch("/session/{sessionID}", "session.update")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Before rename" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { title: "After rename" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.title === "After rename", "updated session should use new title")
      },
      "status",
    ),
  http.protected
    .patch("/session/{sessionID}", "session.update.invalid")
    .mutating()
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
      body: { title: 1 },
    }))
    .status(400),
  http.protected
    .patch("/session/{sessionID}", "session.update.rejectsDagMode")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Immutable DAG mode" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { dagMode: "on" },
    }))
    .status(400, (_ctx, result) =>
      Effect.sync(() => {
        const body = result.body
        object(body)
        check(body.name === "BadRequest", "rejected dagMode should return the BadRequest error shape")
        object(body.data)
        check(typeof body.data.message === "string", "rejected dagMode should include an error message")
      }),
    ),
  http.protected
    .patch("/session/{sessionID}", "session.update.rejectsDagBudget")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Immutable DAG budget" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { dagBudgetTokens: 1000 },
    }))
    .status(400, (_ctx, result) =>
      Effect.sync(() => {
        const body = result.body
        object(body)
        check(body.name === "BadRequest", "rejected dagBudgetTokens should return the BadRequest error shape")
        object(body.data)
        check(typeof body.data.message === "string", "rejected dagBudgetTokens should include an error message")
      }),
    ),
  http.protected
    .delete("/session/{sessionID}", "session.delete")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Delete me" }))
    .at((ctx) => ({ path: route("/session/{sessionID}", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete should return true")
        check((yield* ctx.sessionGet(ctx.state.id)) === undefined, "deleted session should not remain in storage")
      }),
    ),
  http.protected
    .get("/session/{sessionID}/children", "session.children")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const parent = yield* ctx.session({ title: "Parent" })
        const child = yield* ctx.session({ title: "Child", parentID: parent.id })
        return { parent, child }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/children", { sessionID: ctx.state.parent.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      array(body)
      check(
        body.some((item) => isRecord(item) && item.id === ctx.state.child.id && item.parentID === ctx.state.parent.id),
        "children should include seeded child",
      )
    }),
  http.protected
    .get("/session/{sessionID}/todo", "session.todo")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Todo session" })
        const todos = [{ content: "cover session todo", status: "pending", priority: "high" }]
        yield* ctx.todos(session.id, todos)
        return { session, todos }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/todo", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      check(stable(body) === stable(ctx.state.todos), "todos should match seeded state")
    }),
  http.protected
    .get("/session/{sessionID}/goal", "session.goal")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Goal session" })
        yield* ctx.goal(session.id, "cover session goal")
        return { session }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/goal", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      check(body.goal === "cover session goal", "goal text should match seeded state")
      check(body.status === "active", "status should be active for a freshly seeded goal")
      check(body.turnsUsed === 0, "turnsUsed should be 0 for a freshly seeded goal")
      check(body.maxTurns === 20, "maxTurns should be the default (20)")
      check(Array.isArray(body.subgoals) && body.subgoals.length === 0, "subgoals should be an empty array")
      check(!("pausedReason" in body), "pausedReason should be absent when goal is active")
    }),
  http.protected
    .get("/session/{sessionID}/goal", "session.goal.absent")
    .seeded((ctx) => ctx.session({ title: "Goalless session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/goal", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/lifecycle/state/{domain}/{id}", "lifecycle.get")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Lifecycle goal session" })
        yield* ctx.goal(session.id, "cover lifecycle state")
        return { session }
      }),
    )
    .at((ctx) => ({
      path: route("/lifecycle/state/{domain}/{id}", { domain: "goal", id: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      object(body)
      check(body.domain === "goal", "domain should be goal")
      check(body.id === ctx.state.session.id, "id should be the session id")
      check(body.value === "active", "a freshly seeded goal should read back active")
      check(body.phase === "running", "active should map to the running phase")
      check(body.terminal === false, "an active goal is not terminal")
      check(body.settled === false, "an active goal is not settled")
      check(body.source === "persisted", "goal state should come from the durable row")
      check(typeof body.observedAt === "number", "observedAt should be a timestamp")
    }),
  http.protected
    .get("/lifecycle/state/{domain}/{id}", "lifecycle.get.missing")
    .seeded((ctx) => ctx.session({ title: "Lifeless session" }))
    .at((ctx) => ({
      path: route("/lifecycle/state/{domain}/{id}", { domain: "goal", id: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/lifecycle/states", "lifecycle.states")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Lifecycle batch session" })
        yield* ctx.goal(session.id, "cover lifecycle batch")
        return { session }
      }),
    )
    .at((ctx) => ({
      path: "/lifecycle/states",
      headers: ctx.headers(),
      body: {
        refs: [
          { domain: "goal", id: ctx.state.session.id },
          { domain: "goal", id: "ses_missing_lifecycle_goal" },
          { domain: "job", id: "job_missing_lifecycle_job" },
        ],
      },
    }))
    .json(200, (body, ctx) => {
      array(body)
      check(body.length === 3, "one entry should be returned per requested ref")
      const [own, missingGoal, missingJob] = body
      check(isRecord(own), "the existing goal entry should be an object")
      check(own.domain === "goal" && own.id === ctx.state.session.id, "the goal entry should echo its ref")
      const ownState = own.state
      check(isRecord(ownState), "the existing goal entry should carry a state")
      check(ownState.value === "active", "the goal entry should carry the durable status")
      check(isRecord(missingGoal), "the missing goal entry should be an object")
      check(
        missingGoal.domain === "goal" && missingGoal.id === "ses_missing_lifecycle_goal",
        "the missing goal entry should echo its ref",
      )
      check(missingGoal.state === null, "an unknown goal ref should carry a null state")
      check(isRecord(missingJob), "the missing job entry should be an object")
      check(
        missingJob.domain === "job" && missingJob.id === "job_missing_lifecycle_job",
        "the missing job entry should echo its ref",
      )
      check(missingJob.state === null, "an unknown job ref should carry a null state")
    }),
  http.protected
    .post("/session/{sessionID}/hook", "session.hook.add")
    .seeded((ctx) => ctx.session({ title: "Hook session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/hook", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        event: "UserPromptSubmit",
        hooks: [{ type: "command", command: "printf '%s' 'hook-ran'", inputFormat: "claude-code" }],
      },
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.id === "string" && body.id.length > 0, "hook add should return an entry id")
    }),
  http.protected
    .post("/session/{sessionID}/hook", "session.hook.add.invalid")
    .seeded((ctx) => ctx.session({ title: "Hook invalid session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/hook", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { event: "NotAnEvent", hooks: [{ type: "command", command: "printf '%s' 'x'" }] },
    }))
    .status(400),
  http.protected
    .post("/session/{sessionID}/hook", "session.hook.add.invalid_input_format")
    .seeded((ctx) => ctx.session({ title: "Hook invalid input format" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/hook", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { event: "PreToolUse", hooks: [{ type: "command", command: "true", inputFormat: "CLAUDE" }] },
    }))
    .status(400),
  http.protected
    .post("/session/{sessionID}/hook", "session.hook.add.non_command_input_format")
    .seeded((ctx) => ctx.session({ title: "Hook non-command input format" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/hook", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        event: "PreToolUse",
        hooks: [
          { type: "http", url: "https://example.com", inputFormat: "claude-code" },
          { type: "prompt", prompt: "Check the request", inputFormat: "claude-code" },
          { type: "agent", prompt: "Review the request", inputFormat: "claude-code" },
          { type: "mcp_tool", server: "test", tool: "lookup", inputFormat: "claude-code" },
        ],
      },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(typeof body.id === "string" && body.id.length > 0, "hook add should return an entry id")
        const readback = yield* ctx.request({
          method: "GET",
          path: route("/session/{sessionID}/hook", { sessionID: ctx.state.id }),
          headers: ctx.headers(),
        })
        check(readback.status === 200, `hook list should return 200, got ${readback.status}: ${readback.text}`)
        check(Array.isArray(readback.body) && readback.body.length === 1, "hook list should contain the created entry")
        const [entry] = readback.body
        object(entry)
        check(entry.id === body.id, "hook list should return the created entry id")
        check(entry.event === "PreToolUse", "hook list should preserve the event")
        check(
          Array.isArray(entry.hooks) && entry.hooks.length === 4,
          "hook list should preserve all supported handlers",
        )
        const hooks = entry.hooks
        for (const type of ["http", "prompt", "agent", "mcp_tool"]) {
          const hook = hooks.find((item) => isRecord(item) && item.type === type)
          check(isRecord(hook), `hook list should include the ${type} handler`)
          check(hook.inputFormat === "claude-code", `${type} hook should preserve inputFormat`)
        }
        const mcpTool = hooks.find((item) => isRecord(item) && item.type === "mcp_tool")
        check(
          isRecord(mcpTool) && mcpTool.server === "test" && mcpTool.tool === "lookup",
          "mcp_tool hook should preserve server and tool",
        )
      }),
    ),
  http.protected
    .post("/session/{sessionID}/hook", "session.hook.add.legacy_mcp_alias_rejected")
    .seeded((ctx) => ctx.session({ title: "Hook legacy mcp alias session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/hook", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { event: "PreToolUse", hooks: [{ type: "mcp", command: "mcp__test__lookup" }] },
    }))
    .status(400),
  http.protected
    .post("/session/{sessionID}/hook", "session.hook.add.empty_command")
    .seeded((ctx) => ctx.session({ title: "Hook empty command session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/hook", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { event: "UserPromptSubmit", hooks: [{ type: "command", command: "" }] },
    }))
    .status(400),
  http.protected
    .post("/session/{sessionID}/hook", "session.hook.add.non_positive_timeout")
    .seeded((ctx) => ctx.session({ title: "Hook bad timeout session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/hook", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { event: "UserPromptSubmit", hooks: [{ type: "command", command: "true", timeout: 0 }] },
    }))
    .status(400),
  http.protected
    .get("/session/{sessionID}/hook", "session.hook.list")
    .seeded((ctx) => ctx.session({ title: "Hook list session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/hook", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, array),
  http.protected
    .delete("/session/{sessionID}/hook/{hookID}", "session.hook.remove")
    .seeded((ctx) => ctx.session({ title: "Hook remove session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/hook/{hookID}", {
        sessionID: ctx.state.id,
        hookID: "does-not-exist",
      }),
      headers: ctx.headers(),
    }))
    // DELETE is idempotent — a non-existent hookID succeeds (204 NoContent).
    .status(204),
  http.protected
    .post("/session/{sessionID}/hook/{hookID}/cancel", "session.hook.cancel")
    .seeded((ctx) => ctx.session({ title: "Hook cancel session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/hook/{hookID}/cancel", {
        sessionID: ctx.state.id,
        hookID: "does-not-exist",
      }),
      headers: ctx.headers(),
    }))
    // A handler digest that is not running is a miss, not an error.
    .json(200, (body) => {
      object(body)
      check(body.cancelled === false, "cancelling a non-running hook should report false")
    }),
  http.protected
    .get("/session/{sessionID}/diff", "session.diff")
    .seeded((ctx) => ctx.session({ title: "Diff session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/diff", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/session/{sessionID}/message", "session.messages")
    .seeded((ctx) => ctx.session({ title: "Messages session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/message", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      array(body)
      check(body.length === 0, "new session should have no messages")
    }),
  http.protected
    .get("/session/{sessionID}/message/{messageID}", "session.message")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Message get session" })
        const message = yield* ctx.message(session.id, { text: "read me" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
      }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      object(body)
      check(isRecord(body.info) && body.info.id === ctx.state.message.info.id, "should return requested message")
      check(
        Array.isArray(body.parts) && body.parts.some((part) => isRecord(part) && part.id === ctx.state.message.part.id),
        "message should include seeded part",
      )
    }),
  http.protected
    .patch("/session/{sessionID}/message/{messageID}/part/{partID}", "part.update")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Part update session" })
        const message = yield* ctx.message(session.id, { text: "before" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}/part/{partID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
        partID: ctx.state.message.part.id,
      }),
      headers: ctx.headers(),
      body: { ...ctx.state.message.part, text: "after" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.type === "text" && body.text === "after", "updated part should be returned")
      },
      "status",
    ),
  http.protected
    .delete("/session/{sessionID}/message/{messageID}/part/{partID}", "part.delete")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Part delete session" })
        const message = yield* ctx.message(session.id, { text: "delete part" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}/part/{partID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
        partID: ctx.state.message.part.id,
      }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete part should return true")
        const messages = yield* ctx.messages(ctx.state.session.id)
        check(messages[0]?.parts.length === 0, "deleted part should not remain on message")
      }),
    ),
  http.protected
    .delete("/session/{sessionID}/message/{messageID}", "session.deleteMessage")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Message delete session" })
        const message = yield* ctx.message(session.id, { text: "delete message" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
      }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete message should return true")
        check((yield* ctx.messages(ctx.state.session.id)).length === 0, "deleted message should not remain")
      }),
    ),
  http.protected
    .patch("/session/{sessionID}/message/{messageID}/queued", "session.editQueuedMessage")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Queued edit validation" })
        const message = yield* ctx.message(session.id, { text: "not queued" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}/queued", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
      }),
      headers: ctx.headers(),
      body: {
        partID: ctx.state.message.part.id,
        expectedText: ctx.state.message.part.text,
        expectedPartIDs: [ctx.state.message.part.id],
        text: "edited",
      },
    }))
    .json(409, (body) => {
      object(body)
      check(
        body.name === "ConflictError" && isRecord(body.data) && body.data.resource === "not_queued",
        "edit should reject a non-queued message",
      )
    }),
  http.protected
    .delete("/session/{sessionID}/message/{messageID}/queued", "session.deleteQueuedMessage")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Queued delete validation" })
        const message = yield* ctx.message(session.id, { text: "not queued" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}/queued", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
      }),
      headers: ctx.headers(),
      body: {
        partID: ctx.state.message.part.id,
        expectedText: ctx.state.message.part.text,
        expectedPartIDs: [ctx.state.message.part.id],
      },
    }))
    .json(409, (body) => {
      object(body)
      check(
        body.name === "ConflictError" && isRecord(body.data) && body.data.resource === "not_queued",
        "delete should reject a non-queued message",
      )
    }),
  http.protected
    .post("/session/{sessionID}/fork", "session.fork")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Fork source" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/fork", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(typeof body.id === "string", "fork should return a session")
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/abort", "session.abort")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Abort session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/abort", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      check(body === true, "abort should return true")
    }),
  http.protected
    .post("/session/{sessionID}/abort", "session.abort.missing")
    .at((ctx) => ({
      path: route("/session/{sessionID}/abort", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      check(body === true, "missing session abort should remain a no-op success")
    }),
  http.protected
    .post("/session/{sessionID}/init", "session.init")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Init session" })
        const message = yield* ctx.message(session.id, { text: "initialize" })
        yield* ctx.llmText("initialized")
        yield* ctx.llmText("initialized")
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/init", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { providerID: "test", modelID: "test-model", messageID: ctx.state.message.info.id },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "init should return true")
        yield* ctx.llmWait(1)
      }),
    ),
  http.protected
    .post("/session/{sessionID}/model", "session.setModel")
    .withLlm()
    .seeded((ctx) => ctx.session({ title: "Hook model selection" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/model", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { model: { providerID: "test", modelID: "test-model" }, source: "sdk" },
    }))
    .json(200, (body) => {
      object(body)
      check(
        body.providerID === "test" && body.modelID === "test-model",
        "model selection must return the committed model",
      )
    }),
  http.protected
    .post("/session/{sessionID}/attention", "session.attention")
    .seeded((ctx) => ctx.session({ title: "Legacy client attention" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/attention", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { clientID: "httpapi-exercise", clientType: "web", activity: 1, closed: true },
    }))
    .json(200, (body) => check(body === true, "session attention must acknowledge the actual session")),
  http.protected
    .post("/session/{sessionID}/resume", "session.resume")
    .seeded((ctx) => ctx.session({ title: "Hook initial no-op" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/resume", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { initialOnly: true, hookMode: "noninteractive" },
    }))
    .json(200, (body) =>
      check(body === null, "resume must not manufacture a user message when no initial hook message is queued"),
    ),
  http.protected
    .post("/session/{sessionID}/message", "session.prompt")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "LLM prompt session" })
        yield* ctx.llmText("fake assistant")
        yield* ctx.llmText("fake assistant")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "hello llm" }],
      },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(isRecord(body.info) && body.info.role === "assistant", "prompt should return assistant message")
          check(
            Array.isArray(body.parts) && body.parts.some((part) => isRecord(part) && part.text === "fake assistant"),
            "assistant message should use fake LLM text",
          )
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/prompt_async", "session.prompt_async")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Async prompt session" })
        yield* ctx.llmText("fake async assistant")
        yield* ctx.llmText("fake async assistant")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/prompt_async", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "hello async" }],
      },
    }))
    .status(204, (ctx) =>
      Effect.gen(function* () {
        yield* ctx.llmWait(1)
      }),
    ),
  http.protected
    .post("/session/{sessionID}/command", "session.command")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Command session" })
        yield* ctx.llmText("command done")
        yield* ctx.llmText("command done")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/command", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { command: "init", arguments: "", model: "test/test-model" },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(isRecord(body.info) && body.info.role === "assistant", "command should return assistant message")
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/shell", "session.shell")
    .preserveDatabase()
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Shell session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/shell", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { agent: "build", model: { providerID: "test", modelID: "test-model" }, command: "printf shell-ok" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(isRecord(body.info) && body.info.role === "assistant", "shell should return assistant message")
        check(
          Array.isArray(body.parts) && body.parts.some((part) => isRecord(part) && part.type === "tool"),
          "shell should return a tool part",
        )
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/summarize", "session.summarize")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Summarize session" })
        yield* ctx.message(session.id, { text: "summarize this work" })
        const summary = [
          "## Goal",
          "- Exercise session summarize.",
          "",
          "## Constraints & Preferences",
          "- Use fake LLM.",
          "",
          "## Progress",
          "### Done",
          "- Summary generated.",
          "",
          "### In Progress",
          "- (none)",
          "",
          "### Blocked",
          "- (none)",
          "",
          "## Key Decisions",
          "- Keep route local.",
          "",
          "## Next Steps",
          "- (none)",
          "",
          "## Critical Context",
          "- Test fixture.",
          "",
          "## Relevant Files",
          "- test/server/httpapi-exercise/index.ts: scenario",
        ].join("\n")
        yield* ctx.llmText(summary)
        yield* ctx.llmText(summary)
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/summarize", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { providerID: "test", modelID: "test-model", auto: false },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          check(body === true, "summarize should return true")
          const messages = yield* ctx.messages(ctx.state.id)
          check(
            messages.some((message) => message.info.role === "assistant" && message.info.summary === true),
            "summarize should create a summary assistant message",
          )
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/revert", "session.revert")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Revert session" })
        const message = yield* ctx.message(session.id, { text: "revert me" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/revert", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { messageID: ctx.state.message.info.id },
    }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.session.id, "revert should return the session")
        check(
          isRecord(body.revert) && body.revert.messageID === ctx.state.message.info.id,
          "revert should record reverted message",
        )
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/unrevert", "session.unrevert")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Unrevert session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/unrevert", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.id, "unrevert should return the session")
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/permissions/{permissionID}", "permission.respond")
    .seeded((ctx) => ctx.session({ title: "Deprecated permission session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/permissions/{permissionID}", {
        sessionID: ctx.state.id,
        permissionID: "per_httpapi_deprecated",
      }),
      headers: ctx.headers(),
      body: { response: "once" },
    }))
    .json(404, object, "status"),

  // ── Child session read-only guard (#1026) ───────────────────────────
  // Refused: one scenario per class of write. The reflection test in
  // test/server/httpapi-child-readonly.test.ts covers every endpoint.
  refusedForChild(
    http.protected.post("/session/{sessionID}/message", "session.prompt.childReadOnly"),
    "/session/{sessionID}/message",
    {
      body: { agent: "build", noReply: true, parts: [{ type: "text", text: "hello" }] },
    },
  ),
  http.protected
    .post("/session/{sessionID}/prompt_async", "session.prompt_async.childReadOnly")
    .mutating()
    .seeded(seedChild)
    .at((ctx) => ({
      path: route("/session/{sessionID}/prompt_async", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { agent: "build", parts: [{ type: "text", text: "hello" }] },
    }))
    // Not the 204 a forked handler returns: the guard answers before the fork.
    .jsonEffect(
      409,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(
            body.name === "ChildSessionReadOnlyError",
            "promptAsync on a child should name ChildSessionReadOnlyError",
          )
          check(
            (yield* ctx.messages(ctx.state.id)).length === 0,
            "a refused promptAsync must not leave a message in the child session",
          )
        }),
      "status",
    ),
  refusedForChild(
    http.protected.post("/session/{sessionID}/abort", "session.abort.childReadOnly"),
    "/session/{sessionID}/abort",
  ),
  refusedForChild(
    http.protected.patch("/session/{sessionID}", "session.update.childReadOnly"),
    "/session/{sessionID}",
    {
      body: { title: "renamed" },
    },
  ),
  refusedForChild(
    http.protected.delete("/session/{sessionID}", "session.delete.childReadOnly"),
    "/session/{sessionID}",
  ),
  refusedForChild(
    http.protected.post("/session/{sessionID}/fork", "session.fork.childReadOnly"),
    "/session/{sessionID}/fork",
    {
      body: {},
    },
  ),
  refusedForChild(
    http.protected.post("/session/{sessionID}/hook", "session.hook.add.childReadOnly"),
    "/session/{sessionID}/hook",
    {
      body: { event: "PreToolUse", hooks: [{ type: "command", command: "true" }] },
    },
  ),
  refusedForChild(
    http.protected.delete("/session/{sessionID}/message/{messageID}", "session.deleteMessage.childReadOnly"),
    "/session/{sessionID}/message/{messageID}",
    { params: { messageID: "msg_httpapi_child" } },
  ),
  // Outside the session group.
  refusedForChild(
    http.protected.post(
      "/experimental/session/{sessionID}/background",
      "experimental.session.background.childReadOnly",
    ),
    "/experimental/session/{sessionID}/background",
  ),
  http.protected
    .post("/experimental/workspace/warp", "experimental.workspace.warp.childReadOnly")
    .mutating()
    .seeded(seedChild)
    .at((ctx) => ({
      path: "/experimental/workspace/warp",
      headers: ctx.headers(),
      body: { id: null, sessionID: ctx.state.id },
    }))
    .json(409, (body, ctx) => {
      object(body)
      check(body.name === "ChildSessionReadOnlyError", "warp of a child should name ChildSessionReadOnlyError")
      object(body.data)
      check(body.data.sessionID === ctx.state.id, "the error should name the child session")
    }),
  http.protected
    .post("/experimental/control-plane/move-session", "experimental.controlPlane.moveSession.childReadOnly")
    // A root route: it needs no instance, but the seeded child does.
    .mutating()
    .seeded(seedChild)
    .at((ctx) => ({
      path: "/experimental/control-plane/move-session",
      body: { sessionID: ctx.state.id, destination: { directory: ctx.directory ?? "/tmp" } },
    }))
    .json(409, (body, ctx) => {
      object(body)
      check(body.name === "ChildSessionReadOnlyError", "move of a child should name ChildSessionReadOnlyError")
      object(body.data)
      check(body.data.sessionID === ctx.state.id, "the error should name the child session")
    }),

  // Left open on a child: a fixed permission reply, the read-only side
  // question, the attention lease. They reach their handler (not 409).
  http.protected
    .post("/session/{sessionID}/permissions/{permissionID}", "permission.respond.childAllowed")
    .seeded(seedChild)
    .at((ctx) => ({
      path: route("/session/{sessionID}/permissions/{permissionID}", {
        sessionID: ctx.state.id,
        permissionID: "per_httpapi_child_allowed",
      }),
      headers: ctx.headers(),
      body: { response: "once" },
    }))
    // The handler runs and finds no such request; the guard did not answer.
    .json(
      404,
      (body) => {
        object(body)
        check(body.name === "PermissionNotFoundError", "a child permission reply should reach the permission handler")
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/attention", "session.attention.childAllowed")
    .seeded(seedChild)
    .at((ctx) => ({
      path: route("/session/{sessionID}/attention", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { clientID: "httpapi-exercise", clientType: "web", activity: 1, closed: true },
    }))
    .json(200, (body) => check(body === true, "attention on a child session should be acknowledged")),
  http.protected
    .delete("/session/{sessionID}/btw/{btwID}", "session.btw.cancel.childAllowed")
    .seeded(seedChild)
    .at((ctx) => ({
      path: route("/session/{sessionID}/btw/{btwID}", { sessionID: ctx.state.id, btwID: "unknown" }),
      headers: ctx.headers(),
    }))
    .status(204),

  // Reads stay open.
  http.protected
    .get("/session/{sessionID}", "session.get.child")
    .seeded(seedChild)
    .at((ctx) => ({ path: route("/session/{sessionID}", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      object(body)
      check(body.id === ctx.state.id, "a child session should be readable")
      check(typeof body.parentID === "string", "the child session should expose its parentID")
    }),
  http.protected
    .get("/session/{sessionID}/message", "session.messages.child")
    .seeded(seedChild)
    .at((ctx) => ({ path: route("/session/{sessionID}/message", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, array),

  // A child session is never created from a public payload.
  http.protected
    .post("/session", "session.create.rejectsParentID")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Would-be parent" }))
    .at((ctx) => ({
      path: "/session",
      headers: ctx.headers(),
      body: { title: "Smuggled child", parentID: ctx.state.id },
    }))
    .status(400),
  http.protected
    .post("/global/upgrade", "global.upgrade")
    .global()
    .probe({ path: "/global/upgrade", body: { target: 1 } })
    .at(() => ({ path: "/global/upgrade", body: { target: "99.0.0" } }))
    .json(400, (body) => {
      object(body)
      check(body.success === false, "built-in updates must be disabled")
      check(
        typeof body.error === "string" && body.error.includes("disabled"),
        "disabled update explanation is required",
      )
    }),

  // ── DAG workflow routes ──────────────────────────────────────────────
  // Happy-path scenarios with a real workflow fixture (pays down "only 404 tested" debt)
  http.protected
    .get("/dag", "dag.list")
    .seeded((ctx) =>
      ctx.session({ title: "DAG list owner" }).pipe(
        Effect.flatMap((s) =>
          ctx.dag({
            sessionID: s.id,
            nodes: [
              { id: "a", name: "Node A", worker_type: "general", depends_on: [], required: true },
              { id: "b", name: "Node B", worker_type: "general", depends_on: ["a"], required: false },
            ],
          }),
        ),
      ),
    )
    .jsonEffect(200, (body) =>
      Effect.sync(() => {
        array(body)
        check(body.length >= 1, "dag.list should return at least one workflow")
      }),
    ),

  http.protected
    .get("/dag/session/{sessionID}", "dag.bySession")
    .seeded((ctx) =>
      ctx.session({ title: "DAG bySession owner" }).pipe(
        Effect.flatMap((s) =>
          ctx.dag({
            sessionID: s.id,
            nodes: [{ id: "x", name: "X", worker_type: "general", depends_on: [], required: true }],
          }),
        ),
      ),
    )
    .at((ctx) => ({
      path: route("/dag/session/{sessionID}", { sessionID: ctx.state.sessionID }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body) =>
      Effect.sync(() => {
        array(body)
        check(body.length >= 1, "dag.bySession should return the fixture workflow")
      }),
    ),

  http.protected
    .get("/dag/session/{sessionID}/summary", "dag.summary")
    .seeded((ctx) =>
      ctx.session({ title: "DAG summary owner" }).pipe(
        Effect.flatMap((s) =>
          ctx.dag({
            sessionID: s.id,
            nodes: [
              { id: "a", name: "A", worker_type: "general", depends_on: [], required: true },
              { id: "b", name: "B", worker_type: "general", depends_on: ["a"], required: false },
            ],
          }),
        ),
      ),
    )
    .at((ctx) => ({
      path: route("/dag/session/{sessionID}/summary", { sessionID: ctx.state.sessionID }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body) =>
      Effect.sync(() => {
        array(body)
        check(body.length >= 1, "dag.summary should return at least one summary")
        const summary = body[0]
        object(summary)
        check(typeof summary.nodeCount === "number", "summary should have nodeCount")
        check(typeof summary.completedNodes === "number", "summary should have completedNodes")
        check(typeof summary.runningNodes === "number", "summary should have runningNodes")
        check(typeof summary.failedNodes === "number", "summary should have failedNodes")
        check(
          typeof summary.abortedNodes === "number" && summary.abortedNodes >= 0,
          "summary should have abortedNodes as a non-negative number",
        )
        check(typeof summary.status === "string", "summary should have status")
        check(typeof summary.title === "string", "summary should have title")
        check(typeof summary.escalatedNodes === "number", "summary should have escalatedNodes")
        // #1027 D6a: usage is summed from the attempt ledger; a fresh fixture
        // has no attempts. Cache reads are separate, and quality/coverage are
        // fixed-shape placeholders until D6b computes them.
        check(
          typeof summary.tokens === "number" && summary.tokens >= 0,
          "summary should have tokens as a non-negative number",
        )
        check(
          typeof summary.tokensCacheRead === "number" && summary.tokensCacheRead >= 0,
          "summary should have tokensCacheRead as a non-negative number",
        )
        check(summary.checkpointPending === false, "a fresh fixture is not checkpoint-pending")
        check(summary.coverageCount === 0, "D6a fixes coverageCount at 0")
        check(summary.quality === null, "D6a fixes quality at null")
        // #468: graphRev is the topology invalidation token — an equal-count
        // replan bumps it alone so TUI signatures can detect the change.
        check(typeof summary.graphRev === "number", "summary should have graphRev")
        check(summary.graphRev === 1, "fresh fixture workflow should carry graphRev 1")
      }),
    ),

  http.protected
    .get("/dag/{dagID}/nodes", "dag.nodes")
    .seeded((ctx) =>
      ctx.session({ title: "DAG nodes owner" }).pipe(
        Effect.flatMap((s) =>
          ctx.dag({
            sessionID: s.id,
            nodes: [
              { id: "a", name: "Node A", worker_type: "general", depends_on: [], required: true },
              { id: "b", name: "Node B", worker_type: "general", depends_on: ["a"], required: false },
            ],
          }),
        ),
        Effect.flatMap((dag) =>
          ctx.dagFailNode(dag.dagID, "b", "node exceeded timeout of 600000ms", "timeout").pipe(Effect.as(dag)),
        ),
        Effect.flatMap((dag) => ctx.dagAgentMessage(dag.dagID, "a", dag.sessionID).pipe(Effect.as(dag))),
      ),
    )
    .at((ctx) => ({ path: route("/dag/{dagID}/nodes", { dagID: ctx.state.dagID }), headers: ctx.headers() }))
    .jsonEffect(200, (body) =>
      Effect.sync(() => {
        array(body)
        check(body.length >= 2, "nodes should return all fixture nodes")
        const n = body[0]
        object(n)
        check(typeof n.id === "string", "node should have id")
        check(typeof n.status === "string", "node should have status")
        check(Array.isArray(n.depends_on), "node should have depends_on")
        check(typeof n.replan_attempts === "number", "node should have replan_attempts")
        const failed = body.find((node: any) => node.id === "b")
        object(failed)
        check(failed.status === "failed", "seeded node b should be failed")
        check(failed.error_class === "timeout", "failed node should expose error_class on the wire")
        check(typeof failed.error_reason === "string", "failed node should expose error_reason")
        const pristine = body.find((node: any) => node.id === "a")
        object(pristine)
        check(!("error_class" in pristine), "error_class should be absent on non-failed nodes")
        check(typeof pristine.attempt_id === "string", "running node should expose exact attempt identity")
        check(typeof pristine.last_activity_at === "string", "node should expose its last activity timestamp")
        check(
          !("head" in pristine) || (typeof pristine.head === "string" && /^[0-9a-f]{7,12}$/.test(pristine.head)),
          "head must be a short sha when present",
        )
        check(pristine.accepted_input_revision === 1, "acceptance should advance input revision")
        check(pristine.snapshot_revision === 0, "queued message must not advance model snapshot")
        object(pristine.agent_messages)
        check(pristine.agent_messages.queued === 1, "accepted input should be queued")
        check(pristine.agent_messages.delivered === 0, "acceptance must not claim delivery")
        check(pristine.agent_messages.undeliverable === 0, "live recipient should have no undeliverable input")
        check(
          !JSON.stringify(body).includes("HTTP_MESSAGE_BODY_PRIVATE"),
          "node metadata must not expose message bodies",
        )
      }),
    ),

  // Project-isolation regressions: the instance API must treat foreign
  // sessions/workflows as nonexistent even though they share the same DB.
  http.protected
    .get("/dag", "dag.list.isolation")
    .seeded((ctx) =>
      ctx.foreignDag({
        title: "Foreign list workflow",
        nodes: [{ id: "foreign", name: "Foreign", worker_type: "general", depends_on: [], required: true }],
      }),
    )
    .jsonEffect(200, (body, ctx) =>
      Effect.sync(() => {
        array(body)
        check(
          !body.some((item) => isRecord(item) && item.id === ctx.state.dagID),
          "dag.list must not expose workflows owned by another project",
        )
      }),
    ),

  http.protected
    .get("/dag/session/{sessionID}", "dag.bySession.isolation")
    .seeded((ctx) =>
      ctx.foreignDag({
        title: "Foreign session workflows",
        nodes: [{ id: "foreign", name: "Foreign", worker_type: "general", depends_on: [], required: true }],
      }),
    )
    .at((ctx) => ({
      path: route("/dag/session/{sessionID}", { sessionID: ctx.state.sessionID }),
      headers: ctx.headers(),
    }))
    .status(404),

  http.protected
    .get("/dag/session/{sessionID}/summary", "dag.summary.isolation")
    .seeded((ctx) =>
      ctx.foreignDag({
        title: "Foreign session summary",
        nodes: [{ id: "foreign", name: "Foreign", worker_type: "general", depends_on: [], required: true }],
      }),
    )
    .at((ctx) => ({
      path: route("/dag/session/{sessionID}/summary", { sessionID: ctx.state.sessionID }),
      headers: ctx.headers(),
    }))
    .status(404),

  http.protected
    .get("/dag/{dagID}/nodes", "dag.nodes.isolation")
    .seeded((ctx) =>
      ctx.foreignDag({
        title: "Foreign workflow nodes",
        nodes: [{ id: "foreign", name: "Foreign", worker_type: "general", depends_on: [], required: true }],
      }),
    )
    .at((ctx) => ({
      path: route("/dag/{dagID}/nodes", { dagID: ctx.state.dagID }),
      headers: ctx.headers(),
    }))
    .status(404),

  // 404 scenarios (pre-existing, retained)
  http.protected
    .get("/dag/{dagID}/nodes", "dag.nodes")
    .at(() => ({
      path: route("/dag/{dagID}/nodes", { dagID: "dag_nonexistent" }),
      headers: {} as Record<string, string>,
    }))
    .status(404),
]

const llmScenarios = new Set([
  "session.init",
  "session.setModel",
  "session.prompt",
  "session.prompt_async",
  "session.command",
  "session.summarize",
  "session.btw",
  "session.btw.busy",
])

const main = Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Effect.promise(() => teardown(options)))
  const parsed = parseOptions(Bun.argv.slice(2))
  const options: Options = parsed.progress ? { ...parsed, heartbeat: startProgressWatchdog() } : parsed
  const modules = yield* Effect.promise(() => runtime())
  const effectRoutes = routeKeys(OpenApi.fromApi(modules.PublicApi))
  const selected = selectedScenarios(options, scenarios)
  const missing = effectRoutes.filter((route) => !scenarios.some((scenario) => route === routeKey(scenario)))
  const extra = scenarios.filter((scenario) => !effectRoutes.includes(routeKey(scenario)))
  const worktreesBefore = new Set(invokingWorktrees())

  for (const scenario of scenarios) {
    if (scenario.kind === "active" && llmScenarios.has(scenario.name) && !scenario.project?.llm) {
      return yield* Effect.fail(new Error(`${scenario.name} must use TestLLMServer via .withLlm()`))
    }
  }

  printHeader(options, effectRoutes, selected, missing, extra, {
    database: exerciseDatabasePath,
    global: exerciseGlobalRoot,
  })

  const results =
    options.mode === "coverage"
      ? selected.map(coverageResult)
      : yield* Effect.forEach(
          selected,
          (scenario) =>
            Effect.gen(function* () {
              if (options.progress) console.log(`${color.dim}RUN ${routeKey(scenario)} ${scenario.name}${color.reset}`)
              options.heartbeat?.(`RUN ${routeKey(scenario)} ${scenario.name}`)
              return yield* runScenario(options)(scenario)
            }),
          { concurrency: 1 },
        )
  printResults(results, missing, extra)

  const leakedWorktrees = invokingWorktrees().filter((worktree) => !worktreesBefore.has(worktree))
  if (leakedWorktrees.length > 0)
    return yield* Effect.fail(
      new Error(`exercise created worktrees on the invoking checkout: ${leakedWorktrees.join(", ")}`),
    )
  if (results.some((result) => result.status === "fail"))
    return yield* Effect.fail(new Error("one or more scenarios failed"))
  if (options.failOnSkip && results.some((result) => result.status === "skip"))
    return yield* Effect.fail(new Error("one or more scenarios are skipped"))
  if (options.failOnMissing && missing.length > 0)
    return yield* Effect.fail(new Error("one or more routes have no scenario"))
  return undefined
})

runMainWithHardExit(Effect.runPromise(main.pipe(Effect.provide(TestLLMServer.layer), Effect.scoped)), (code) =>
  process.exit(code),
)
