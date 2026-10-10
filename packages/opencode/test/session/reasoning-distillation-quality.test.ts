import { expect, test } from "bun:test"
import { NO_USEFUL_REASONING_TEXT } from "@opencode-ai/core/session/reasoning-distillation"
import { checkFixtureSemantics } from "../../script/reasoning-distillation-quality"

const valid: Record<string, string[]> = {
  "one-conclusion": ["测试任务的重试上限设为 5 次。"],
  deduplicate: ["仅限测试环境，请求超时为30秒，不得写入生产数据库。"],
  "different-scopes": [
    "- alpha 服务：测试环境最多重试 2 次。\n- beta 服务：生产环境禁止重试，次数为 0。\n- gamma 任务：输出必须保存到 `/tmp/gamma.json`。\n- delta 流程：不能删除原始记录。\n- epsilon 服务：仅允许读取缓存。\n- zeta 请求：超时为 45 秒。",
  ],
  "meaningful-rejection": [
    "方案A因不支持当前必须使用的离线协议而被否决，最终选择方案B；该限制仍成立，后续不要重新选A。B尚未执行，不能视为已完成。",
  ],
  unresolved: [
    "日志提示可能是网络超时，也可能是锁竞争；目前没有证据排除其中任何一个，尚未确定原因。下一步只读检查超时日志，暂不修改配置。",
  ],
  "evidenced-exclusion": [
    "- 连接池上限为 20。\n- 连接池耗尽已排除：`/var/log/app.log` 显示连接池等待时间始终低于 5ms，活跃连接最高 12，未达到上限 20。\n- 根因仍未确定；下一步只读检查锁等待。",
  ],
  "negative-check": [
    "- 已检查 `packages/core/src/retry.ts` 和 `packages/core/src/backoff.ts`：两处都没有调用 `sleepWithJitter`。\n- “旧调度器”指 `LegacyScheduler`（`packages/core/src/legacy/scheduler.ts`）。\n- 下一步：只读检查 `packages/opencode/src/session/prompt.ts`。",
  ],
  "all-noise": [NO_USEFUL_REASONING_TEXT.zh],
  "short-reasoning": [
    "周一初始库存 83；周二入库 47，库存 130；周三出库 29，库存 101；周四退回 floor(29/3)=9，库存 110；周五出库 floor(110/4)=27，库存 83。最终库存：83。",
  ],
  "long-continuity": [
    "- 任务仅限测试环境；生产数据库只能只读访问。\n- 阶段A的备份与 schema 校验已完成，不要重复。\n- 迁移 M 已实际执行失败，原因是当前引擎不支持 online 选项；已回滚到迁移前状态，不得重试 M。\n- 下一步：只读核对日志和备份哈希；尚未授权再次迁移。\n- 请求超时 45 秒；测试任务最多重试 2 次。\n- 检查点保存到 `/tmp/recovery-checkpoint.json`。\n- 锁竞争是否根因仍未确认。",
  ],
  "multiple-slots": [
    "alpha测试环境最多重试2次，生产环境禁止执行。",
    "beta的备份已完成；恢复校验尚未完成，下一步只读核对 /tmp/beta.json。",
    "gamma曾因离线协议不兼容而执行失败，已回滚，不得再次采用同一方案。",
  ],
}

for (const [id, texts] of Object.entries(valid)) {
  test(`${id} valid semantic facts pass`, () => {
    expect(Object.entries(checkFixtureSemantics(id, texts)).filter(([, passed]) => !passed)).toEqual([])
  })
}

test("meaningful rejection accepts cause after decision", () => {
  const text =
    "已否决方案A：它不支持当前必须使用的离线协议，该限制仍成立，后续不要重新选A。最终选择方案B；B尚未执行，不能视为已完成。"
  expect(Object.entries(checkFixtureSemantics("meaningful-rejection", [text])).filter(([, passed]) => !passed)).toEqual(
    [],
  )
})

// Live DeepSeek outputs (2026-10-09) that keep every fact in a wording the checks must accept.
test("observed equivalent wordings pass", () => {
  const cases: [string, string][] = [
    [
      "short-reasoning",
      "周一初始：83。\n周二入库 47：130。\n周三出库 29：101。\n周四退回 `floor(29/3)=9`：110。\n周五出库 `floor(110/4)=27`：83。\n最终库存：83。",
    ],
    [
      "short-reasoning",
      "周一：83。\n周二入库 47：130。\n周三出库 29：101。\n周四返还 `floor(29/3)=9`：110。\n周五出库 `floor(110/4)=27`：83。\n最终库存：83。",
    ],
    [
      "short-reasoning",
      "从周一开始：83。周二入库 47：130。周三出库 29：101。周四退回 floor(29/3)=9：110。周五出库 floor(110/4)=27：83。最终库存：83。",
    ],
    [
      "evidenced-exclusion",
      "- 连接池上限为 20；曾误读为 50，已作废。\n- 连接池耗尽已排除：`/var/log/app.log` 显示连接池等待时间始终低于 5ms，活跃连接最高 12，未达到上限 20。\n- 根因仍未确定。\n- 下一步：只读检查锁等待。",
    ],
    [
      "evidenced-exclusion",
      "- 连接池上限：复查配置后确认上限是 20；此前读成 50 是看错，已作废。\n- 连接池耗尽：已排除。依据：`/var/log/app.log` 显示连接池等待时间始终低于 5ms，活跃连接最高 12，未达到上限 20。\n- 根因：仍未确定。\n- 下一步：只读检查锁等待。",
    ],
    [
      "long-continuity",
      "- 任务仅限测试环境，生产数据库只能只读访问。\n- 阶段A的备份与schema校验已经完成，不要重复。\n- 迁移M已经实际执行失败，原因是当前引擎不支持online选项；已回滚到迁移前状态，不得重试M。\n- 下一步只读核对日志和备份哈希，尚未授权再次迁移。\n- 请求超时45秒，测试任务最多重试2次。\n- 检查点保存到 /tmp/recovery-checkpoint.json。\n- 锁竞争是否根因仍未确认。",
    ],
  ]
  for (const [id, text] of cases)
    expect(Object.entries(checkFixtureSemantics(id, [text])).filter(([, passed]) => !passed)).toEqual([])
})

const mutations: { id: string; slot: number; from: string; to: string; fails: string }[] = [
  {
    id: "evidenced-exclusion",
    slot: 0,
    from: "连接池耗尽已排除",
    to: "连接池耗尽尚未排除",
    fails: "pool_exhaustion_excluded",
  },
  {
    id: "evidenced-exclusion",
    slot: 0,
    from: "：`/var/log/app.log` 显示连接池等待时间始终低于 5ms，活跃连接最高 12，未达到上限 20",
    to: "",
    fails: "exclusion_evidence",
  },
  {
    id: "evidenced-exclusion",
    slot: 0,
    from: "连接池上限为 20。",
    to: "连接池上限为 50。",
    fails: "obsolete_value_not_current",
  },
  { id: "evidenced-exclusion", slot: 0, from: "根因仍未确定", to: "根因是锁竞争", fails: "cause_open" },
  { id: "negative-check", slot: 0, from: "两处都没有调用", to: "两处都调用了", fails: "checked_files_no_call" },
  {
    id: "negative-check",
    slot: 0,
    from: "- 已检查 `packages/core/src/retry.ts` 和 `packages/core/src/backoff.ts`：两处都没有调用 `sleepWithJitter`。\n",
    to: "",
    fails: "checked_files_no_call",
  },
  {
    id: "negative-check",
    slot: 0,
    from: "- “旧调度器”指 `LegacyScheduler`（`packages/core/src/legacy/scheduler.ts`）。\n",
    to: "",
    fails: "reference_resolved",
  },
  { id: "one-conclusion", slot: 0, from: "5 次", to: "3 次", fails: "final_retry_limit" },
  { id: "deduplicate", slot: 0, from: "不得写入", to: "可以写入", fails: "production_write_forbidden" },
  {
    id: "different-scopes",
    slot: 0,
    from: "beta 服务：生产环境",
    to: "beta 服务：测试环境",
    fails: "beta_production_no_retry",
  },
  {
    id: "different-scopes",
    slot: 0,
    from: "不能删除原始记录",
    to: "可以删除原始记录",
    fails: "delta_preserve_original",
  },
  { id: "different-scopes", slot: 0, from: "仅允许读取缓存", to: "允许写入缓存", fails: "epsilon_read_only" },
  { id: "meaningful-rejection", slot: 0, from: "B尚未执行", to: "B已完成", fails: "b_not_executed" },
  { id: "unresolved", slot: 0, from: "尚未确定原因", to: "确定为锁竞争", fails: "cause_unresolved" },
  { id: "all-noise", slot: 0, from: NO_USEFUL_REASONING_TEXT.zh, to: "下一步继续检查。", fails: "empty" },
  { id: "short-reasoning", slot: 0, from: "floor(29/3)=9", to: "floor(29/3)=27", fails: "thursday_floor_9_to_110" },
  {
    id: "long-continuity",
    slot: 0,
    from: "尚未授权再次迁移",
    to: "已授权再次迁移",
    fails: "next_read_only_unapproved",
  },
  {
    id: "multiple-slots",
    slot: 1,
    from: "恢复校验尚未完成",
    to: "恢复校验已完成",
    fails: "beta_done_pending_read_only",
  },
  {
    id: "long-continuity",
    slot: 0,
    from: "尚未授权再次迁移。",
    to: "尚未授权再次迁移，但已授权再次迁移。",
    fails: "next_read_only_unapproved",
  },
  {
    id: "long-continuity",
    slot: 0,
    from: "锁竞争是否根因仍未确认。",
    to: "锁竞争根因仍未确认，但已确认锁竞争是根因。",
    fails: "lock_unresolved",
  },
  {
    id: "multiple-slots",
    slot: 0,
    from: "生产环境禁止执行。",
    to: "生产环境禁止执行，但生产环境可以执行。",
    fails: "alpha_test_retry_and_no_production",
  },
]

for (const mutation of mutations) {
  test(`${mutation.id} mutation fails ${mutation.fails}`, () => {
    const texts = [...valid[mutation.id]]
    expect(texts[mutation.slot].includes(mutation.from)).toBe(true)
    texts[mutation.slot] = texts[mutation.slot].replace(mutation.from, mutation.to)
    expect(checkFixtureSemantics(mutation.id, texts)[mutation.fails]).toBe(false)
  })
}
