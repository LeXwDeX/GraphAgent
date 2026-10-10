/** Explicit, opt-in synthetic acceptance. Never loads or edits user conversations. */
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText } from "ai"
import {
  NO_USEFUL_REASONING_TEXT,
  ReasoningDistillationPolicy,
  organizeReasoning,
  type OrganizeResult,
} from "@opencode-ai/core/session/reasoning-distillation"
import { replaceCanonicalReasoning } from "@opencode-ai/core/session/reasoning-distillation/canonical"
import { checkFixtureSemantics } from "./reasoning-distillation-quality"

if (!process.env.DISTILLATION_ACCEPTANCE_CONFIG || !process.env.DISTILLATION_ACCEPTANCE_OUTPUT) {
  throw new Error("Set DISTILLATION_ACCEPTANCE_CONFIG and DISTILLATION_ACCEPTANCE_OUTPUT to opt in to live model calls")
}
const config = await Bun.file(process.env.DISTILLATION_ACCEPTANCE_CONFIG).json()
const selected: string = config.small_model
if (typeof selected !== "string") throw new Error("An explicit configured small_model is required")
const separator = selected.indexOf("/")
const providerID = selected.slice(0, separator)
const modelID = selected.slice(separator + 1)
const configured = config.provider?.[providerID]
if (separator < 1 || configured?.npm !== "@ai-sdk/openai-compatible" || !configured.models?.[modelID]) {
  throw new Error("This acceptance harness requires a configured OpenAI-compatible small model")
}
const resolve = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Missing configured endpoint or credential reference")
  return value.replace(/\{env:([^}]+)\}/g, (_, key: string) => {
    const resolved = process.env[key]
    if (!resolved) throw new Error(`Missing environment reference: ${key}`)
    return resolved
  })
}
const baseURL = resolve(configured.options?.baseURL)
const apiKey = resolve(configured.options?.apiKey)
const effort = configured.models[modelID].variants?.none?.reasoningEffort === "none" ? "none" : "low"
const output = path.resolve(process.env.DISTILLATION_ACCEPTANCE_OUTPUT)
await mkdir(output, { recursive: true })
const noise = "嗯，再想一下。刚才那种说法不够好，重说一遍。只是措辞调整，没有新增事实，也没有采取任何行动。\n"
const fixtures = [
  {
    id: "one-conclusion",
    text:
      noise.repeat(12) +
      "我起初看成3次，核对后明确是5次；3次只是看错，不曾执行。最终决定：测试任务的重试上限设为5次。\n" +
      noise.repeat(8),
    required: ["5"],
    forbidden: ["3次", "看错", "重说一遍"],
  },
  {
    id: "deduplicate",
    text: noise.repeat(8) + "仅限测试环境，请求超时为30秒，不得写入生产数据库。\n".repeat(10) + noise.repeat(5),
    required: ["测试", "30", "生产"],
    forbidden: ["重说一遍"],
  },
  {
    id: "different-scopes",
    text:
      noise.repeat(10) +
      "约束：alpha服务在测试环境最多重试2次。\n约束：beta服务在生产环境禁止重试，次数为0。\n约束：gamma任务输出必须保存到 /tmp/gamma.json。\n约束：delta流程不能删除原始记录。\n约束：epsilon服务仅允许读取缓存。\n约束：zeta请求超时为45秒。\n" +
      noise.repeat(8),
    required: ["alpha", "2", "beta", "0", "/tmp/gamma.json", "delta", "epsilon", "zeta", "45"],
    forbidden: ["重说一遍"],
  },
  {
    id: "meaningful-rejection",
    text:
      noise.repeat(10) +
      "我原本倾向方案A，但A不支持当前必须使用的离线协议，因此否决A，最终选择方案B。这个限制仍成立，后续不要重新选A。B尚未执行，不能说已完成。\n" +
      noise.repeat(8),
    required: ["A", "B", "离线", "未"],
    forbidden: ["重说一遍"],
  },
  {
    id: "unresolved",
    text:
      noise.repeat(10) +
      "日志提示可能是网络超时，也可能是锁竞争。目前没有证据排除其中任何一个，尚未确定原因。下一步只读检查超时日志，暂不修改配置。\n" +
      noise.repeat(8),
    required: ["网络", "锁", "只读", "配置"],
    forbidden: ["重说一遍"],
  },
  {
    id: "evidenced-exclusion",
    text:
      noise.repeat(10) +
      "我先把连接池上限读成了50，复查配置后确认上限是20；50只是看错，作废。连接池耗尽已排除：/var/log/app.log 显示连接池等待时间始终低于5ms，活跃连接最高12，未达到上限20。根因仍未确定，下一步只读检查锁等待。\n" +
      noise.repeat(8),
    required: ["/var/log/app.log", "5ms", "12", "20"],
    forbidden: ["重说一遍"],
  },
  {
    id: "negative-check",
    text:
      noise.repeat(10) +
      "已检查 packages/core/src/retry.ts 和 packages/core/src/backoff.ts，两处都没有调用 sleepWithJitter。这里的“旧调度器”指 LegacyScheduler（packages/core/src/legacy/scheduler.ts）。下一步只读检查 packages/opencode/src/session/prompt.ts。\n" +
      noise.repeat(8),
    required: [
      "packages/core/src/retry.ts",
      "packages/core/src/backoff.ts",
      "sleepWithJitter",
      "LegacyScheduler",
      "packages/core/src/legacy/scheduler.ts",
      "packages/opencode/src/session/prompt.ts",
    ],
    forbidden: ["重说一遍"],
  },
  {
    id: "all-noise",
    text: "嗯……让我想想。再想一下。不，这样说不好，换个说法。算了，刚才只是口头填充。\n".repeat(24),
    required: [],
    forbidden: [],
    empty: true,
  },
]

const shortText =
  "Start Monday: 83. Tuesday in 47: 130. Wednesday out 29: 101. Thursday returns floor(29/3)=9: 110. Friday out floor(110/4)=27: 83. Final inventory: 83."
const continuityText =
  noise.repeat(40) +
  "任务仅限测试环境，生产数据库只能只读访问。阶段A的备份与schema校验已经完成，不要重复。迁移M已经实际执行失败，原因是当前引擎不支持online选项；已回滚到迁移前状态，不得重试M。下一步只读核对日志和备份哈希，尚未授权再次迁移。请求超时45秒，测试任务最多重试2次。检查点保存到 /tmp/recovery-checkpoint.json。锁竞争是否根因仍未确认。" +
  noise.repeat(30)
const cases = [
  ...fixtures.map((fixture) => ({
    ...fixture,
    texts: [fixture.text],
    benchmark: fixture.id === "one-conclusion",
    continuity: false,
  })),
  {
    id: "short-reasoning",
    texts: [shortText],
    required: ["83"],
    forbidden: [],
    benchmark: true,
    continuity: false,
  },
  {
    id: "long-continuity",
    texts: [continuityText],
    required: ["生产", "只读", "online", "回滚", "45", "2", "/tmp/recovery-checkpoint.json", "锁"],
    forbidden: ["重说一遍"],
    benchmark: true,
    continuity: true,
  },
  {
    id: "multiple-slots",
    texts: [
      noise.repeat(6) + "alpha测试环境最多重试2次，生产环境禁止执行。",
      noise.repeat(6) + "beta的备份已完成；恢复校验尚未完成，下一步只读核对 /tmp/beta.json。",
      noise.repeat(6) + "gamma曾因离线协议不兼容而执行失败，已回滚，不得再次采用同一方案。",
    ],
    required: ["alpha", "2", "生产", "beta", "/tmp/beta.json", "gamma", "回滚"],
    forbidden: ["重说一遍"],
    benchmark: true,
    continuity: false,
  },
]
const repeats = Number(process.env.DISTILLATION_ACCEPTANCE_REPEATS ?? 3)
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) throw new Error("Repeats must be 1..5")

type Stage = {
  role: string
  elapsedMs: number
  headersMs: number
  promptCharacters: number
  answerCharacters: number
  reasoningCharacters: number
  usage?: number
  finishReason: string
  wire: { model?: string; effort?: string; stream?: boolean; maxTokens?: number }
  requests: number
  answer: string
}
const reports: unknown[] = []
let failed = false
for (const fixture of cases.filter(
  (item) => !process.env.DISTILLATION_ACCEPTANCE_CASE || item.id === process.env.DISTILLATION_ACCEPTANCE_CASE,
)) {
  for (let repeat = 0; repeat < repeats; repeat++) {
    const stages: Stage[] = []
    const call = async (role: string, prompt: string) => {
      const started = performance.now()
      let headersMs = 0
      let requests = 0
      let wire: Stage["wire"] = {}
      const provider = createOpenAICompatible({
        name: providerID,
        baseURL,
        apiKey,
        includeUsage: true,
        fetch: Object.assign(
          async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            requests++
            const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
            wire = {
              model: body.model,
              effort: body.reasoning_effort,
              stream: body.stream ?? false,
              maxTokens: body.max_tokens,
            }
            const response = await fetch(url, init)
            headersMs = performance.now() - started
            return response
          },
          { preconnect: fetch.preconnect },
        ),
      })
      try {
        const result = await generateText({
          model: provider(configured.models[modelID].id ?? modelID),
          prompt,
          temperature: 0,
          maxOutputTokens: ReasoningDistillationPolicy.tokens.maxOutputTokens,
          maxRetries: 0,
          providerOptions: { openaiCompatible: { reasoningEffort: effort } },
          abortSignal: AbortSignal.timeout(30_000),
        })
        const stage: Stage = {
          role,
          elapsedMs: performance.now() - started,
          headersMs,
          promptCharacters: prompt.length,
          answerCharacters: result.text.length,
          reasoningCharacters: result.reasoningText?.length ?? 0,
          usage: result.totalUsage.totalTokens,
          finishReason: result.finishReason,
          wire,
          requests,
          answer: result.text,
        }
        stages.push(stage)
        console.log(JSON.stringify({ case: fixture.id, repeat, ...stage, answer: undefined }))
        return stage
      } catch (error) {
        console.log(
          JSON.stringify({
            case: fixture.id,
            repeat,
            role,
            elapsedMs: performance.now() - started,
            error: error instanceof Error ? error.name : "unknown",
          }),
        )
        throw new Error("Auxiliary model request failed")
      }
    }
    const direct = () =>
      call(
        "direct",
        "请对以下思考去重、删除无价值的自我纠错与口头填充，保留最终有效信息和有用条件，按实际内容自然组织；不固定条数，不扩写。" +
          (fixture.texts.length > 1 ? "各段独立整理，按输入顺序返回正文。" : "") +
          "\n\n" +
          fixture.texts.join("\n\n---\n\n"),
      )
    const slots = fixture.texts.map((text, index) => ({
      messageID: "synthetic-message",
      partID: `part-${index}`,
      text,
    }))
    // Production organizes each part with its own call, concurrently.
    let results: OrganizeResult[] | undefined
    let organizeWallMs = 0
    const organize = async () => {
      const started = performance.now()
      results = await Promise.all(
        slots.map((slot) =>
          organizeReasoning({
            slot,
            callModel: async ({ prompt }) => {
              const stage = await call("organize", prompt)
              return { text: stage.answer, usageTokens: stage.usage, finishReason: stage.finishReason }
            },
          }),
        ),
      )
      organizeWallMs = performance.now() - started
    }
    if (fixture.benchmark && repeat % 2 === 0) await direct()
    await organize()
    if (fixture.benchmark && repeat % 2 === 1) await direct()
    if (!results) throw new Error("Organizer result unavailable")
    const organized = results
    const rewriteStarted = performance.now()
    const after = slots.map((slot, index) => organized[index]?.replacement?.after ?? slot.text)
    const adoption = slots.every((slot, index) => {
      const replacement = organized[index]?.replacement
      return (
        replacement !== undefined &&
        replaceCanonicalReasoning({ text: slot.text, settled: true, distilled: false }, replacement.after)?.text ===
          after[index]
      )
    })
    const canonicalRewriteMs = performance.now() - rewriteStarted
    const combined = after.join("\n")
    const organizeStages = stages.filter((stage) => stage.role === "organize")
    const checks = {
      organized: organized.every((item) => item.status === "organized"),
      adoption,
      required: fixture.required.every((term) => combined.includes(term)),
      forbidden: fixture.forbidden.every((term) => !combined.includes(term)),
      empty: !("empty" in fixture) || after[0] === NO_USEFUL_REASONING_TEXT.zh,
      noClaimTemplate: !/(?:^|\n)\s*(?:[-*]\s*)?[cC]\d+\s*[:：]/.test(combined),
      oneRequestPerPart:
        organizeStages.length === slots.length && organizeStages.every((stage) => stage.requests === 1),
      effort: stages.every((stage) => stage.wire.effort === effort),
      independentSlots:
        fixture.id !== "multiple-slots" ||
        after.every(
          (text, index) =>
            text.includes(["alpha", "beta", "gamma"][index]) &&
            ["alpha", "beta", "gamma"].every((name, other) => other === index || !text.includes(name)),
        ),
      oldValueRemoved: fixture.id !== "one-conclusion" || !/(?:3|三)\s*次/.test(combined),
      ...checkFixtureSemantics(fixture.id, after),
    }
    // Offline quality acceptance only: these continuation calls are never part of production organization.
    let continuation: unknown
    if (fixture.continuity && repeat === repeats - 1) {
      const question =
        "以下是任务记录。仅根据记录列出下一步、禁止事项、已完成事项、未决问题以及检查点文件；不实际执行操作，不新增计划。\n\n"
      const original = await call("continuation-original", question + fixture.texts[0])
      const rewritten = await call("continuation-organized", question + after[0])
      const terms = ["只读", "online", "回滚", "/tmp/recovery-checkpoint.json", "锁"]
      continuation = {
        original: original.answer,
        organized: rewritten.answer,
        passed: terms.every((term) => rewritten.answer.includes(term)),
      }
      if (!(continuation as { passed: boolean }).passed) failed = true
    }
    const passed = Object.values(checks).every(Boolean)
    failed ||= !passed
    const report = {
      id: fixture.id,
      repeat,
      model: selected,
      mode: "per-part-organize",
      input: fixture.texts,
      passed,
      checks,
      after,
      status: organized.map((item) => item.status),
      reason: organized.map((item) => item.reason),
      timing: {
        organizeWallMs,
        modelMs: organized.map((item) => item.timing.modelMs),
        canonicalRewriteMs,
        helperAndCanonicalMs: organizeWallMs + canonicalRewriteMs,
      },
      stages,
      continuation,
    }
    reports.push(report)
    await Bun.write(path.join(output, `${fixture.id}-${repeat + 1}.json`), JSON.stringify(report, null, 2))
    console.log(
      JSON.stringify({
        case: fixture.id,
        repeat,
        passed,
        checks,
        timing: report.timing,
        after,
        reason: organized.map((item) => item.reason),
      }),
    )
  }
}
await Bun.write(path.join(output, "summary.json"), JSON.stringify({ passed: !failed, reports }, null, 2))
if (failed) process.exitCode = 1
