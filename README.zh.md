<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh.md"><b>简体中文</b></a>
</p>

# GraphAgent

> 面向长程、多步骤编码工作的 opencode fork：可持久化的子智能体 DAG 工作流、思考自动塑形、项目 Memory、自主目标和兼容 Claude Code 的 hooks，全部能在终端里查看和控制。

GraphAgent 是本项目对外的产品名；仓库以 **OpenCode-GraphAgent** 发布，是 MIT 许可的
[opencode](https://github.com/anomalyco/opencode) 终端 AI 智能体的 fork，在其之上加了 DAG 工作流引擎和下文列出的功能。**与 OpenCode 团队无任何隶属或背书关系。**

> [!IMPORTANT]
> **GraphAgent v1 现进入聚焦维护阶段。**维护范围限定为 DAG 配置、精选工作流模板，以及通过
> [GitHub Issues](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues) 提交的可复现缺陷。
> 影响稳定性、数据完整性或 DAG 核心体验的架构问题，将采用范围可控的兼容性补丁修复；v1
> 不再新增底层平台能力，也不再进行大规模架构重构。下一代项目将独立启动，在不继续扩大 v1
> 兼容性约束的前提下重新设计运行时。

---

## GraphAgent 自研功能

以下功能都是本 fork 在 opencode 之上自行开发的，各自可选或自成体系；opencode 的其余部分（多 Provider、LSP、客户端/服务器、TUI/桌面/Web 客户端）与上游一致。

| 功能 | 作用 | 怎么用 |
| --- | --- | --- |
| [思考自动塑形](#思考自动塑形) | 思考内容在再次发给模型之前，先由小模型整理去噪（默认开启） | `reasoningDistillation.enabled` + `small_model` |
| [DAG 工作流](#dag-工作流) | 把任务拆成可持久化的子智能体依赖图并跑完 | `/dag-auto`、`workflow` 工具、`.opencode/dag.jsonc` |
| [项目 Memory](#项目-memory) | 按项目保存经用户确认的偏好、决策和术语 | `/memory on` |
| [自主目标（GOAL）](#自主目标循环goal) | 跨回合推进一个持久、有预算、外部评审的目标 | `/goal`、`/subgoal` |
| [Hooks](#hooks) | 兼容 Claude Code 的生命周期 hooks | `hooks.json`、`/create-hook`、`/import-claude-hooks` |
| [上下文管理](#上下文管理) | 折叠重复工具输出、限制工具调用、压缩长会话 | `compaction`、`maxToolCalls` |

---

## 思考自动塑形

思考型模型会在后续步骤里把之前的思考内容回传给服务商。长思考里充斥着复述需求、被推翻的猜测和纠错过程，后续每次请求都要为它重复付费。

思考自动塑形默认开启。每段思考**一结束**就交给小模型整理：优先用配置的 `small_model`，否则用当前服务商自带的小模型；两者都没有时不改写。整理时保留最终的事实、数值、计算结果、约束、真实执行结果和待办，以及思考中积累的工作状态：已排除的假设及其依据、已检查的位置及结果（包括“未发现”）、已确认的指代；删掉重复、已被否定的猜测和空话；路径、命令、代码、URL、配置键和数值逐字保留。整理和本步的工具执行并行进行，下一次请求就带上整理后的内容。

- **要么在第一次回传前替换，要么永不替换。** 每次向模型发请求前，会话最多等待一个很短的窗口（`OPENCODE_REASONING_DISTILLATION_SETTLE_MS`，默认 3000 ms）；没整理完的部分被封存，永久保留原文，因此不会让之前请求已经写入的提示缓存前缀失效。
- **只改安全的载体。** 只改写普通思考和明文镜像；带签名、加密或服务端引用的思考（Anthropic thinking 签名、OpenAI 加密推理、Gemini thought 签名）一律不动。
- **可还原。** 原文和原始 metadata 随思考一起保存；关闭功能后回放的就是原文。
- **走引擎层。** 整理请求通过内置的 `@opencode-ai/llm` 引擎发送：不带工具、不自动重试、推理档位用 `none`/`low`；只有整理结果确实更省 token 才会采用。

```jsonc
// opencode.json
{
  "small_model": "provider/small-model", // 建议选有 `none` 推理档位的模型
  "reasoningDistillation": {
    "enabled": true, // 默认值；设为 false 关闭
    "language": "zh", // 整理后说明文字的语言："zh"（默认）或 "en"
  },
}
```

`OPENCODE_DISABLE_REASONING_DISTILLATION=1` 可以无视配置直接关闭；`OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS` 限制单次整理调用的时长。日志会记录每一次整理（`reasoning distillation`）和每一次封存（`reasoning rewrite sealed`）。

---

## 项目 Memory

项目 Memory 为一个项目保存持久的、**经用户确认的**上下文：偏好、决策和术语。

- 用 `/memory on` / `/memory off` 开关。项目需要先有真实身份（执行 `/init`）；未初始化的项目里 Memory 不生效。
- 一个项目只有一份 Memory，所有 worktree 共享，不会按 worktree 分叉；仓库第一次加上远端时 Memory 会随项目一起迁移。
- 主会话把相关 Memory 注入上下文；`memory_search` 按需检索主题。
- 持久化、上限和迁移由控制器负责，模型只能提出有界的修改。Memory 不是代码索引，也不是指令来源：当前用户输入和更高优先级的指令永远优先。
- 策略配置在 `.opencode/memory.jsonc`。

---

## 自主目标循环（`/goal`）

目标循环在当前会话里推进一个目标；下文的图编排是它的多会话对应形态：一个持久目标，智能体在当前会话里跨回合自主推进。

- **命令**：`/goal <文本>` 设定目标并启动循环；`/goal status|pause|resume|done|clear|stop` 控制；`/subgoal <文本>|list|remove <n>|clear` 管理挂在当前目标下的子目标。
- **轮次预算**：`/goal --max-turns 30 <文本>` 指定正整数总轮数（默认 20）。`/goal resume --max-turns 50` 恢复并调整总轮数，保留已用轮数，新总数必须大于已用轮数。不带参数的 `/goal resume` 保留预算，耗尽后仍可再执行一轮。
- **评审循环**：每回合结束后由外部评审判定进展——`done` 清除目标，`continue` 注入下一轮续跑提示，受可配置的回合预算约束（预算耗尽转暂停，可随时恢复）。智能体也可以用 `goal(action: "complete")` 工具自我宣告完成（绕过评审）；`goal(action: "status")` 查询状态。
- **可见性**：目标激活或暂停期间，系统提示里带实时目标块（目标文本、状态、已用/总回合、子目标、最近一次评审判定）；TUI 侧边栏有简洁的目标组件；`GET /session/:sessionID/goal` 暴露状态（未设目标时返回 `404`）。
- **持久化**：目标状态按会话持久化（`goal_state`），重启不丢，会话删除时自动清除。只有主会话能创建或恢复目标。

---

## Hooks

兼容 Claude Code hooks 协议的生命周期 hooks：26 个事件（`PreToolUse`、`PostToolUse`、`SessionStart`、`PermissionRequest`、`WorktreeCreate` 等）× 5 种执行类型（`command`、`mcp`、`http`、`prompt`、`agent`）。

- `hooks.json` 从全局 opencode 配置目录和项目/worktree 的 `.opencode` 目录读取，按追加方式合并并热加载；也可以经 HTTP 按会话注册，支持可选的工作区信任门控。
- command hook 可以声明 `inputFormat: "claude-code"`，以 Claude Code 的工具名和参数键接收输入。这提供的是命名兼容，不是完整的行为等价。
- Claude 的 `.claude/settings*.json` 不会自动加载：用 `/import-claude-hooks` 迁移，用 `/create-hook` 引导编写新 hook。
- 参考：[hooks 指南](./packages/core/src/plugin/skill/configure-hooks.md)。

---

## 上下文管理

- **上下文折叠**：在发出的请求里折叠重复的工具输出，存储的历史保持原样（`compaction.dynamic`、`compaction.prune`；`OPENCODE_DISABLE_PRUNE=1` 关闭裁剪）。
- **有界的工具使用**：工具输出有大小上限，`maxToolCalls` 限制每次用户输入的工具调用次数。
- **压缩**：长会话自动摘要（`compaction.auto`、`compaction.keep.tokens`、`compaction.buffer`、`compaction.max_context_tokens`）。

具体哪些生效取决于配置、服务商支持和请求用途。

---

## DAG 工作流

一个工作流就是一组节点加依赖边。每个节点是一个真实的子会话，有自己的智能体和上下文窗口；一条边意味着下游节点要消费上游节点的产出。节点按依赖顺序逐波执行：能并行的并行跑，有依赖的等着。

父智能体（你的主对话）拥有这张图。它为任务设计图、启动图，然后在节点汇报或工作流收尾时被唤醒——全程不轮询。某个波次失败了，父智能体重写出错的那一段，引擎接着跑；你看到的永远是当前的图，不是改写历史（见[修订视图](#修订视图)）。

三个值得知道的词：

- **节点（node）**——一个工作单元：`explore`、`build`、`general` 或自定义智能体跑一个 prompt，可以带超时、重试预算和结构化输出契约。
- **波次（wave）**——依赖全部就绪的那批节点；一次波次内并行执行，受并发上限约束。
- **门禁（gate）**——职责是做判断的节点（审查、验证、仲裁）。门禁输出裁定（`ACCEPT` / `REVISE` / `REJECT` / `BLOCKED`），下游节点可以基于裁定条件执行。

### DAG 特性

**编排**

- 可组合块（`explore`、`plan`、`prototype`、`debug`、`coding`、`verify`、`review`、`synthesize`）编译成节点图；块表达不了的还有低级节点字段兜底。
- `workflow(action="draft")` 通过工具参数传结构化图，harness 渲染并校验出 YAML spec——字段写错在 provider 侧就被拒，不用等到校验才发现。
- 三级作用域的工作流库（项目 / 全局 / 内嵌），按名字启动；`/dag-auto` 命令把需求路由到合适的参考拓扑并注入当前任务。
- `dag.jsonc` 的模型分层把决策和跑量分开：关键节点用 `advanced` 模型，扇出跑量用 `standard`。

**可靠性**

- 事件溯源状态加声明式状态机；SQLite 读模型在发布事务内投影。崩溃恢复只认持久化证据，不会凭空重放模型调用。
- 执行位置所有权：每条工作流行带着创建会话的目录戳，每次所有权检查都重读数据库，同一项目的兄弟 worktree 之间不能替对方收养、唤醒、派生。会话迁移时戳跟着走。
- 修订视图：replan 替换掉的段落自动退场——检查器、状态输出、摘要计数都只渲染当前图。当前图上活着的失败（配额耗尽、API 报错、超时上限）照常显示；被替换的失败不再计入工作流终态。
- 节点输出是一个绝对文件路径时，捕获为 `{content_ref, size, sha256, summary}`；result 动作返回指针，父智能体自己去读文件。内联文本和结构化输出不受影响。

**可观测与控制**

- TUI DAG 检查器（命令面板 → `dag.open`）：工作流列表、按波次排序的节点实时视图、带截止倒计时的节点详情；`p`/`r`/`s`/`x` 对应暂停/恢复/单步/取消，`enter` 进入节点的子会话。
- 侧边栏面板按会话展示进度；HTTP API 覆盖全部工具动作（见[下文](#观察与控制)）。
- deep 模式准入：昂贵的图启动前先过一轮有界问答（1/3/5 轮），产出带指纹的 Requirement Brief，裁定只有 `READY` / `NOT_READY` / `WAIVED` 三种。

**消息**

- 主智能体可以观察自己工作流里的节点，并和某个节点的当前尝试互发消息。发送是非阻塞的；消息只提供上下文，不授予权限，也不改变工作流生命周期。

## 工作流怎么用

不配置也能直接试：给它一件有阶段、有可并行部分、或者中间需要一道审查门禁的活（`/dag-auto <任务>`），智能体自己会建图并跑起来。想把它变成你自己的一套固定流程，有三件事：

### 1. 选定模型分层 —— `.opencode/dag.jsonc`

节点从不指定自己的模型。图只声明*哪些节点是关键的*，由配置决定*用什么跑*：

```jsonc
{
  // 关键节点：required: true，以及审查/仲裁类 worker。
  "model": {
    "advanced": "anthropic/claude-sonnet-4-5",
    "standard": "anthropic/claude-haiku-4-5"
  },
  // DAG 子会话的推理深度变体，仅当模型定义了同名变体时生效。
  "thinking_depth": "medium"
}
```

项目的 `.opencode/dag.jsonc` 优先于 opencode 配置目录下的全局文件；首次使用时会在全局目录生成一份带注释的默认文件。只配一层时，它就是统一默认值。每个节点的解析顺序是：分层 → worker agent 模型 → 父会话模型；三者都给不出模型时，工作流不会被创建，而是回来问你去配一个。

### 2. 把要复用的工作流存起来 —— `.opencode/workflows/`

工作流 spec 就是一个描述图的 YAML 文件。把它放进工作流目录，它就有了**名字**：

| 作用域 | 路径 | 可用范围 |
|---|---|---|
| 项目级 | `.opencode/workflows/<name>.yaml` | 本仓库，随仓库提交 —— 团队拿到的是同一套流程 |
| 全局级 | `<opencode 配置目录>/workflows/<name>.yaml` | 本机所有项目 |
| 内嵌级 | 编译进正式版二进制 | 每个正式版安装——兜底解析层 |

解析按此顺序取第一个命中的名字：项目级遮蔽同名的全局级，二者都遮蔽内嵌级。全局作用域由 [`opencode-dag-config`](https://github.com/LeXwDeX/opencode-dag-config) 仓库维护（直接 `git clone`/`git pull` 到配置目录即可同步）。一个最小的 spec：

```yaml
title: Dependency audit
config:
  name: dependency-audit
  nodes:
    - id: inventory
      name: inventory
      worker_type: explore
      depends_on: []
      required: true
      prompt_template:
        id: config-explore
        input:
          target: "package.json files and lockfiles"

    - id: report
      name: report
      worker_type: general
      depends_on: [inventory]
      report_to_parent: true
      prompt_template:
        inline: "Flag outdated or duplicated dependencies in {{inventory}} and propose an upgrade order."
```

之后直接说「跑 dependency-audit 工作流」就行 —— 智能体按名字启动，不需要路径。临时 spec 的用法完全不变：看起来像路径的 `spec_path`（含路径分隔符，或带 `.yaml`/`.yml` 扩展名）仍按会话目录相对解析，不走工作流库。

### 3. 让智能体替你写

内置的 **`create-dag-workflow`** skill 覆盖 spec 编写：工作流库作用域、文件结构、存盘 spec 必须守的规矩（不能钉死模型、`worker_type` 必须存在、模板必需变量必须给全），以及怎么验证。说一句「把这个存成可复用的工作流」，智能体会先跟你确认阶段和门禁，把文件写进你选的作用域，再真跑一次证明它能用。临时图则用 `workflow(action="draft")`：结构化图走工具参数，返回校验过的 `spec_path`，字段漂移到不了文件。

通过 `prompt_template.id` 引用的节点 prompt 先从项目的 `.opencode/dag-prompts/<id>.md` 解析，再找全局 `<config dir>/dag-prompts/`。往那儿加一个 `.md` 就多一个模板；全局工作流建议用 `inline` prompt，否则会依赖某个仓库本地的模板。

## 引擎

引擎位于 [`packages/core/src/dag`](./packages/core/src/dag)（状态机、依赖图、调度、事件投影、SQLite 读模型）和 [`packages/opencode/src/dag`](./packages/opencode/src/dag)（工作流服务、执行循环、节点生成、准入、审查生命周期、崩溃恢复、模板）。智能体通过单个 `workflow` 工具驱动它；人通过 TUI 或 HTTP API 观察和控制它。

### 图定义

每个节点可声明：

| 字段 | 用途 |
|---|---|
| `depends_on` | 依赖边；创建时做环检测和悬空引用校验 |
| `worker_type` | 执行节点的智能体（`explore`、`build`、`general` 或任意已配置 agent） |
| `prompt_template` | 通过 `id` 引用模板（先项目、后全局的 `dag-prompts/`）或 `inline` 内联，支持 `{{var}}` 插值 |
| `input_mapping` | 把上游节点输出映射为模板变量（`"count": "node-b.output.count"`） |
| `condition` | 基于上游输出的表达式；为假则跳过节点，纯依赖它的下游级联跳过 |
| `output_schema` | JSON Schema；子智能体必须调用 `submit_result` 提交匹配的结构化结果 |
| `required` | 必需节点失败会使整个工作流失败 |
| `report_to_parent` | 节点到达终态时唤醒父智能体 |
| `review` | `design` 或 `diff` 审查阶段，带实现指纹契约（见下） |

工作流级参数：`max_concurrency`（默认 5）、`max_node_replan_attempts`（5）、`max_total_nodes`（100）、节点级 `timeout_ms`（默认 10 分钟，排队等待计入预算）。

### 调度与执行

- 节点通过与 `task` 工具相同的代码路径生成真实子会话，按依赖顺序逐波执行，由并发信号量约束。节点在准入时持久化为 `queued`，子会话拿到并发许可后才创建，所以 100 个节点的扇出不会一次拉起 100 个会话。
- 动态重规划，暂停优先：`pause` 立即冻结调度，`replan` 将片段（添加 / 替换 / 取消 / 重启节点）原子性合并进运行中的图，`resume` 继续。终态节点不可变，想重试失败的节点，就换个新 id 加一个替代节点。`extend` 追加节点，也允许重新打开一个自然完成的工作流（终态不可逆的唯一例外，写进了规范）。
- 单步模式逐节点执行，便于调试。
- 父智能体不轮询。`report_to_parent` 节点或工作流到达终态时，引擎用合成消息唤醒父智能体。检查点节点输出规范化裁定（`ACCEPT` / `REVISE` / `REJECT` / `BLOCKED`），下一步走向由处置契约约束。迭代是一轮轮有界的、由裁定触发的重规划，图里不存在环形边。

### 修订视图

改图不会抹掉历史，但会让历史退场。replan 替换节点时会把它们标记为已替代；工作流行带一个 `graph_rev` 计数器，所有视图——状态输出、HTTP API、TUI 检查器、摘要计数——都只过滤当前修订。已完成节点和它们的产出原样存活进新修订。被替代节点的审计仍然可达（智能体按节点 id 从 result store 查），TUI 不提供入口。

这修好了两件事。出过错但已改写的段落，替换者成功后工作流报 `completed`，不再拖着旧失败。你看到的失败计数就是实际存在的失败——当前图上的配额耗尽或 API 报错会一直显示，直到它真的被修掉。

### 状态机与持久化

- 工作流和节点状态各有声明式转换表；所有变更先过守卫，非法转换和终态违规是类型化错误（HTTP 返回 409 而非 500）。
- 所有变更以持久化 `dag.*` 事件发布；投影器在发布事务*内部*写入 SQLite 读模型。历史来自事件回放，没有日志表。另有一个漂移测试盯着投影器守卫和声明的转换表，改了一边没改另一边，测试会挂。
- 崩溃恢复是惰性的、按工作流、基于证据：残留 `running` 的节点对照其子会话的持久化状态和解。子会话已经跑完的，回填捕获输出；执行权确实丢了的，工作流转入暂停，交给父智能体决定处置（replan / resume / cancel）。恢复过程不会自行接管或重启模型调用。
- 失败分诊：每个失败节点都带失败分类（`timeout` / `exec_failed` / `verdict_fail`），暴露在 `workflow(action=status)` 和父智能体收到的唤醒里——工作流终态失败时还带失败节点归因摘要——父智能体据此定向修复具体节点（replan 换新 id 的替代节点，或复用已完成输出开续跑工作流），而不是整图重启。

### 节点输出

节点的最终回复可以是纯文本、结构化结果（`output_schema` + `submit_result`），或者一个文件。回复是一个存在的非空文件的绝对路径时，运行时捕获 `{content_ref, size, sha256, summary}`；`workflow(action="result")` 返回指针和短摘要，父智能体自己去读文件。长报告不再挤进转录，完整性由捕获时记录的哈希保证。写到 `.opencode/workflow-reports/` 下的报告文件，首次写入时自动补一条追加式的 `.gitignore` 条目。

### deep 模式：准入与审查

- 准入问答覆盖六个维度（目标、范围、约束与假设、验收标准、证据、风险），策略有界：`LIGHT`（1 轮）、`STANDARD`（3 轮）、`GRILL`（5 轮，对抗式）。产出的 Requirement Brief 计算指纹（规范化形式的 SHA-256）；实质性变更使指纹失效并回到问答。消费后的准入记录随工作流持久化，恢复时不重放问答。
- 审查节点必须如实声明阶段：`design` 审查实现前的产物；`diff` 审查实际实现，要求声明实现节点、通过验证的验证节点，并回显实现指纹。实现一变指纹就变，旧的 `ACCEPT` 过不了门禁。

### 观察与控制

- TUI DAG 检查器（命令面板 → `dag.open`）：工作流列表、按波次排序的节点视图（实时状态）、节点详情（依赖、错误、输出预览、截止倒计时），`p`/`r`/`s`/`x` 对应暂停/恢复/单步/取消，`enter` 进入节点的子会话。
- 侧边栏面板：按会话展示工作流进度（完成/运行/失败/排队），可展开节点列表，由瞬态摘要事件驱动，打开时再拉一次兜底，不做轮询。
- HTTP API（与工具入口共用同一代码路径）：

  ```
  GET  /dag                              列出工作流
  POST /dag                              创建工作流
  GET  /dag/session/:sessionID           按会话列出工作流
  GET  /dag/session/:sessionID/summary   进度摘要
  GET  /dag/:dagID                       工作流详情
  GET  /dag/:dagID/nodes                 节点列表
  GET  /dag/:dagID/nodes/:nodeID         节点详情
  POST /dag/:dagID/control               pause/resume/cancel/replan/extend/step/complete
  ```

### 项目配置文件

DAG 相关的东西都放在 `.opencode/` 下，在 opencode 配置目录（`OPENCODE_CONFIG_DIR`，否则 `~/.config/opencode`）里有对应的全局版本。其余全部继承 opencode 主配置。

| 路径 | 用途 | 全局对应 |
|---|---|---|
| `.opencode/dag.jsonc` | 模型分层（`advanced` / `standard`）与子会话 `thinking_depth` | `<配置目录>/dag.jsonc`，首次使用时生成带注释的默认文件 |
| `.opencode/workflows/*.yaml` | 存盘的工作流 spec，可按名字启动 | `<配置目录>/workflows/*.yaml` |
| `.opencode/dag-prompts/*.md` | 由 `prompt_template.id` 引用的节点 prompt 模板（项目优先） | `<配置目录>/dag-prompts/*.md` |
| `.opencode/workflow-reports/` | 节点报告文件（自动 gitignore） | —— |

`dag.jsonc` 和工作流库都是惰性读取，改完下一次启动工作流就生效，不用重启。

## 背景

在 GraphAgent 里，graph 是一份可执行、可持久化、可观测、可控制的契约。公开 Git 历史显示，第一版完整 DAG 引擎在 **2026-07-02** 已经提交；论文 [*What makes prompts a graph*](https://arxiv.org/abs/2607.27578) 到 **2026-07-30** 才把显式结构、prompt/拓扑分离、可执行语义和 graph 一等制品化归纳出来。术语晚了四周，工具没有等它。

落到五条运行规则：

1. **每条边都要有用。** 如果下游不读上游产物，这条依赖就该删。真正独立的工作直接并行。
2. **模板是参考拓扑，不是固定脚本。** 主 Agent 可以按任务扩展或剪枝，但每次剪枝都必须写明理由和替代覆盖证据。
3. **推演、复审、裁决分开做。** `reasoner` 模拟潜在执行路径，fresh-context reviewer 复审前一个局部波次，最后由唯一 arbiter 给出裁决；这些门禁不可剪掉。
4. **迭代是有界的局部改图。** `PASS` 才能定稿，`LOOP` 通过 pause → replan → resume 增加新的修正与复审波次，`BLOCKED` 带证据停止；终态节点不会被伪装成环。
5. **代码和测试说了算。** 状态变更写入事件，崩溃恢复只认持久化证据。到了代价高的边界，人可以 pause、step、cancel 或 replan。

至于为什么是 DAG：任务一旦涉及分阶段依赖、可并行的独立工作，或者中间需要一道质量门禁，单智能体循环就不太够用了。决策和跑量分开（advanced/standard 分层）、建图前先问清楚（deep 准入）、门禁结论必须有下文（处置契约）、恢复靠证据不靠猜——这四个判断就是这个引擎的地基。

强约束参考拓扑——设计决策深挖、并行项目落地、已完成子系统深度 Review、轻量变更审查——随工作流库分发：全局作用域由 [`opencode-dag-config`](https://github.com/LeXwDeX/opencode-dag-config) 仓库维护，正式版的二进制里还有内嵌的 builtin 层。目录见[工作流库](https://github.com/LeXwDeX/opencode-dag-config)。

---

## 本 fork 的其他改动

- **委派智能体**：`task` 把工作委派给子智能体，并可用 `task_id` 继续；带完成通知的后台子智能体需开启 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`。
- **工具健壮性**：修复 LLM 输出里损坏的多字节 Unicode 转义（JSON 修复），校验错误带字段级提示，工具文档扩充，子进程管道修复。
- **CJK 与 IME 修复**：终端 UI 里中日韩文输入的修正（IME 组字刷新、全角文本处理），另有 [`patches/`](./patches) 下的韩文 IME 修复脚本。
- **Worktree 隔离**：按工作流的 `git worktree` 隔离，附实验性的 sandbox-worktree HTTP 端点。
- **配置助手**：[`config_assistant`](./config_assistant) 下提供独立 Go TUI，用于定位、校验和编辑 opencode 配置（`cd config_assistant && go run ./cmd/ocfg`）。

上游全部能力（多 Provider、内置 LSP、客户端/服务器架构、TUI/桌面/Web 客户端）均完整保留。

---

## 安装

预构建 CLI 二进制（Linux / macOS / Windows，附 SHA256SUMS）发布在 [releases 页面](https://github.com/LeXwDeX/OpenCode-GraphAgent/releases)。正式版从 `main` 构建；`oc` 安装器负责选择并安装版本。

发布验收维护两条相互独立的完整性边界：

- **归档完整性（解包前）**：`oc` 安装器在解包前校验 release 的 `SHA256SUMS` 条目，不匹配则拒绝解包。若上游未提供 `SHA256SUMS`，则告警后继续安装（仅依赖 GitHub HTTPS 传输安全）。
- **安装后签名有效性（macOS）**：安装器清除 quarantine 属性（`xattr -cr`）并做 ad-hoc 重签名（`codesign -fs -`），验收断言 `codesign --verify` 通过且二进制可执行。安装后的二进制 hash **有意**不与归档 payload 对比——ad-hoc 签名可能改写二进制字节，两者 hash 即使不同也属正常。也不发布签名后 digest（codesign 输出的跨版本可复现性尚未确立，亦无受支持的可复现性矩阵）。

从源码构建（需要 `package.json` 中 `packageManager` 固定的 [Bun](https://bun.sh) 版本，以及 `.node-version` 指定的 Node 版本）：

```bash
bun install
bun dev              # TUI
bun dev serve        # headless API 服务（端口 4096）

# 独立二进制
./packages/opencode/script/build.ts --single
```

> 本 fork 未发布到 npm/brew/scoop。上游的 `opencode-ai` 包安装的是上游 opencode，不是本 fork。

---

## 质量门禁

- **CI**：每个 PR 跑 typecheck；`main` 门禁额外运行 Bun/Turbo 单元测试与配置助手 Go 测试（Linux）、Playwright e2e（Linux + Windows）、HTTP API 契约测试器、以及生成 SDK 的新鲜度校验。
- **DAG 专项测试**：核心调度单元测试、投影器/状态机漂移测试、工作流生命周期集成测试、每条 DAG 路由的 HTTP API 演练场景。

## 许可证

混合许可证模型：

| 内容 | 许可证 | 文本 |
|---------|---------|------|
| 上游 opencode 代码（绝大多数） | MIT | [`LICENSE`](./LICENSE) |
| DAG 工作流引擎（fork 自研） | AGPL-3.0-or-later | [`packages/core/src/dag/LICENSE`](./packages/core/src/dag/LICENSE)、[`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

精确的文件边界列在 [`NOTICE`](./NOTICE) 中。AGPL 覆盖 DAG 引擎及其衍生品，包括网络服务部署；不碰 DAG 引擎的话，仓库其余部分按 MIT 用就行。

## 文档

- [`docs/architecture.md`](./docs/architecture.md) —— 系统总览、客户端/API 边界与源码索引
- [`docs/reasoning-rewrite-engine-2026-10-08.md`](./docs/reasoning-rewrite-engine-2026-10-08.md) —— 思考自动塑形的设计、测量与验收
- [`packages/opencode/src/memory/CONTEXT.md`](./packages/opencode/src/memory/CONTEXT.md) —— 项目 Memory 的模型与不变量
- [hooks 指南](./packages/core/src/plugin/skill/configure-hooks.md) —— 事件、schema 与验证方法
- [存盘工作流编写指南](./packages/core/src/plugin/skill/create-dag-workflow.md) —— `create-dag-workflow` skill 正文
- [`opencode-dag-config`](https://github.com/LeXwDeX/opencode-dag-config) —— 精选工作流、可组合块与 worker prompt
- [`docs/harness-dag.md`](./docs/harness-dag.md) —— deep 模式准入与审查生命周期
- [`AGENTS.md`](./AGENTS.md) —— 贡献与开发指南

## 链接

- [GitHub](https://github.com/LeXwDeX/OpenCode-GraphAgent) · [Issues](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues)
- [上游 opencode](https://opencode.ai)
