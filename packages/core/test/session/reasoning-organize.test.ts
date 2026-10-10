import { describe, expect, test } from "bun:test"
import {
  NO_USEFUL_REASONING,
  NO_USEFUL_REASONING_TEXT,
  organizeReasoning,
  ReasoningDistillationPolicy,
  type OrganizeSlot,
} from "../../src/session/reasoning-distillation"
import { carriesConcreteContent } from "../../src/session/reasoning-distillation/organize"
import { Token } from "../../src/util/token"

const slot: OrganizeSlot = {
  messageID: "m1",
  partID: "p1",
  text: "重复推测：也许是 A，也许是 B。再看看，可能有消息。检查日志后确认原因，最终决定采用方案 A，并保留回滚步骤。",
}

/** Pure filler: no concrete content, so a noise verdict on it is trusted. */
const filler = {
  zh: "嗯……让我想想。再想一下。不，这样说不好，换个说法。算了，刚才只是口头填充。\n".repeat(3),
  en: "Hmm, let me think again. Actually, no, let me rephrase that; it is only filler.\n".repeat(3),
} as const

describe("single-part reasoning organizer", () => {
  test("the fixture is above the minimum organizer input size", () => {
    expect(Token.estimateReserve(slot.text)).toBeGreaterThanOrEqual(
      ReasoningDistillationPolicy.tokens.minimumInputTokens,
    )
  })

  test("requests Chinese prose by default with literal preservation, sending only the text", async () => {
    const text =
      "Run bun test at src/llm.ts; keep maxRetries=0 for v1.0.57 and https://example.com; 2 calls. Then re-check the failing case, compare it with the previous run and record the final decision."
    let prompt = ""
    const result = await organizeReasoning({
      slot: { ...slot, text },
      callModel: async (input) => {
        prompt = input.prompt
        return { text: "运行 bun test。", usageTokens: 12, finishReason: "stop" }
      },
    })
    expect(result.status).toBe("organized")
    expect(result.called).toBe(true)
    expect(result.usageTokens).toBe(12)
    expect(prompt).toContain("整理后的说明文字一律用中文")
    expect(prompt).toContain("文件路径、命令、符号、代码、URL、配置键、版本号和数值逐字保留")
    expect(prompt).toContain("有依据的排除不是被否定的猜测")
    expect(prompt).toContain("已排除的假设及其依据、已检查的位置及结果（包括“未发现”）、已确认的指代")
    expect(prompt).toContain(text)
    expect(prompt).not.toContain("m1")
    expect(prompt).not.toContain('"items"')
    expect(result.replacement).toEqual({ messageID: "m1", partID: "p1", before: text, after: "运行 bun test。" })
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(result.timing.modelMs)
  })

  test("the English option selects the English instruction", async () => {
    let prompt = ""
    await organizeReasoning({
      slot,
      language: "en",
      callModel: async (input) => {
        prompt = input.prompt
        return { text: "Decided A." }
      },
    })
    expect(prompt).toContain("Write all explanatory prose in English")
    expect(prompt).toContain("An exclusion backed by evidence is not a refuted guess")
    expect(prompt).toContain(
      'keep excluded hypotheses with their evidence, checked locations with their results (including "nothing found") and confirmed references',
    )
    expect(prompt).toContain(NO_USEFUL_REASONING)
    expect(prompt).not.toContain("一律用中文")
  })

  test("the explicit marker becomes a non-empty placeholder for pure filler; an empty body is invalid", async () => {
    for (const language of ["zh", "en"] as const) {
      const noise = await organizeReasoning({
        slot: { ...slot, text: filler[language] },
        language,
        callModel: async () => ({ text: ` ${NO_USEFUL_REASONING}\n` }),
      })
      expect(noise.status).toBe("organized")
      expect(noise.replacement?.after).toBe(NO_USEFUL_REASONING_TEXT[language])
      expect(noise.replacement?.after.length).toBeGreaterThan(0)
    }
    const empty = await organizeReasoning({ slot, callModel: async () => ({ text: " \n" }) })
    expect(empty).toMatchObject({ status: "skipped", reason: "invalid-output", called: true })
  })

  test("a noise verdict on informative reasoning is rejected and the original kept", async () => {
    // The facts span every signal class; GLM returned the marker for inputs like these (live, 2026-10-09).
    const facts = [
      "最终决定：测试任务的重试上限设为5次。",
      "已检查 packages/core/src/retry.ts，没有调用退避。",
      "参考 https://example.com/spec 的约定。",
      "这里的旧调度器指 `LegacyScheduler`。",
      "我原本倾向方案A，但它不支持离线协议，因此选择方案B。",
      "日志提示可能是网络超时，也可能是锁竞争；下一步只读检查超时日志，暂不修改配置。",
      "Keep maxRetries unchanged in the scheduler.",
      "The retry_limit flag stays as configured.",
      "Ruled out the network: the proxy log is clean. Next step is checking lock waits.",
    ]
    for (const fact of facts) {
      expect(carriesConcreteContent(fact)).toBe(true)
      const text = filler.zh.repeat(2) + fact + filler.zh
      const result = await organizeReasoning({
        slot: { ...slot, text },
        callModel: async () => ({ text: NO_USEFUL_REASONING, usageTokens: 7 }),
      })
      expect(result).toMatchObject({
        status: "skipped",
        reason: "rejected-noise-verdict",
        called: true,
        output: NO_USEFUL_REASONING,
        usageTokens: 7,
      })
      expect(result.replacement).toBeUndefined()
    }
    expect(carriesConcreteContent(filler.zh)).toBe(false)
    expect(carriesConcreteContent(filler.en)).toBe(false)
  })

  test("a marker mixed with other text is invalid output, not a verdict or a body", async () => {
    for (const text of [
      `${NO_USEFUL_REASONING}\n\n（注：原文中唯一具体事实为：测试任务的重试上限设为5次。）`,
      `方案 A。\n${NO_USEFUL_REASONING}`,
    ]) {
      const result = await organizeReasoning({ slot, callModel: async () => ({ text }) })
      expect(result).toMatchObject({ status: "skipped", reason: "invalid-output", called: true, output: text })
    }
  })

  test("truncated, oversized and failed calls retain the original", async () => {
    const truncated = await organizeReasoning({
      slot,
      callModel: async () => ({ text: "方案 A。", finishReason: "length" }),
    })
    expect(truncated).toMatchObject({ status: "skipped", reason: "truncated", output: "方案 A。" })
    const oversized = await organizeReasoning({
      slot,
      callModel: async () => ({ text: "x".repeat(ReasoningDistillationPolicy.tokens.maxOutputTokens * 4 + 1) }),
    })
    expect(oversized.reason).toBe("truncated")
    const failed = await organizeReasoning({
      slot,
      callModel: async () => {
        throw new Error("network")
      },
    })
    expect(failed).toMatchObject({ status: "skipped", reason: "model-failure", called: true })
    expect(failed.output).toBeUndefined()
    const missing = await organizeReasoning({ slot, callModel: async () => undefined })
    expect(missing).toMatchObject({ status: "skipped", reason: "model-failure", called: true })
  })

  test("parts below the minimum size or above the input limit skip without a model call", async () => {
    let calls = 0
    const callModel = async () => {
      calls++
      return { text: "短。" }
    }
    const small = await organizeReasoning({ slot: { ...slot, text: "短。" }, callModel })
    expect(small).toMatchObject({ status: "skipped", reason: "below-minimum", called: false })
    const large = await organizeReasoning({
      slot: { ...slot, text: "长".repeat(ReasoningDistillationPolicy.tokens.maxInputTokens + 1) },
      callModel,
    })
    expect(large).toMatchObject({ status: "skipped", reason: "work-limit", called: false })
    const blank = await organizeReasoning({ slot: { ...slot, text: "  " }, callModel })
    expect(blank.reason).toBe("empty-input")
    expect(calls).toBe(0)
  })

  test("a replacement that is unchanged or not smaller than its source is dropped", async () => {
    const unchanged = await organizeReasoning({ slot, callModel: async () => ({ text: slot.text }) })
    expect(unchanged.reason).toBe("unchanged")
    const longer = await organizeReasoning({ slot, callModel: async () => ({ text: `${slot.text}补充。` }) })
    expect(longer).toMatchObject({ status: "skipped", reason: "no-savings" })
    expect(longer.replacement).toBeUndefined()
  })
})
