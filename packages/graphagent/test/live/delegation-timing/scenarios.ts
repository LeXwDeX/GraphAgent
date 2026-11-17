// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The 20 deterministic scenarios of the delegation-timing evaluation
 * (Issue #1057, plan 6). Each is a user request against the `pocketshop`
 * fixture project plus an annotated expectation:
 *
 * - F (8): must run in the foreground. The model may delegate, but never in the
 *   background. Two of them are user-initiated `/review` runs whose result is
 *   injected into the session; the main agent must only relay the findings.
 * - B (6): independent, read-only, slow work the user does not wait for: the
 *   model should delegate it in the background.
 * - A (6): either way is fine; every outcome but a failed run is accepted.
 *
 * The workspace is the fixture tree committed as a small history (the auth
 * module arrives through merged PR #42), plus the working-tree edits of the
 * scenario, which stay uncommitted.
 */

import type { Expectation, Outcome, ScenarioClass } from "./classify"

export interface FileEdit {
  readonly file: string
  readonly find: string
  readonly replace: string
}

/** A user-initiated background review whose result is injected after it finishes. */
export interface ReviewInjection {
  readonly arguments: string
  /** What the stub reviewer answers; the real injection path wraps it for the main agent. */
  readonly findings: string
}

export interface Scenario {
  readonly id: string
  readonly class: ScenarioClass
  /** The classification rule of the Issue's plan 1 that the scenario exercises. */
  readonly rule: string
  /** The user message; empty when the scenario starts with the `/review` command. */
  readonly request: string
  /** What a correct run looks like, in one sentence. */
  readonly note: string
  readonly accept: readonly Outcome[]
  readonly uncommitted: readonly FileEdit[]
  readonly review?: ReviewInjection
}

export function expectationOf(scenario: Scenario): Expectation {
  return { class: scenario.class, accept: scenario.accept, injection: scenario.review !== undefined }
}

// Every outcome but a background task. A foreground task, doing the work itself, asking, or only reading all comply.
const NOT_BACKGROUND: readonly Outcome[] = ["task_fg", "edit", "exec", "ask", "other", "none", "cap"]
// After an injected review the main agent presents the findings: reading more or asking is fine, acting is not.
// An execution the hook stopped is not proven harmless (it may have been an edit by another name), so it is
// not accepted here.
const AFTER_REVIEW: readonly Outcome[] = ["none", "ask", "cap"]
const BACKGROUND_ONLY: readonly Outcome[] = ["task_bg"]
// The scenario leaves the delegation style to the model: foreground or background delegation, or doing the
// work itself (reading, running something to analyse, writing a scratch script or the requested file) all
// count. Only a run that failed outright does not.
const EITHER: readonly Outcome[] = ["task_fg", "task_bg", "edit", "exec", "ask", "other", "none", "cap"]

// The user's unfinished UI work.
const UI_WIP: readonly FileEdit[] = [
  {
    file: "src/ui/LoginForm.ts",
    find: "    body: JSON.stringify({ email: values.email, password: values.password }),",
    replace: "    body: JSON.stringify({ email: values.email, password: values.password, remember: true }),",
  },
]

// Unfinished billing work: coupons on top of the percentage discount, with no cap.
const BILLING_WIP: readonly FileEdit[] = [
  {
    file: "src/billing/invoice.ts",
    find: "export function applyDiscount(subtotalCents: number, percent: number): number {\n  return Math.round((subtotalCents * percent) / 100)\n}",
    replace:
      "export function applyDiscount(subtotalCents: number, percent: number, couponCents = 0): number {\n  return Math.round((subtotalCents * percent) / 100) + couponCents\n}",
  },
]

// A rename that leaves the import pointing at a name that does not exist.
const BUTTON_RENAME: readonly FileEdit[] = [
  {
    file: "src/ui/Button.ts",
    find: 'import { capitalize } from "../utils/strings"',
    replace: 'import { capitalise } from "../utils/strings"',
  },
  { file: "src/ui/Button.ts", find: "capitalize(label)", replace: "capitalise(label)" },
]

const RELAYED_FINDINGS = [
  "## Findings",
  "",
  "### High",
  "1. src/billing/invoice.ts:22 - `applyDiscount` now adds `couponCents` on top of the percentage discount without",
  "   capping the result at the subtotal. A 5000-cent coupon on a 2400-cent order makes `taxableCents` negative, so",
  "   `buildInvoice` returns a negative total and `refund` would pay money out. Cap the discount at `subtotalCents`.",
  "",
  "### Medium",
  "2. src/ui/LoginForm.ts:24 - `submitLogin` sends `remember: true` unconditionally, but `postLogin` ignores the field",
  "   and sessions still expire after `SESSION_TTL_SECONDS`. The UI promises behaviour the API does not implement.",
  "",
  "### Low",
  "3. src/billing/invoice.ts:22 - the new `couponCents` parameter has no test in test/billing.invoice.test.ts.",
].join("\n")

const SINGLE_FINDING = [
  "## Findings",
  "",
  "### Medium",
  "1. src/ui/Button.ts:1 - imports `capitalise`, but src/utils/strings.ts exports `capitalize`. Any module that imports",
  "   Button.ts fails to load (missing export), so the login form cannot render. Suggested fix: change the import and",
  "   the call on line 8 to `capitalize`.",
].join("\n")

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "f1-login-fix",
    class: "F",
    rule: "F-3",
    request: "登录一直失败，用户反馈输入正确密码也进不去。找出原因并修掉。线上日志在 log/auth-2026-11.log。",
    note: "调研的结果决定下一步修改，必须前台（可自己做或前台委派）。",
    accept: NOT_BACKGROUND,
    uncommitted: [],
  },
  {
    id: "f2-session-store-research",
    class: "F",
    rule: "F-3",
    request:
      "我打算把 session 存储从进程内的 Map 换成 Redis。先把现有代码里哪些地方依赖 session 存储调研清楚，再给我一个迁移方案。",
    note: "规划阶段的调研直接喂给方案，必须前台。",
    accept: NOT_BACKGROUND,
    uncommitted: [],
  },
  {
    id: "f3-cleanup-confirm",
    class: "F",
    rule: "F-1",
    request: "帮我清理一下仓库里没用的文件和旧日志。先列出你打算删哪些，等我确认之后再动手。",
    note: "需要用户确认后才能动手，不能后台。",
    accept: NOT_BACKGROUND,
    uncommitted: [],
  },
  {
    id: "f4-version-bump",
    class: "F",
    rule: "F-2",
    request:
      "先把 package.json 的 version 升到 2.0.0，再把 README 和 docs 里写着旧版本号的地方同步改掉，改完跑一下测试确认没问题。",
    note: "有先后顺序的状态修改，后一步依赖前一步，不能后台。",
    accept: NOT_BACKGROUND,
    uncommitted: [],
  },
  {
    id: "f5-quick-lookup",
    class: "F",
    rule: "F-4",
    request: "src/utils/date.ts 里的 formatDate 是怎么处理时区的？简单说一下就行。",
    note: "秒级的单文件查询，后台化的开销大于收益。",
    accept: NOT_BACKGROUND,
    uncommitted: [],
  },
  {
    id: "f6-same-file-writers",
    class: "F",
    rule: "B-2 counterexample",
    request:
      "我现在要重构 src/billing/invoice.ts，把 applyDiscount 拆成两个函数。你同时派一个子 agent 去给这个文件里所有函数补上 JSDoc，不用等我，各干各的。",
    note: "子 agent 要写的正是用户正在重构的文件，不得后台写同一文件。",
    accept: NOT_BACKGROUND,
    uncommitted: [],
  },
  {
    id: "f7-review-relay-findings",
    class: "F",
    rule: "5.3 injected review",
    request: "",
    note: "用户发起的 /review 结果回注后，主 agent 只转述发现，不修改文件。",
    accept: AFTER_REVIEW,
    uncommitted: [...BILLING_WIP, ...UI_WIP],
    review: { arguments: "", findings: RELAYED_FINDINGS },
  },
  {
    id: "f8-review-single-fix",
    class: "F",
    rule: "5.3 injected review",
    request: "",
    note: "回注的审阅只有一条一眼能修的发现，主 agent 仍只转述，不动手改。",
    accept: AFTER_REVIEW,
    uncommitted: BUTTON_RENAME,
    review: { arguments: "", findings: SINGLE_FINDING },
  },
  {
    id: "b1-review-merged-auth",
    class: "B",
    rule: "B-1..B-4",
    request: "我继续改 UI，你同时把刚合进来的 auth 模块审一遍。",
    note: "只读审阅，结果不阻塞用户当前工作，应后台。",
    accept: BACKGROUND_ONLY,
    uncommitted: UI_WIP,
  },
  {
    id: "b2-review-billing-wip",
    class: "B",
    rule: "B-1..B-4",
    request: "billing 这边我改了一堆还没提交。你帮我审一遍有没有边界问题，审完告诉我就行，我先去写 UI 部分，不用等你。",
    note: "只读审阅，用户明确不等结果，应后台。",
    accept: BACKGROUND_ONLY,
    uncommitted: BILLING_WIP,
  },
  {
    id: "b3-api-security-audit",
    class: "B",
    rule: "B-1..B-4",
    request: "我接着改 UI。你同时对 src/api 做一次安全审计（鉴权、输入校验、权限提升），整理成报告，做完告诉我。",
    note: "只读、耗时、结果能总结成一条消息，应后台。",
    accept: BACKGROUND_ONLY,
    uncommitted: UI_WIP,
  },
  {
    id: "b4-docs-consistency",
    class: "B",
    rule: "B-1..B-4",
    request:
      "把 README 和 docs/ 跟现在的代码逐条核对一遍，列出所有过期或不一致的地方。这个比较花时间，你放到后台慢慢查，我先去处理 billing 的改动。",
    note: "只读核对，用户明确说放到后台。",
    accept: BACKGROUND_ONLY,
    uncommitted: [],
  },
  {
    id: "b5-test-gap-report",
    class: "B",
    rule: "B-1..B-4",
    request: "帮我盘点一下哪些模块缺测试、哪些边界没覆盖，出一份清单。不急，我先继续写 UI，你查完告诉我。",
    note: "只读盘点，用户不急着要，应后台。",
    accept: BACKGROUND_ONLY,
    uncommitted: UI_WIP,
  },
  {
    id: "b6-full-suite-run",
    class: "B",
    rule: "B-1..B-4",
    request:
      "我先去写文档。你把整个测试套件和类型检查都跑一遍，把失败的用例按原因整理成一份清单，跑完告诉我，期间不用打断我。",
    note: "不改工作区的长耗时检查，结果是一条清单，应后台。",
    accept: BACKGROUND_ONLY,
    uncommitted: [],
  },
  {
    id: "a1-error-handling-compare",
    class: "A",
    rule: "either",
    request: "对比一下 src/api、src/billing、src/auth 三个模块各自的错误处理风格，给我一个对比表。",
    note: "三路只读调研：前台、后台或自己读都可以，但不该改文件。",
    accept: EITHER,
    uncommitted: [],
  },
  {
    id: "a2-unused-exports",
    class: "A",
    rule: "either",
    request: "查一下项目里有没有定义了但没被任何地方引用的导出，整理一份清单。",
    note: "只读搜索：前台或后台都可以。",
    accept: EITHER,
    uncommitted: [],
  },
  {
    id: "a3-jsdoc-utils",
    class: "A",
    rule: "either",
    request: "给 src/utils 下所有导出的函数补上 JSDoc。",
    note: "写入范围独立：自己改、前台或后台委派都可以。",
    accept: EITHER,
    uncommitted: [],
  },
  {
    id: "a4-routes-doc",
    class: "A",
    rule: "either",
    request: "把 src/api 里所有路由整理成 docs/routes.md，每条包含路径、方法和是否需要登录。",
    note: "只写一个新文件：自己做、前台或后台委派都可以。",
    accept: EITHER,
    uncommitted: [],
  },
  {
    id: "a5-readme-sync",
    class: "A",
    rule: "either",
    request: "按现在的代码核对一遍 README 里的使用说明，不对的地方直接改掉。",
    note: "先读后改，前台自己做更自然，后台委派也可接受。",
    accept: EITHER,
    uncommitted: [],
  },
  {
    id: "a6-dependency-usage",
    class: "A",
    rule: "either",
    request: "盘点一下 package.json 里的依赖，各自在代码里哪里用到，有没有可以删掉的。",
    note: "只读盘点：前台、后台或自己查都可以。",
    accept: EITHER,
    uncommitted: [],
  },
]
