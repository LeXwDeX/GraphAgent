import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ContextFoldingPolicy } from "../../../../packages/core/src/session/context-folding/policy"
import { Token } from "../../../../packages/core/src/util/token"
import type { SessionV1 } from "../../../../packages/core/src/v1/session"
import {
  executeLiveRun,
  failureArtifact,
  oneRequestPreflightOverflowEvidence,
  providerNon2xxFailure,
  validateTaskAnswer,
  type PrivateConfig,
} from "./live-pair-driver"
import { initializePrivateRunLedger, LIVE_RUN_PLAN, type LiveRunPlan } from "./live-run-contract"
import { materializeBodiesV3, V3_TASKS } from "./task-spec-v3"

const sha256 = (input: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(input).digest("hex")

async function continuationSources(root: string, name: string) {
  const sourceLedgerPath = path.join(root, `${name}-source-ledger.json`)
  const run22FailureSummaryPath = path.join(root, `${name}-run22-failure-summary.json`)
  const sourcePlan = [
    { run: 19, kind: "task", task: "T2", arm: "disabled", maxProviderRequests: 12 },
    { run: 20, kind: "task", task: "T2", arm: "enabled", maxProviderRequests: 12 },
    { run: 21, kind: "task", task: "T3", arm: "disabled", maxProviderRequests: 12 },
    { run: 22, kind: "task", task: "T3", arm: "enabled", maxProviderRequests: 12 },
    { run: 23, kind: "task", task: "T4", arm: "disabled", maxProviderRequests: 12 },
    { run: 24, kind: "task", task: "T4", arm: "enabled", maxProviderRequests: 12 },
  ]
  const candidate = "a".repeat(40)
  const modelIdentitySha256 = "c6068fbb297e21966010177e6464efcda67792209001636ebbc3d9dcf85e19af"
  const modelConfigSha256 = "00b8fba22722ef212f8da42ed4b64ac493479dd5802dd56d5137606714c98662"
  const sourceLedgerRaw = `${JSON.stringify({
    schemaVersion: 5,
    contract: "s09-user-authorized-qwen-100req-t2-recovery-24",
    ceilingSessions: 24,
    historicalConsumedSessions: 18,
    authorizedNewProviderRequestLimit: 100,
    consumedNewProviderRequests: 25,
    remainingNewProviderRequests: 75,
    plannedProviderRequestMaximum: 72,
    retryBudget: 0,
    continuation: {
      sourceLedgerSha256: "d".repeat(64),
      run18FailureSummarySha256: "e".repeat(64),
      sourceSchemaVersion: 4,
      sourceContract: "s09-user-authorized-qwen-100req-acceptance-23",
      sourceCeilingSessions: 23,
      sourceHistoricalConsumedSessions: 13,
      sourceConsumedSessions: 18,
      sourceCandidateCommit: candidate,
      sourceModelIdentitySha256: modelIdentitySha256,
      sourceModelConfigSha256: modelConfigSha256,
      sourceContext: 81_920,
      sourceOutputReserve: 4_096,
      consumedRun: 18,
      consumedRunState: "fail",
      consumedRunFailureCode: "external-quality-or-side-effect-failed",
    },
    halted: { at: "2026-09-20T00:00:22.000Z", run: 22, reason: "external-quality-or-side-effect-failed" },
    runs: sourcePlan.map((entry, index) =>
      index < 3
        ? {
            ...entry,
            state: "pass",
            lease: `stub-run${entry.run}-lease`,
            reservedAt: "2026-09-20T00:00:00.000Z",
            startedAt: "2026-09-20T00:00:01.000Z",
            finishedAt: "2026-09-20T00:00:02.000Z",
            evidence: {
              candidateCommit: candidate,
              freezeManifestSha256: "f".repeat(64),
              modelIdentitySha256,
              modelConfigSha256,
              hostResolvedEvidenceSha256: String(index + 1).repeat(64),
              context: 81_920,
              outputReserve: 4_096,
              providerRequests: [7, 7, 8][index],
              resultSha256: "8".repeat(64),
            },
          }
        : index === 3
          ? {
              ...entry,
              state: "fail",
              lease: "stub-run22-lease",
              reservedAt: "2026-09-20T00:00:15.000Z",
              startedAt: "2026-09-20T00:00:16.000Z",
              finishedAt: "2026-09-20T00:00:18.000Z",
              failureCode: "external-quality-or-side-effect-failed",
            }
          : { ...entry, state: "planned" },
    ),
    updatedAt: "2026-09-20T00:00:04.000Z",
  })}\n`
  await writeFile(sourceLedgerPath, sourceLedgerRaw, { mode: 0o600 })
  await writeFile(
    run22FailureSummaryPath,
    `${JSON.stringify({
      schemaVersion: 1,
      candidate,
      run: 22,
      status: "FAIL",
      consumed: true,
      acceptedT3: false,
      originalLedgerFailureCode: "external-quality-or-side-effect-failed",
      derivedClassification: "t3-extra-shell-subcommand",
      upstream: { actualForwardedRequests: 8 },
      diagnosis: {
        constraintsPass: true,
        trajectoryPass: false,
        trajectoryFailures: ["turn-3-bash:restore-version-count-0", "turn-3-group-1-step-mismatch"],
        extraShellSubcommand: "grep",
        workspaceHashesIntact: true,
        sideEffects: 0,
      },
      preservedPasses: [19, 20, 21],
      remainingRuns: [23, 24],
      artifacts: { "continuation-ledger.json": sha256(sourceLedgerRaw) },
    })}\n`,
    { mode: 0o600 },
  )
  return { sourceLedgerPath, run22FailureSummaryPath }
}

async function productionRecentProtection(historyPath: string) {
  const messages = (await Bun.file(historyPath).json()) as SessionV1.WithParts[]
  const tokens: number[] = []
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    let parts: SessionV1.Part[] = []
    const flush = () => {
      if (parts.length === 0) return
      tokens.push(Token.estimate(JSON.stringify(parts)))
      parts = []
    }
    for (const part of message.parts) {
      if (part.type === "step-start" && parts.length > 0) flush()
      parts.push(part)
    }
    flush()
  }
  let protectedSteps = 0
  let protectedTokens = 0
  for (
    let index = tokens.length - 1;
    index >= 0 &&
    (protectedSteps < ContextFoldingPolicy.protectRecentSteps ||
      protectedTokens < ContextFoldingPolicy.protectRecentTokens);
    index--
  ) {
    protectedSteps++
    protectedTokens += tokens[index]!
  }
  return { protectedSteps, protectedTokens }
}

function provider(id: string, modelID: string, baseURL: string) {
  return {
    name: id,
    id,
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: {
      [modelID]: {
        id: modelID,
        name: modelID,
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: true,
        release_date: "2025-01-01",
        limit: { context: 81_920, output: 4_096 },
        cost: { input: 0, output: 0 },
        options: {},
      },
    },
    options: { apiKey: "local-stub-only", baseURL },
  }
}

function stubResponse(promptTokens: number) {
  const chunks = [
    {
      id: "chatcmpl-s09-live-stub",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: "S09-PREFLIGHT-OK" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-s09-live-stub",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 21,
        total_tokens: promptTokens + 21,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    },
  ]
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
}

test("classifies the first upstream non-2xx without treating blocked SDK retries as provider requests", () => {
  const failure = providerNon2xxFailure({
    responses: [{ status: 503, bytes: 45, sha256: "a".repeat(64), completion: "unavailable" }],
    guard: { maximum: 1, count: 1, closedReason: "provider-http-503" },
  })
  expect(failureArtifact(13, failure)).toEqual({
    schemaVersion: 1,
    run: 13,
    code: "provider-upstream-http-503",
    evidence: {
      schemaVersion: 1,
      pattern: "upstream-non-2xx-guard-closed",
      upstream: { status: 503, bytes: 45, sha256: "a".repeat(64), completion: "unavailable" },
      providerGuard: {
        maximum: 1,
        forwardedRequests: 1,
        closedReason: "provider-http-503",
        additionalForwardingBlocked: true,
      },
    },
  })
  expect(
    providerNon2xxFailure({
      responses: [{ status: 200, bytes: 1, sha256: "b".repeat(64), completion: "normal-stop" }],
      guard: { maximum: 1, count: 1, closedReason: "provider-request-cap" },
    }),
  ).toBeUndefined()
  expect(
    providerNon2xxFailure({
      responses: [{ status: 503, bytes: 45, sha256: "c".repeat(64), completion: "unavailable" }],
      guard: { maximum: 12, count: 2, closedReason: "provider-http-503" },
    }),
  ).toBeUndefined()
  expect(
    failureArtifact(
      15,
      providerNon2xxFailure({
        responses: [
          { status: 200, bytes: 100, sha256: "d".repeat(64), completion: "normal-stop" },
          { status: 503, bytes: 45, sha256: "e".repeat(64), completion: "unavailable" },
        ],
        guard: { maximum: 12, count: 2, closedReason: "provider-http-503" },
      }),
    ).code,
  ).toBe("provider-upstream-http-503")
})

test("requires T2 to report computed count and path without leaking fixture answers in the prompt", () => {
  const manifest = materializeBodiesV3("t2-repeated-search")
  const files = new Map(manifest)
  const check = (finalText: string) =>
    validateTaskAnswer("t2-repeated-search", { finalText, files, manifest }).every((item) => item.pass)

  expect(V3_TASKS["t2-repeated-search"].prompts[1]!.text).toContain(
    "NEEDLE-7 count=<integer>; NEEDLE-3 file=<relative-path>",
  )
  expect(V3_TASKS["t2-repeated-search"].prompts[1]!.text).not.toContain("NEEDLE-7 count=2")
  expect(check("NEEDLE-7 count=2; NEEDLE-3 file=src/m02.md")).toBe(true)
  expect(check("NEEDLE-7 count=3; NEEDLE-3 file=src/m02.md")).toBe(false)
  expect(check("NEEDLE-7 count=2; NEEDLE-3 file=src/m03.md")).toBe(false)
  expect(check("NEEDLE-7 count=2.5; NEEDLE-3 file=src/m02.md")).toBe(false)
  expect(check("NEEDLE-7 count=2; NEEDLE-3 file=src/m02.md.bak")).toBe(false)
  expect(check("NEEDLE-7 appears in src/m01.md and src/m04.md; NEEDLE-3 is in src/m02.md")).toBe(false)
})

test("requires the T3 restore group to contain exactly one shell command", () => {
  const restorePrompt = V3_TASKS["t3-aba"].prompts[2]!
  expect(restorePrompt.text).toContain(
    "exactly the single shell command cp backup/version.orig.txt app/version.txt, with no appended shell subcommand",
  )
  expect(restorePrompt.groups[0]).toEqual([{ kind: "bash", command: "cp backup/version.orig.txt app/version.txt" }])
})

test("runs enabled and disabled preflights through the real host using only loopback providers", async () => {
  const preserved = process.env.S09_STUB_OUTPUT
  const root = preserved ?? (await mkdtemp(path.join(os.tmpdir(), "s09-live-full-stub-")))
  await mkdir(root, { recursive: true, mode: 0o700 })
  const repo = path.resolve(import.meta.dir, "../../../..")
  const ledgerPath = path.join(root, "stub-ledger.json")
  const outputRoot = path.join(root, "runs")
  let upstreamCalls = 0
  // Synthetic positive control below the production 77,824-token automatic-compaction threshold.
  // It is not a Qwen measurement; the captured 146,551-token response remains the negative control below.
  let promptTokens = 70_000
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      await request.arrayBuffer()
      upstreamCalls++
      return new Response(stubResponse(promptTokens), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const realModel = { providerID: "s09-real-stub", modelID: "s09-real-stub-model" }
  const modelID = `${realModel.providerID}/${realModel.modelID}`
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
  const candidateSha = new TextDecoder().decode(head.stdout).trim()
  const taskSpecPath = path.join(import.meta.dir, "task-spec-v3.ts")
  const config: PrivateConfig = {
    schemaVersion: 1,
    candidateSha,
    freezeManifestSha256: "f".repeat(64),
    taskSpecSha256: sha256(new Uint8Array(await Bun.file(taskSpecPath).arrayBuffer())),
    host: {
      executable: process.execPath,
      argsPrefix: ["run", "--conditions=browser", path.join(repo, "packages/graphagent/src/index.ts")],
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: process.env.LANG ?? "C.UTF-8",
        HOME: "/s09-poison-home-must-be-replaced",
        XDG_CONFIG_HOME: "/s09-poison-xdg-must-be-replaced",
        OPENCODE_CONFIG_DIR: "/s09-poison-config-dir-must-be-removed",
        OPENCODE_CONFIG_CONTENT: "invalid-poison-config-must-be-replaced",
        OPENCODE_AUTH_CONTENT: '{"poison":true}',
        OPENCODE_DISABLE_PROJECT_CONFIG: "0",
      },
      apiHeaders: {},
      startupTimeoutMs: 30_000,
      graphagentConfigTemplate: {
        autoupdate: false,
        formatter: false,
        lsp: false,
        model: modelID,
        small_model: modelID,
        enabled_providers: [realModel.providerID],
        compaction: { auto: true, dynamic: true },
        provider: {
          [realModel.providerID]: provider(realModel.providerID, realModel.modelID, "__S09_PROVIDER_GUARD_BASE_URL__"),
        },
      },
    },
    realModel,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.port}`, headers: { authorization: "local-stub-only" } },
  }

  try {
    await initializePrivateRunLedger(ledgerPath, await continuationSources(root, "main"))
    await mkdir(outputRoot, { recursive: true, mode: 0o700 })
    const preflightPlans: readonly LiveRunPlan[] = [
      { run: 90, kind: "one-request-preflight", arm: "enabled", maxProviderRequests: 1 },
      { run: 91, kind: "one-request-preflight", arm: "disabled", maxProviderRequests: 1 },
    ]
    for (const plan of preflightPlans) {
      const executed = await executeLiveRun({
        config,
        ledgerPath,
        outputRoot,
        plan,
        beforeExternal: async () => {},
      })
      expect(executed.providerRequests).toBe(1)
      expect(executed.summary).toMatchObject({
        run: plan.run,
        arm: plan.arm,
        status: "PASS",
        providerRequests: 1,
      })
    }
    expect(await Bun.file(path.join(outputRoot, "run-90", "result.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(outputRoot, "run-91", "result.json")).exists()).toBe(true)
    const enabledResult = await Bun.file(path.join(outputRoot, "run-90", "result.json")).json()
    expect(enabledResult.usage.providerReported[0]).toMatchObject({ input: 70_000, output: 21, cacheRead: 0 })
    expect(enabledResult.result.outbound.foldedSources).toBe(1)
    const protection = await productionRecentProtection(
      path.join(outputRoot, "run-90", "rounds", "round-06-before-history.json"),
    )
    expect(protection.protectedSteps).toBe(4)
    expect(protection.protectedTokens).toBeGreaterThanOrEqual(16_000)

    const overflowLedgerPath = path.join(root, "overflow-stub-ledger.json")
    const overflowOutputRoot = path.join(root, "overflow-runs")
    await initializePrivateRunLedger(overflowLedgerPath, await continuationSources(root, "overflow"))
    await mkdir(overflowOutputRoot, { recursive: true, mode: 0o700 })
    promptTokens = 146_551
    const callsBeforeOverflow = upstreamCalls
    let overflowError: unknown
    try {
      await executeLiveRun({
        config,
        ledgerPath: overflowLedgerPath,
        outputRoot: overflowOutputRoot,
        plan: preflightPlans[0]!,
        beforeExternal: async () => {},
      })
    } catch (error) {
      overflowError = error
    }
    expect(overflowError).toBeDefined()
    expect(upstreamCalls - callsBeforeOverflow).toBe(1)
    expect(
      await Bun.file(path.join(overflowOutputRoot, "run-90", "captures", "external-request-01.json")).exists(),
    ).toBe(true)
    expect(
      await Bun.file(path.join(overflowOutputRoot, "run-90", "captures", "external-request-02.json")).exists(),
    ).toBe(false)
    const overflowLog = await Bun.file(path.join(overflowOutputRoot, "run-90", "host.stderr.log")).text()
    expect(overflowLog).toContain("agent=compaction")
    expect(overflowLog).toContain("AI_APICallError: Too Many Requests")
    const artifact = failureArtifact(90, overflowError)
    expect(artifact).toEqual({
      schemaVersion: 1,
      run: 90,
      code: "provider-usage-exceeded-usable-context-auto-compaction-blocked",
      evidence: {
        schemaVersion: 1,
        pattern: "upstream-normal-completion-provider-usage-over-usable-context-auto-compaction-blocked",
        upstream: {
          httpStatus: 200,
          completion: "normal-stop",
          usage: {
            input: 146_551,
            output: 21,
            reasoning: "unavailable",
            cacheRead: 0,
            cacheWrite: "unavailable",
          },
        },
        resolvedWindow: {
          context: 81_920,
          outputReserve: 4_096,
          usableContext: 77_824,
          inputOverageTokens: 68_727,
        },
        autoCompaction: {
          observed: true,
          source: "host-log-agent-compaction",
        },
        providerGuard: {
          maximum: 1,
          forwardedRequests: 1,
          closedReason: "provider-request-cap",
          blockedAdditionalRequest: true,
        },
      },
    })
    const taskPlan = LIVE_RUN_PLAN.find((plan) => plan.kind === "task")
    if (!taskPlan) throw new Error("fixed live plan has no task arm")
    expect(
      oneRequestPreflightOverflowEvidence({
        plan: taskPlan,
        context: 81_920,
        outputReserve: 4_096,
        response: { status: 200, bytes: 1, sha256: "f".repeat(64), completion: "normal-stop" },
        usage: {
          input: 146_551,
          output: 21,
          reasoning: "unavailable",
          cacheRead: 0,
          cacheWrite: "unavailable",
        },
        guard: { maximum: 12, count: 12, closedReason: "provider-request-cap" },
        automaticCompactionObserved: true,
      }),
    ).toBeUndefined()
    await writeFile(
      path.join(overflowOutputRoot, "run-90", "failure-classification.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
      { mode: 0o600 },
    )
  } finally {
    await upstream.stop(true)
    if (!preserved) await rm(root, { recursive: true, force: true })
  }
}, 180_000)
