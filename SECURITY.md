# Security

## Threat Model

### Overview

GraphAgent is an AI-powered coding agent that runs locally on your machine, with the privileges of the user who starts it. It has access to powerful tools, including shell execution, file operations and web access. Hooks and the shell tool run with that user's permissions.

### No Sandbox

GraphAgent does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

If you need true isolation, run GraphAgent inside a Docker container or VM.

The same holds for unattended workflow sessions (DAG nodes, and `task` subagents while DAG mode is on). The built-in safety list, the `dag.permission` tiers and an external command guard hook narrow what they can do, but none of them is a security boundary. See [Unattended permissions](docs/unattended-permissions.en.md) ([中文](docs/unattended-permissions.md)) for what each covers and how to set it up.

### Out of Scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Sandbox escapes**             | The permission system is not a sandbox (see above)                      |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary       |
| **Malicious user config files** | Users control their own config; modifying it is not an attack vector    |

The last row covers the user's own configuration. Executable project-layer configuration under `<root>/.agents/` (hooks, MCP servers, formatter and LSP commands, embedded shell in commands and skills, and skill and agent frontmatter hooks) is gated by project trust: it does not run until the user confirms it with `/trust`. Skills that project settings bring in from outside `.agents/skills/` through `skills.paths` or `skills.urls` cannot be confirmed, so their hooks and embedded shell stay disabled. A local file such as `hooks.local.json` or `settings.local.json` counts as the user's own only while Git does not track it.

## Reporting Security Issues

We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/LeXwDeX/GraphAgent/security/advisories/new) tab.

We will send a response indicating the next steps in handling your report. After the initial reply to your report, we will keep you informed of the progress towards a fix and full announcement, and may ask for additional information or guidance.

### Escalation

If you do not receive an acknowledgement of your report within 6 business days, you may leave a comment on the advisory thread.

---

# 安全策略

## 威胁模型

### 概述

GraphAgent 是运行在你本机上的 AI 编码智能体，以启动它的用户的权限运行。它可以使用功能强大的工具，包括 shell 执行、文件操作和网络访问。hooks 和 shell 工具都以该用户的权限执行。

### 没有沙箱

GraphAgent **不会**对智能体做沙箱隔离。权限系统只是一项用户体验功能，帮助用户了解智能体正在做什么：执行命令、写入文件等操作之前，它会先询问确认。但它的设计目标不是提供安全隔离。

如果需要真正的隔离，请在 Docker 容器或虚拟机中运行 GraphAgent。

无人值守的工作流会话同样如此，包括 DAG 节点，以及 DAG 模式开启时 `task` 派出的子智能体。内置安全保险清单、`dag.permission` 三档和外部命令守卫 hook 能收窄它们可以做的事，但都不是安全边界。各自覆盖什么、怎样配置，见[无人值守权限](docs/unattended-permissions.md)（[English](docs/unattended-permissions.en.md)）。

### 不在范围内

| 类别                     | 理由                                                |
| ------------------------ | --------------------------------------------------- |
| **沙箱逃逸**             | 权限系统不是沙箱（见上文）                          |
| **LLM 服务商的数据处理** | 发送给你所配置的 LLM 服务商的数据，由其自身政策约束 |
| **MCP 服务器的行为**     | 你配置的外部 MCP 服务器在我们的信任边界之外         |
| **恶意的用户配置文件**   | 用户掌控自己的配置，修改配置不构成攻击途径          |

最后一行指的是用户自己的配置。`<root>/.agents/` 下可执行的项目层配置（hooks、MCP 服务器、格式化器和 LSP 命令、命令与 skill 中嵌入的 shell，以及 skill 与 agent frontmatter 中的 hooks）受项目信任门控：用户用 `/trust` 确认之前，它们不会运行。项目设置通过 `skills.paths` 或 `skills.urls` 从 `.agents/skills/` 之外引入的 skill 无法被确认，所以它们的 hooks 和嵌入的 shell 始终保持禁用。`hooks.local.json`、`settings.local.json` 这类本地文件，只有在 Git 不跟踪它们时，才算用户自己的配置。

## 报告安全问题

感谢你以负责任的方式披露所发现的问题，我们会尽力致谢你的贡献。

要报告安全问题，请使用 GitHub Security Advisory 的 [“Report a Vulnerability”](https://github.com/LeXwDeX/GraphAgent/security/advisories/new)（报告漏洞）入口。

我们会回复后续的处理步骤。首次回复之后，我们会持续告知修复和正式公告的进展，并可能请你补充信息或提供协助。

### 逾期未确认

如果 6 个工作日内没有收到对报告的确认，你可以在该 advisory 的讨论线程中留言。
