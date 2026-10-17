# Claude Hooks × GraphAgent Agent 生态回归清单（2026-10-17）

## 范围

本文只覆盖 **本地 Agent 生态** 的 Claude Code hooks 兼容性：

- 本地 prompt / command / agent 生命周期；
- 工具执行、权限、MCP 交互；
- 会话、子代理、DAG worker；
- 压缩、指令加载、配置/目录/文件变化；
- 模型切换与本地显示。

不纳入：

- Claude 云 API、Remote Control、组织/Teams 管理；
- Claude 自动权限分类器（本 fork 无对应产品能力）；
- 系统级通知、配额通知、桌面通知；
- `PermissionDenied`、`TeammateIdle` 等本 fork 无本地 producer 的事件。

依据：

- 官方 Claude Code hooks 参考快照：`/private/tmp/claude-hooks-reference-2026-10-16.md`（SHA-256 `f5957ad68ec47adaed8c2462a0cb9fb04ccc979e066b3eec96f5342ec51728cc`）。
- 本地证据矩阵：`packages/opencode/specs/hooks/claude-local-parity.md`。

## 通用契约

| 项目                                                                                          | 本地实现                                             | 回归文件                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 事件选择、`matcher`、handler 类型                                                             | `src/hook/settings.ts`、`src/hook/schema.ts`         | `test/hook/load-chain.test.ts`、`nontool-matcher.test.ts`                                                                |
| 输入 envelope（`session_id`、`prompt_id`、`transcript_path`、`cwd`、`scratchpad_dir`、`permission_mode`、`effort`、`hook_event_name`） | `buildStdinEnvelope` → command/HTTP/MCP/prompt/agent | `claude-input.test.ts`、`envelope-cwd.test.ts`、`envelope-prompt-identity.test.ts`、`hook-consumer-transcript-v2.test.ts`                               |
| `if` 条件                                                                                     | `src/hook/extensions/condition-filter.ts`            | `condition-filter.test.ts`、`if-condition-trigger.test.ts`                                                               |
| `timeout`、取消、失败                                                                         | `src/hook/settings.ts`                               | `handler-cancellation.test.ts`、`hook-executor-protocol.test.ts`                                                         |
| `async` / `asyncRewake`                                                                       | 后台执行、按规则回注下一轮                           | `async-rewake.test.ts`、`hooks-lifecycle-v2-async-rewake.test.ts`                                                        |
| `once`、去重、作用域                                                                          | SessionHooks / skill / agent 注册                    | `scoped-frontmatter.test.ts`、`handler-dedup.test.ts`、`settings-dedup.test.ts`、`once-mcp-protocol.test.ts`             |
| command / HTTP / MCP / prompt / agent 五种 handler                                            | `src/hook/settings.ts`                               | `hook-executor-protocol.test.ts`、`hook-transport-http.test.ts`、`hook-transport-mcp.test.ts`、`hook-consumer-*.test.ts` |
| 阻断、附加上下文、系统消息、权限决策                                                          | 各事件 reducer + consumer                            | 对应事件测试                                                                                                             |

## 兼容边界

- **输入格式。** 默认 envelope 是本 fork 的 native 形态（小写工具名和 native 参数）。command hook 可设置
  `inputFormat: "claude-code"`，在 entry 边界翻译为 Claude 的 `tool_name`/`tool_input`。HTTP、MCP、prompt 和
  agent handler 没有该 opt-in；依赖 `Bash`、`file_path` 等 Claude 字段的脚本必须使用 command + 该选项。
- **SessionEnd 生命周期。** 本地生产者为 `other`（session 删除）和 `prompt_input_exit`（CLI/TUI 退出）。
  `clear`/`resume`/`logout` 目前没有本地 producer；SessionStart 的 `clear` 同样没有。配置在这些 reason 上的
  matcher 不会触发，直到对应生命周期接入。
- **SessionEnd 异步。** 前台 hook 受 `sessionEndTimeout`（默认 1.5s）约束。异步 SessionEnd 在客户端退出时
  也会在该预算内等待；超时后取消，实例继续存活时则保留至实例 dispose。
- **exit 2 的 stderr。** `SessionStart`、`SessionEnd`、`CwdChanged`、`FileChanged`、`PostCompact`、
  `SubagentStart`、`PostModelSwitch` 显示 stderr 但不阻断。其他事件仍按阻断语义处理。
- **上下文边界。** `additionalContext` 与 `systemMessage` 限制为 10,000 字符，超出时截断并标注；内容中的
  `<system-reminder>` 标签会转义，避免 hook 输出关闭宿主 envelope。
- **Stop 输出。** `continue:false` 的 `stopReason` 以用户可见通知落地；异步 `StopFailure` 的输出被忽略。

## 逐项回归

每个事件按“主测试文件 → 边界测试文件”的顺序执行。一个事件通过后再进入下一个。命令均在 `packages/opencode` 下运行。

```bash
bun test --timeout 30000 <测试文件...>
```

### 1. SessionStart

- 本地状态：适用（command V；MCP 启动早期跳过）。
- 主测试：`test/hook/session-start-sources.test.ts`
- 边界：`test/hook/start-context-wiring.test.ts`、`start-context-dedup.test.ts`
- 关注：启动 source、`additionalContext`、去重、MCP 未就绪时跳过、`SessionStart(compact)` 由压缩流程触发。

### 2. Setup

- 本地状态：适用（仅显式 `--init` / `--maintenance` / `--init-only`）。
- 主测试：`test/hook/hooks-lifecycle-setup-cli.test.ts`
- 边界：`test/hook/event-wiring.test.ts`
- 关注：普通启动不得触发 Setup；`--init-only` 不发起模型请求；退出码/输出。

### 3. UserPromptSubmit

- 本地状态：适用（command V；HTTP/MCP 为执行器级证据）。
- 主测试：`test/hook/hooks-lifecycle-v2-turn.test.ts`
- 边界：`test/hook/prompt-admission.test.ts`
- 关注：阻断、附加上下文、`stop_hook_active`、用户可见文本、同步整理不重复触发。

### 4. UserPromptExpansion

- 本地状态：适用（slash command 展开）。
- 主测试：`test/hook/hooks-lifecycle-init-expansion.test.ts`
- 关注：展开后的 prompt、command 上下文、阻断。

### 5. PreToolUse

- 本地状态：适用（command V；HTTP/MCP 执行器级；prompt/agent 未配对）。
- 主测试：`test/hook/hooks-lifecycle-v2-turn.test.ts`
- 边界：`test/hook/tool-boundaries.test.ts`、`tool-rejection-recovery.test.ts`
- 关注：输入替换、defer、拒绝、权限规则、重新校验、工具未执行。

### 6. PermissionRequest

- 本地状态：适用（command V）。
- 主测试：`test/hook/hook-consumer-review.test.ts`
- 边界：`test/hook/hook-ask-ruleset.test.ts`、`test/hook/hook-consumer-permission-persistence.test.ts`
- 关注：允许/拒绝、规则持久化、嵌套 decision、输入/权限更新。

### 7. PermissionDenied

- 本地状态：不适用（无自动分类器）；配置/原生拒绝不得伪造该事件。
- 回归：`test/hook/hook-direct-consumers.test.ts`

### 8. PostToolUse

- 本地状态：适用（command V）。
- 主测试：`test/hook/hooks-lifecycle-v2-turn.test.ts`
- 关注：结果替换、附加上下文、下一轮请求可见。

### 9. PostToolUseFailure

- 本地状态：适用（command V）。
- 主测试：`test/hook/hook-direct-consumers.test.ts`
- 边界：`test/hook/prompt-admission.test.ts`
- 关注：真实 shell 失败、错误反馈进入下一轮、错误状态持久化。

### 10. PostToolBatch

- 本地状态：适用（command V）。
- 主测试：`test/hook/hooks-lifecycle-v2-turn.test.ts`
- 关注：批量工具结果后的下一轮上下文、恢复工具、deferred 路径。

### 11. Notification

- 本地状态：本地 Agent 通知适用；系统级通知不纳入。
- 主测试：`test/hook/hooks-lifecycle-notification.test.ts`
- 边界：`hook-notification-auth.test.ts`、`hook-notification-timing.test.ts`、`hook-notification-context.test.ts`、`hook-notification-background.test.ts`
- 关注：权限询问、空闲、MCP 表单、后台任务需要输入/完成。

### 12. MessageDisplay

- 本地状态：适用（显示投影；原文保留）。
- 主测试：`test/hook/hooks-lifecycle-v2-turn.test.ts`
- 客户端：`packages/app/e2e/regression/hook-message-display.spec.ts`、`packages/tui/test/cli/tui/dag-delivery-render.test.tsx`
- 关注：canonical/model replay 分离、显示/复制/刷新/隐藏、状态与警告、终端序列只在所属会话且 TTY 输出。

### 13. SubagentStart

- 本地状态：适用（command V；HTTP/MCP 未配对）。
- 主测试：`test/hook/hooks-lifecycle-dag.test.ts`
- 关注：TaskTool / DAG 子启动、子上下文、两次本地模型请求。

### 14. SubagentStop

- 本地状态：适用（command V；其他 handler 未配对）。
- 主测试：`test/hook/subagent-stop-continuation.test.ts`
- 边界：`test/hook/hooks-lifecycle-dag.test.ts`、`subagent-stop-routing.test.ts`、`subagent-stop-continuation.test.ts`
- 关注：父级 envelope、继续/阻断、DAG worker 完成、父级停止转换。

### 15. TaskCreated

- 本地状态：适用（command V）。
- 主测试：`test/hook/hooks-lifecycle-todo.test.ts`
- 边界：`test/hook/hooks-lifecycle-v2-todo.test.ts`
- 关注：持久化前拒绝、接受后写入。

### 16. TaskCompleted

- 本地状态：适用（command V）。
- 主测试：`test/hook/hooks-lifecycle-todo.test.ts`
- 边界：`test/hook/hooks-lifecycle-v2-todo.test.ts`
- 关注：完成前拒绝、pending 状态保留、接受后持久化。

### 17. Stop

- 本地状态：适用（command V）。
- 主测试：`test/hook/hooks-lifecycle-v2-turn.test.ts`
- 边界：`test/hook/turn-context.test.ts`、`hooks-lifecycle-v2-batch-stop.test.ts`、`stop-continuation-order.test.ts`
- 关注：阻断继续、`stop_hook_active`、续跑上限、工具调用后重置、同步整理只触发一次。

### 18. StopFailure

- 本地状态：适用（command V，观察型）。
- 主测试：`test/hook/hooks-lifecycle-v2-turn.test.ts`
- 边界：`test/hook/turn-context.test.ts`
- 关注：真实 provider 错误、已显示错误文本、不泄露未显示细节。

### 19. TeammateIdle

- 本地状态：不适用（无 teammate 生命周期）。
- 回归：无需执行；配置解析保留前向兼容。

### 20. InstructionsLoaded

- 本地状态：适用（command V，观察型）。
- 主测试：`test/hook/hooks-instructions-environment.test.ts`
- 边界：`test/session/instruction.test.ts`、`test/hook/hooks-lifecycle-v2-turn.test.ts`、`hooks-lifecycle-v2-compaction.test.ts`
- 关注：环境导出/移除、会话隔离、`load_reason=compact` 每成功批次一次、后台执行不阻塞模型。

### 21. ConfigChange

- 本地状态：适用（command V，观察型）。
- 主测试：`test/hook/settings-hot-reload.test.ts`
- 边界：`test/hook/hooks-lifecycle-config.test.ts`
- 关注：热重载、候选校验、坏配置保留旧链、source 分类。

### 22. CwdChanged

- 本地状态：适用（command V）。
- 主测试：`test/hook/hooks-lifecycle-cwd.test.ts`
- 关注：真实 HTTP move、transcript 可读、旧目录释放、新目录 Bash 环境。

### 23. DirectoryAdded

- 本地状态：适用（command V，观察型）。
- 主测试：`test/hook/hook-consumer-review.test.ts`
- 关注：外部目录授权、`source=register_repo_root`、transcript/environment/permission mode。

### 24. FileChanged

- 本地状态：适用（command V，观察型）。
- 主测试：`test/hook/hooks-lifecycle-external-files.test.ts`
- 关注：watch 列表、刷新后的 watcher 生命周期、warning UI。

### 25. WorktreeCreate

- 本地状态：适用（command V）。
- 主测试：`test/hook/hooks-lifecycle-worktree.test.ts`
- 边界：`test/hook/hook-executor-protocol.test.ts`
- 关注：选择路径、创建失败、transport 特定路径返回。

### 26. WorktreeRemove

- 本地状态：适用（command V）。
- 主测试：`test/hook/hooks-lifecycle-worktree.test.ts`
- 边界：`test/hook/hook-executor-protocol.test.ts`
- 关注：path 保留时移除结果、清理失败。

### 27. PreCompact

- 本地状态：适用（command V）。
- 主测试：`test/hook/hooks-lifecycle-v2-compaction.test.ts`
- 关注：真实 HTTP block、后续成功、失败摘要顺序、自动/手动压缩。

### 28. PostCompact

- 本地状态：适用（command V）。
- 主测试：`test/hook/hooks-lifecycle-v2-compaction.test.ts`
- 关注：仅成功摘要后触发、先于 `SessionStart(compact)`、失败不触发。

### 29. PreModelSwitch

- 本地状态：适用（command V、HTTP V）。
- 主测试：`test/hook/hooks-lifecycle-v2-model.test.ts`
- 边界：`test/hook/hooks-lifecycle-model-http.test.ts`
- 关注：允许/拒绝、持久化、picker/HTTP 反馈、TUI picker、MCP。

### 30. PostModelSwitch

- 本地状态：适用（command V、HTTP V）。
- 主测试：`test/hook/hooks-lifecycle-model-http.test.ts`
- 关注：切换后下一请求上下文、自动回退/恢复。

### 31. SessionEnd

- 本地状态：适用（command V）。
- 主测试：`test/hook/hooks-lifecycle-v2-session.test.ts`
- 边界：`test/hook/session-hooks-trigger.test.ts`
- 关注：真实 V2 删除、只触发一次、file watcher 停止、各退出原因。

### 32. Elicitation

- 本地状态：适用（command V；MCP handler 为 fixture 级）。
- 主测试：`test/hook/hook-consumer-mcp-e2e.test.ts`
- 关注：真实 stdio MCP、hook 回答/拒绝、内容返回 MCP、下一轮模型请求。

### 33. ElicitationResult

- 本地状态：适用（command V；MCP handler 为 fixture 级）。
- 主测试：`test/hook/hook-consumer-mcp-e2e.test.ts`
- 关注：用户结果转换/拒绝、返回 MCP、官方 JSON `continue`/`reason`/`systemMessage` 丢弃。

## 回归记录

| #   | 事件                | 测试                                                                                                  | 结果                                         |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | SessionStart        | `session-start-sources`、`start-context-wiring`、`start-context-dedup`                                | PASS，17 tests                               |
| 2   | Setup               | `hooks-lifecycle-setup-cli`、`event-wiring`                                                           | PASS，9 tests                                |
| 3   | UserPromptSubmit    | `hooks-lifecycle-v2-turn`、`prompt-admission`                                                         | PASS，20 tests                               |
| 4   | UserPromptExpansion | `hooks-lifecycle-init-expansion`                                                                      | PASS，1 test                                 |
| 5   | PreToolUse          | `tool-boundaries`、`tool-rejection-recovery` + v2-turn                                                | PASS，32 tests                               |
| 6   | PermissionRequest   | `hook-consumer-review`、`hook-ask-ruleset`、`hook-consumer-permission-persistence`                    | PASS，28 tests                               |
| 7   | PermissionDenied    | `hook-direct-consumers`                                                                               | N/A；PASS，3 tests（确认配置拒绝不伪造事件） |
| 8   | PostToolUse         | `hooks-lifecycle-v2-turn`                                                                             | PASS（同 #3，20 tests）                      |
| 9   | PostToolUseFailure  | `hook-direct-consumers`、`prompt-admission`                                                           | PASS（同 #3/#7）                             |
| 10  | PostToolBatch       | `hooks-lifecycle-v2-turn`                                                                             | PASS（同 #3）                                |
| 11  | Notification        | `hooks-lifecycle-notification`、`hook-notification-*`                                                 | PASS，12 tests                               |
| 12  | MessageDisplay      | `hooks-lifecycle-v2-turn`、TUI `dag-delivery-render`、app `hook-message-display.spec.ts`              | PASS，TUI 1 + app E2E 1                      |
| 13  | SubagentStart       | `hooks-lifecycle-dag`                                                                                 | PASS，5 tests（与 #14 合计）                 |
| 14  | SubagentStop        | `subagent-stop-continuation`、`subagent-stop-routing`                                                 | PASS，5 tests（与 #13 合计）                 |
| 15  | TaskCreated         | `hooks-lifecycle-todo`、`hooks-lifecycle-v2-todo`                                                     | PASS，2 tests（与 #16 合计）                 |
| 16  | TaskCompleted       | `hooks-lifecycle-todo`、`hooks-lifecycle-v2-todo`                                                     | PASS，2 tests（与 #15 合计）                 |
| 17  | Stop                | `hooks-lifecycle-v2-turn`、`turn-context`、`hooks-lifecycle-v2-batch-stop`、`stop-continuation-order` | PASS，7 tests（与 #18 合计）                 |
| 18  | StopFailure         | `hooks-lifecycle-v2-turn`、`turn-context`                                                             | PASS，7 tests（与 #17 合计）                 |
| 19  | TeammateIdle        | N/A                                                                                                   | 不适用                                       |
| 20  | InstructionsLoaded  | `hooks-instructions-environment`、`session/instruction`、v2-turn、v2-compaction                       | PASS，14 tests + 1 todo                      |
| 21  | ConfigChange        | `settings-hot-reload`、`hooks-lifecycle-config`                                                       | PASS，4 tests                                |
| 22  | CwdChanged          | `hooks-lifecycle-cwd`                                                                                 | PASS，5 tests（与 #24 合计）                 |
| 23  | DirectoryAdded      | `hook-consumer-review`                                                                                | PASS（同 #6）                                |
| 24  | FileChanged         | `hooks-lifecycle-external-files`                                                                      | PASS，5 tests（与 #22 合计）                 |
| 25  | WorktreeCreate      | `hooks-lifecycle-worktree`、`hook-executor-protocol`                                                  | PASS，31 tests（与 #26 合计）                |
| 26  | WorktreeRemove      | `hooks-lifecycle-worktree`、`hook-executor-protocol`                                                  | PASS，31 tests（与 #25 合计）                |
| 27  | PreCompact          | `hooks-lifecycle-v2-compaction`                                                                       | PASS，3 tests（与 #28 合计）                 |
| 28  | PostCompact         | `hooks-lifecycle-v2-compaction`                                                                       | PASS，3 tests（与 #27 合计）                 |
| 29  | PreModelSwitch      | `hooks-lifecycle-v2-model`、`hooks-lifecycle-model-http`                                              | PASS，7 tests（与 #30 合计）                 |
| 30  | PostModelSwitch     | `hooks-lifecycle-model-http`                                                                          | PASS，7 tests（与 #29 合计）                 |
| 31  | SessionEnd          | `hooks-lifecycle-v2-session`、`session-hooks-trigger`                                                 | PASS，11 tests                               |
| 32  | Elicitation         | `hook-consumer-mcp-e2e`                                                                               | PASS，4 tests（与 #33 合计）                 |
| 33  | ElicitationResult   | `hook-consumer-mcp-e2e`                                                                               | PASS，4 tests（与 #32 合计）                 |

全量 hooks 回归（`bun test test/hook --timeout 30000`）：**695 pass / 0 fail**，108 files。

## 已知限制

- 官方 33 个事件中，本 fork 本地不适用：`PermissionDenied`、`TeammateIdle`。
- HTTP/MCP handler 在部分事件只有执行器级证据，未形成完整 producer→consumer 配对。
- 系统通知、Claude 云 API、Remote Control、组织/Teams 管理、自动分类器不在范围内。
- 真实签名模型测试受外部 token 限制；签名保护由本地模拟测试覆盖。
