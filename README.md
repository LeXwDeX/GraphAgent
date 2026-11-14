<p align="center">
  <b>简体中文</b> ·
  <a href="./README.en.md">English</a>
</p>

# GraphAgent

> 跑动态工作流的终端编码智能体：主智能体自己设计依赖图，子智能体按波次并行执行，状态持久化，崩溃后能恢复。

[![release](https://img.shields.io/github/v/release/LeXwDeX/GraphAgent)](https://github.com/LeXwDeX/GraphAgent/releases)
[![license](https://img.shields.io/badge/license-MIT%20%2B%20Apache--2.0-blue)](#起源与许可)
[![stars](https://img.shields.io/github/stars/LeXwDeX/GraphAgent)](https://github.com/LeXwDeX/GraphAgent/stargazers)

<!-- 这里将来放一张 DAG 运行的截图或 GIF：主对话建图、节点分波次并行、TUI 检查器里的实时状态。 -->

GraphAgent 是独立的终端编码智能体，专注动态 DAG 工作流。它起源于 opencode 的早期版本，从 v2.0 起完全独立维护。

单个智能体循环处理一步到位的任务没有问题。任务一旦有先后依赖、有能并行的部分、中途还要过一道审查，它就吃力了：本该并行的活被串着跑，中间结论也没人复核。进程一挂，只能从头来。GraphAgent 让主智能体先把任务画成一张依赖图，再按图执行。图不是预先写死的，是它按任务现设计的，所以 DAG 工作流基本上就是动态工作流。

图里每个节点是一个真实的子会话，有自己的智能体和上下文窗口；依赖都满足的节点算一个波次，同一波次里并行跑。状态以事件持久化，所以能暂停、单步、重规划，崩溃后按持久化的记录恢复，不会凭空重放模型调用。

## 项目状态

v2.0 开发中，即将发布。发布进度在[里程碑](https://github.com/LeXwDeX/GraphAgent/milestone/7)里跟踪；可复现的问题请提 [Issue](https://github.com/LeXwDeX/GraphAgent/issues)。

## 核心能力

| 能力        | 说明                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| DAG 工作流  | 主智能体设计依赖图，每个节点是真实的子会话，按波次并行；状态持久化，可暂停、恢复、重规划；节点超时从拿到执行槽位起算，排队时间不计 |
| 统一子运行  | `task` 与 DAG 节点共用 ChildRun：每次委派一条持久记录，统一归属校验、取消和结果投递；子会话只接受主 agent 通信                     |
| 前后台委派  | 提示词准则决定 `task` 在前台等待还是后台运行；后台结果完成时以一条消息回注，不打断主会话                                           |
| 只读 review | 内置只读 `review` agent；`/review` 默认后台执行，结论由主会话转述                                                                  |
| 思考塑形 🧪 | 实验性功能，默认关闭                                                                                                               |
| 项目记忆    | `/memory`，只保存你确认过的内容，同一项目的所有 worktree 共用                                                                      |
| Goal / Loop | `/goal`、`/subgoal`，外部 judge 判断进度，有回合预算                                                                               |
| Hooks       | 兼容 Claude Code hooks 协议                                                                                                        |
| 上下文管理  | 工具输出限制、工具调用上限、长会话压缩                                                                                             |

### DAG 工作流

主智能体觉得任务值得拆，就自己建图，不用你开口；你也可以用 `/dag-auto <任务>` 直接要求。边只表示“下游要读上游的产出”，没有这层关系的节点就并行。负责审查和仲裁的节点叫门禁，输出 ACCEPT、REVISE、REJECT 或 BLOCKED，下游可以按裁定决定跑不跑。TUI 里有 DAG 检查器，能看各波次和节点的实时状态，也能进入任何一个节点的子会话。

模型分层写在 `.agents/dag.jsonc`（关键节点用 advanced，跑量的用 standard），常用的图存进 `.agents/workflows/`，之后按名字就能启动。精选模板在 [opencode-dag-config](https://github.com/LeXwDeX/opencode-dag-config)。节点的 `timeout_ms` 从拿到执行槽位开始计时，排队时间不计。崩溃恢复只认持久化的记录。引擎不假设有跨进程的锁，也不保证节点恰好执行一次。用法和引擎细节见 [docs/dag-workflows.md](./docs/dag-workflows.md)。

### 子运行与通信

`task` 和 DAG 节点共用同一套 ChildRun。一次委派对应一条持久记录，记录归属、状态与结算结果；后台运行结束后结果只投递一次，重启或进程丢失的运行也会补投。子会话不接受自由输入：HTTP 操作层对子会话的写请求返回 409，只放行权限回复和只读旁问；引擎准入要求携带当前运行的 live 凭证。

`agent` 工具负责主会话与 DAG 节点之间的观察和消息：`observe` 分页查看节点进度与尝试，`send` 向确切的活跃尝试投递，`receive` 读取邮箱。节点需要澄清时问父会话，不直接问用户。工具只在存在活跃 DAG 节点运行时出现，可见性由进程内注册表判定，不查数据库。

### 只读 review 与前后台分类

`/review` 使用内置的只读 `review` agent：它能读文件、搜索、查 LSP、跑只读的 git 和 forge 命令，不能编辑文件、起子任务或跑会改文件的命令。命令默认在后台运行，结束后把结论交回主会话，由主会话转述。

`task` 的前台/后台由提示词里的准则判断，代码不做启发式分类：需要用户确认、会影响与主会话共享的状态、结果是下一步的直接输入、或几秒钟就能完成时走前台；不阻塞下一步、只读或只写主会话不碰的文件、耗时以分钟计、结果一条消息能说完时才走后台。

### 思考塑形

🧪 实验性功能，默认关闭。思考型模型会把之前的思考内容在后续请求里回传，里面常有复述、被推翻的猜测和纠错过程。这个功能在后台把已完成的思考整理得更短，在后续步骤的请求里换用整理后的版本。整理失败、超时或没有可用的小模型时保留原文；原文一直存着，关掉功能后回放的就是原文。带签名或加密的思考不会碰。

我们想知道的是，开源模型的思考内容经过塑形之后，输出能力会不会提高。效果还在验证，所以标成实验性、默认关闭。整理用配置的 `small_model`，没配就用服务商自带的小模型：

```jsonc
// graphagent.json
{
  "small_model": "provider/small-model", // 建议选有 `none` 推理档位的模型
  "reasoningDistillation": {
    "enabled": true, // 显式开启；默认 false
  },
}
```

### 项目记忆

`/memory on` 开启后，GraphAgent 按项目保存偏好、决策和术语，只保存经你确认的内容，同一项目的所有 worktree 共用一份。它不是代码索引，也不会压过你当前的输入和更高优先级的指令。

### Goal 与 Loop

`/goal <目标>` 让智能体在当前会话里跨回合自己推进一个目标，`/subgoal` 管子目标。每个回合结束后由外部 judge 判断进度：done 就收工，continue 就接着跑。总回合数有预算（默认 20），用尽后暂停，可以恢复。目标状态持久化，重启不丢。

### Hooks

兼容 Claude Code 的 hooks 协议。`hooks.json` 从全局配置目录和项目的 `.agents` 目录读取，执行类型有 command、HTTP、MCP 工具、prompt 和 agent 五种；项目里的 hooks 要先经过信任确认才会生效。`/import-claude` 把 `.claude/settings*.json` 审阅后转换进 `.agents/`，`/create-hook` 带你写新的 hook。详细说明见 [hooks 指南](./packages/graphagent/src/skill/builtin/configure-hooks.md)。

### 上下文管理

一组管上下文的功能：限制工具输出的长度、限制每次输入的工具调用次数、自动压缩长会话。截断输出时会给出可执行的续读方式。

## 其他改动

- `task` 可以按 `task_id` 续接子智能体；后台子智能体完成时自动通知。
- 所有模型共用一份系统提示词，工具的用法写在各自的描述里，不按 Provider 挑提示词。
- 工具更严格，也更容易排错：`edit` 严格匹配（多处命中时列出候选行，找不到时给出最接近的片段），参数校验的报错带字段级提示。
- 支持用独立的 git worktree 管理工作目录。工作流不会自动隔离，并发的工作流要用不同的 worktree，或者串行跑。
- 会话创建时可指定 DAG 模式；TUI 页脚显示开关状态，状态接口返回可用性、并发与节点上限、token 预算用量。
- `config_assistant`（命令 `ocfg`）是一个用 Go 写的独立 TUI，用来定位、校验和编辑配置。

## 快速开始

预构建的二进制（Linux、macOS、Windows，附 SHA256SUMS）在 [Releases](https://github.com/LeXwDeX/GraphAgent/releases) 页，解压后把 `graphagent` 放进 PATH，在项目目录里运行。仓库里现有的 `oc` 安装脚本会在 v2.1 删除，安装和升级都并入主程序，见路线图。GraphAgent 不发布到 npm、brew 和 scoop，上游的 `opencode-ai` 装的是上游 opencode，不是 GraphAgent。

从源码运行需要 `package.json` 里 `packageManager` 固定的 Bun，以及 `.node-version` 指定的 Node：

```bash
bun install
bun dev <项目目录>    # 启动 TUI；不带目录时在 packages/graphagent 里运行
```

启动之后，给它一件有阶段、有并行空间的活就行，不用先写任何 DAG 配置：

```text
/dag-auto 把 auth 和 server 两个包迁移到新 API，最后跑集成测试
```

想把常用的图固定下来，就存成 `.agents/workflows/parallel-migrate.yaml`，之后说一句“跑 parallel-migrate 工作流”就按名字启动。下面这份 spec 里，两个迁移节点在同一波次并行，`assemble` 等它们都完成才开始：

```yaml
title: 并行迁移
config:
  name: parallel-migrate
  nodes:
    - id: discover
      name: discover
      worker_type: explore
      depends_on: []
      required: true
      prompt_template: { inline: "列出所有需要迁移到新 API 的包。" }

    - id: migrate-auth
      name: migrate-auth
      worker_type: build
      depends_on: [discover]
      prompt_template: { inline: "把 auth 包迁移到新 API。" }

    - id: migrate-server
      name: migrate-server
      worker_type: build
      depends_on: [discover]
      prompt_template: { inline: "把 server 包迁移到新 API。" }

    - id: assemble
      name: assemble
      worker_type: build
      depends_on: [migrate-auth, migrate-server]
      prompt_template: { inline: "跑集成测试，汇总结果。" }
```

安装步骤、完整性校验和源码构建的细节见 [docs/install.md](./docs/install.md)。

## 设计思路

我们把图当成一份可执行、可持久化、可检查的契约，不是给人看的流程图，也不是事后给提示词链加的箭头。边必须真的传递产出：下游不读上游的东西，这条依赖就该删，独立的工作直接并行。模板只是参考拓扑，主智能体可以按任务增删分支，但每次剪枝要写明理由。预测、复审和裁决由不同的角色做，门禁不能剪。迭代只是有界的局部改图，不存在隐藏的环。最后，代码和测试说了算，状态靠事件记录恢复，代价高的地方留给人暂停、单步、取消和重规划。

第一个完整的 DAG 引擎提交是 2026-07-02；论文 [What makes prompts a graph](https://arxiv.org/abs/2607.27578) 到 2026-07-30 才把显式结构、提示词与拓扑分离、可执行语义和“图是一等制品”这些想法归纳出来，比引擎晚了四周。

## 路线图

v2.0 的剩余工作也在[里程碑](https://github.com/LeXwDeX/GraphAgent/milestone/7)里跟踪：

- DAG 模式的行为面：并发池、预算与质量机制、节点权限自动裁决。
- workflow 工具接口收敛、工作流级 worktree、事件驱动邮箱与持久对账。
- agent 契约与 composer：内置调研、架构设计、原型设计 agent，并在 DAG 内组合公共 agent。
- PR 监听改为事件源；`/remind` 持久提醒；后台任务显示与子 agent 只读界面。
- v2.0.0 发布：版本推导、Breaking 清单、中英迁移指南与三平台冒烟。
- v2.1：安装与升级并入主程序，直接从 GitHub 检索新版本并升级，不再需要 `oc` 脚本；release 打包随之调整，macOS 上安装不用再输密码；配置也可以从 GitHub 仓库读取（[#1281](https://github.com/LeXwDeX/GraphAgent/issues/1281)）。

这些都是计划，实际状态以里程碑为准。

## 起源与许可

GraphAgent 起源于早期的 opencode（MIT，[anomalyco/opencode](https://github.com/anomalyco/opencode)），从 v2.0 起作为独立项目维护。

许可分两条：继承自上游的代码保持 MIT，包括被我们改过的上游文件，文本见 [LICENSE](./LICENSE)；GraphAgent 新写的代码是 Apache-2.0，文本见 [LICENSE-APACHE](./LICENSE-APACHE)。精确的文件边界在 [LICENSE-UPSTREAM.txt](./LICENSE-UPSTREAM.txt)，[NOTICE](./NOTICE) 有摘要。再分发时请保留 NOTICE 里的版权与归属声明。

## 文档

除 architecture.md 和功能清单外，下面的文档目前只有英文。

- [docs/architecture.md](./docs/architecture.md)：v1 架构，包括组件与目录、客户端与协议、源码索引
- [docs/dag-workflows.md](./docs/dag-workflows.md)：DAG 工作流的用法、配置和引擎细节
- [docs/install.md](./docs/install.md)：安装、完整性校验和源码构建
- [docs/compaction-retry.md](./docs/compaction-retry.md)：Provider 重试与压缩请求
- [hooks 指南](./packages/graphagent/src/skill/builtin/configure-hooks.md)：事件、配置和验证方法
- [docs/功能清单.md](./docs/功能清单.md)：功能与源码入口索引
- [AGENTS.md](./AGENTS.md)：开发指南
- [CONTRIBUTING.md](./CONTRIBUTING.md)：贡献说明

## 链接

[GitHub](https://github.com/LeXwDeX/GraphAgent) · [Issues](https://github.com/LeXwDeX/GraphAgent/issues) · [Releases](https://github.com/LeXwDeX/GraphAgent/releases) · [里程碑](https://github.com/LeXwDeX/GraphAgent/milestone/7) · [opencode-dag-config](https://github.com/LeXwDeX/opencode-dag-config)
