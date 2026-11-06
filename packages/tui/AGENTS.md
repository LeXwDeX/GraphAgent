# packages/tui 开发框架规范

本文约束 `packages/tui` 的全部新代码。读者是写代码的模型与审阅者。规则是硬规则，不是建议。出处写作“F2（#1025）方案 5”的形式，Issue 编号见第 12 节末尾。

标记约定：

- 附录 A 是维护者已拍板的 13 项决定的摘要；正文各节已按决定写成规则。
- "审阅时核对"：做不到机器检查的规则，审阅者按其后写的内容核对。
- 本文所有 `grep` 断言都在仓库根目录执行，结果为空即通过。

## 1. 适用范围与优先级

- 适用于 `packages/tui` 下全部新增和修改的代码、测试、文案。
- 与 Issue 正文冲突时，以 Issue 为准。PR 描述里写明冲突点，并同时提 PR 修订本文。
- 本文和 Issue 都没有覆盖的情况，先停下，在 PR 描述里提出，等维护者答复。不自创新模式、新目录、新抽象。
- 目录树和分层里标"目标"的部分，在 F1（#886）合并后改标"现状"（F0 排期）。F1 合并前，新代码按"目标"放置。
- 技术栈固定：opentui（`@opentui/core`、`@opentui/solid`、`@opentui/keymap`）加 Solid；server 在 Worker，SDK 的 fetch 经 `postMessage`（Worker RPC）。不换渲染框架（F2 #1025 "不做"）。
- 公开仓库：本文与代码、注释、文案、提交信息不写本机路径、内网地址、主机名、AI 署名。提交前运行 `bun run check:hosts`（S1 #1037 落地后）。

## 2. 目标目录结构

```
packages/tui/src/
  app.tsx               # provider 树（F1 3.3）
  shell/                # 骨架（F1）：app-frame、top-bar、footer；bottom-zone（F3）；
                        #   status-band、drawer（F4）；pr-line（F6）
  panel/                # 面板模板与具体面板（F3）：
                        #   shell.tsx（PanelShell）、list.tsx、settings.tsx、detail.tsx、host.tsx（PanelHost）
                        #   具体面板 panel/<名>.tsx，如 panel/dag.tsx
  ask/                  # ask-queue.ts：询问区队列（F3）
  commands/             # registry.ts、server-args.ts：/ 命令注册表（F3）；命令 run 回调可经 useSDK() 发写请求
  config/               # keybind.ts、keybind-disposition.ts：键位唯一来源（F1 4）
  keymap.tsx            # keymap 注册与 hooks（保留，不建 keymap/ 目录）
  context/              # 数据层与 provider
                        #   sync.tsx（store、onResync）、event-gate.ts、frame-clock.ts、
                        #   stream-buffer.ts、interest.ts（interest 聚合器）、ticker.ts、sdk.tsx、route.tsx、theme.tsx …
  routes/               # home.tsx、session/（含 MainSessionView、SubAgentView、rows.ts）
  session/              # 会话级辅助（F5）：siblings.ts、navigate.ts、prefill.ts
  attention/            # index.ts、notify.ts：F1 把现有 attention.ts 迁入；F5 补子 agent 提醒
  dag/                  # model.ts、waves.ts、bar.ts、prefill.ts：纯函数（F4）
  pr/                   # state.ts：prLineState 纯函数（F6）
  theme/                # index.ts、assets/graphagent.json（F1 1）
  i18n/                 # index.ts（t()）、zh-CN.ts、en.ts、receipt.ts（F1 3.6、3.9）
  ui/                   # 无状态基础组件：border.ts、link.tsx、width.ts（cellWidth）等
  component/            # 冻结：不得新增文件；现有组件随各 F Issue 迁出到 ui/、panel/、shell/
  util/
packages/tui/test/      # 镜像 src/ 路径（src/dag/bar.ts → test/dag/bar.test.ts）
  perf/                 # F2a 基准框架（F2a 方案 1）
  architecture.test.ts  # 依赖方向检查，调用 script/check-tui-imports.ts（F1）
```

目录职责（一句话）与落地 Issue：

- `shell/`：整屏固定列布局的各区域组件。F1 落骨架，F3、F4、F6 往槽位里填内容。
- `panel/`：面板底板 `PanelShell` 与三个模板，加 `PanelHost`（栈式，替代 `DialogProvider`），以及各具体面板。功能的纯逻辑放功能目录（`dag/`、`pr/`），不放 `panel/`。F3。
- `ask/`：权限、提问、`confirm`、`choice` 的队列。F3。
- `commands/`：内置与服务端命令的统一注册表。F3。
- `config/`：键位 `Definitions`、`CommandMap` 与处置表。F1。
- `context/`：provider 与数据层。F1 新增 `event-gate`、`frame-clock`、`stream-buffer`、`interest`、`ticker`（计时唯一来源，`frame`/`second`/`at`）；F2 负责把现有动画迁到 `ticker`。
- `routes/`：`home`、`session`（有 `parentID` 的会话渲染为子 agent 视图）、`diff`。F1、F5。
- `dag/`、`pr/`：无 I/O 的纯函数。F4、F6。
- `theme/`：token 表、`resolveTheme`、主题 JSON。F1。
- `i18n/`：双语文案表与 `t()`。F1。
- `session/`：会话级辅助函数（同级排序、导航、预填落地）。F5。
- `attention/`：提醒与注意力上报。F1 迁入 `index.ts` 与 `notify.ts`，F5 补子 agent 提醒。
- `ui/`：无状态展示件，不访问数据；含统一宽度函数 `width.ts`。
- `component/`：冻结。迁移前的现有组件（输入框、`PatchDiff`、`Spinner` 等）留在原处，不得新增文件；F1–F6 全部合并时应为空或只剩明确列出的遗留。

不再存在的目录或文件（F1 3.4、3.5，F2 5，F3 4）：`plugin/`、`feature-plugins/`、`context/data.tsx`、`ui/dialog*.tsx`、`component/dialog-*.tsx`、`component/bg-pulse*`、`ui/spinner.ts`、`ui/spinner-register.ts`。新代码不得往这些位置添加文件。

## 3. 分层与依赖方向

依赖单向，高层可以 import 低层，反之不行。从低到高：

1. 纯模块：`theme/`、`i18n/`、`dag/`、`pr/`、`util/`。
2. `ui/`：无状态展示。
3. 数据层：`context/` 的事件、store、时钟、SDK。
4. `shell/`、`panel/`、`ask/`、`commands/`、`session/`、`attention/`、`component/`。
5. `routes/`。

import 规则：

| 目录 | 不得 import | 检查 |
| --- | --- | --- |
| `ui/` | 数据层（`sync`、`sdk`、`event-gate` 等）、`shell/`、`panel/`、`ask/`、`commands/`、`routes/` | 依赖方向检查 |
| `dag/`、`pr/` | `solid-js`、`@opentui/solid`、`context/*`、数据层 | `grep -rn -e "solid-js" -e "@opentui/solid" -e "/context/" packages/tui/src/dag packages/tui/src/pr` 为空 |
| `theme/`、`i18n/` | 数据层、组件目录 | 依赖方向检查 |
| 数据层 | `ui/`、`shell/`、`panel/`、`ask/`、`commands/`、`routes/` | 依赖方向检查 |
| `shell/`、`panel/`、`ask/`、`commands/`、`session/`、`attention/`、`component/` | `routes/` | 依赖方向检查 |

- `ui/` 可以读主题 token（现状先例：`ui/toast.tsx` 用 `useTheme`），文字由调用方经 props 传入。
- 依赖方向检查：脚本 `script/check-tui-imports.ts`，遍历 `packages/tui/src` 的 import，按上表判错。它在 `packages/tui` 的 `bun test` 里以 `test/architecture.test.ts` 运行（CI 必跑），由 F1 落地，F1 验收引用本表。改上表规则必须同时改脚本与本文。
- 读：组件经 `useSync()` 加 `createMemo` 选择器读取，不在组件里遍历整张表。
- 写：只允许在 `routes/`、`panel/`、`ask/`、`commands/` 的事件处理函数里（`commands/` 即命令注册表里命令的 `run` 回调，如 `session.command`），经唯一的 `useSDK()` 调 `sdk.client.*`。`ui/`、`shell/` 的展示组件、`dag/`、`pr/` 纯函数里不得调用 SDK。检查：`grep -rn "sdk.client" packages/tui/src/ui packages/tui/src/shell packages/tui/src/dag packages/tui/src/pr` 为空。
- 事件订阅只经 `useEvent()` → EventGate。组件不得自己订阅 Worker 事件。

## 4. 数据流

固定流水线（F1 方案 5）：

```
Worker 事件 → EventGate（按会话过滤）→ FrameClock（按帧合批）→ store（reconcile）→ selector（createMemo）→ 组件
```

规则：

- Worker 侧的过滤、合并、按帧 post、`events.setInterest({ full })` 归 C1（#1013）。客户端 EventGate 是第二道防线，两侧共用 C1 5.6 的同一张分类表，不一致以 C1 为准。
- 事件分三类（F1 5.1）：`global`（始终投递）、`session-summary`（始终投递，体积小）、`session-full`（只给有效完整集合里的会话）。未列出的事件默认归 `global`。
- 对不在完整集合里的会话：`message.part.delta` 与 `text`/`reasoning` part 更新直接 `drop`；`tool` part 以精简形态转发给摘要归约器，不入库。
- 批量写入：同一帧内的事件用一个 `batch()` 写完。同一帧 100 个事件，store 批量写入 1 次。权限、提问事件走 `flushNow`，不等下一帧。
- 派生状态一律 `createMemo`。禁止在 `createEffect` 里写 store 做派生。审阅时核对：PR 描述列出本 PR 新增的每个 `createEffect` 及用途；体内出现 `setStore` 或 `reconcile` 的一律打回。
- 流式文本进可变 `StreamBuffer`，不进 store。`message.part.delta` 只 `append`；`message.part.updated` 写 store 并 `settle`。读 `part.text` 的地方改走 `readPartText(part)`。流式期间 `store.part` 写入次数为 0。乱序（`updated` 先于 delta）时丢弃找不到 buffer 的 delta。
- 不可见会话只留 `SessionSummary`，完整消息只在 `hydrated`（LRU，基础上限 `HYDRATED_MAX = 4`，实际上限 `max(HYDRATED_MAX, 父链长度 + 1)`）里。当前会话与全部祖先不被驱逐。`session.deleted` 要同时清 `message`、`part`、`summary`、`hydrated`。
- 进入会话的固定顺序：向 interest 聚合器登记 → `await setInterest` 确认 → `sync.session.sync(sessionID)` → 之后的事件与快照幂等合并。
- interest 只经唯一聚合器 `context/interest.ts` 登记（来源键：当前会话与父链、F5 子 agent 视图、F4 正在显示的工作流的归属会话）。聚合后每帧至多一次 `setInterest`。检查：`grep -rn "setInterest" packages/tui/src` 只命中 `context/interest.ts` 与 `context/` 内的接入处。
- 重连：唯一入口是 `context/sync.tsx` 提供的 `onResync(fn)` 注册表；F4、F6 等功能注册各自的刷新函数，不自建重连监听。`reconnected` 后所有 `hydrated` 会话重新 `sync`，buffer 清空，已加载会话的摘要由快照重建；其余数据片（`dag` 汇总、`goal`、`pr_watch`、`dagNodes`）各自全量刷新。快照加载与重连刷新不得触发 toast（F6 2.4）。新增数据片必须在同一 PR 里向 `onResync` 注册刷新函数。
- 禁止轮询 DAG 节点或 PR 状态。拉取触发点只有：首次需要、`resync`、`graphRev` 跳变、重连（F4 2.1）。

### 新增一种服务端事件的接入步骤

1. manifest 登记：在 `packages/schema/src/event-manifest.ts` 登记事件，并在 C1 5.6 的分级表登记范围。`pr.watch.updated`（F6 1.2）是先例：`session-summary`，非 durable。
2. EventGate 分类：在 `scopeOf` 里归入 `global`、`session-summary`、`session-full` 之一。归 `session-summary` 的事件体积必须小。
3. store 分片：按 `sessionID` 或实体 ID 建键，用 `reconcile` 写入。写入点集中在 `sync.tsx` 的事件分支，不在组件里。
4. selector：组件只读 `createMemo` 派生值。同时写出重连刷新逻辑。
5. 测试：gate 决策用例；非完整集合会话的 `store.message`/`store.part` 写入为 0；乱序或重连用例（扩展 `test/cli/cmd/tui/sync-*.test.tsx` 夹具）；无新事件时帧数为 0。

## 5. 渲染预算与性能红线

数字来自 F2（#1025）方案 7.4 的"目标"列和 F2a（#1007）基准。机器无关的计数标"硬"，直接失败。

| 红线 | 要求 | 检查（F2a 场景） |
| --- | --- | --- |
| 空闲 | 无运行中的会话、无新事件时渲染帧数为 0（硬） | P15 |
| 忙碌 | spinner 在屏内时 ≤ `2 × 1000 / TICK_MS + 2` 帧 / 2 秒（硬） | P16 |
| 屏外 spinner | 消息区 spinner 全部滚出视口时，帧数与屏外个数无关（硬）；底区被面板或询问区占用时为 0（硬） | P17、P17b |
| 失焦、空白区鼠标 | 窗口 `blur` 且忙碌 0 帧；无悬停元素的区域移动鼠标 0 帧（硬） | P18、P19 |
| layer 注册 | 连续输入 50 个普通字符 `registerLayer` 为 0（硬）；`/` 序列整体 ≤ 2（打开一次、关闭一次）（硬） | P3、P7 |
| selector 求值 | 每次按键的 keymap 选择器求值次数，S 档与 L 档相同（硬） | P4 |
| store 写入 | 流式 delta 对 `store.part` 写入为 0；每帧对 `store.message`/`store.part` 写入 ≤ 1（硬） | P13 |
| 干扰 | 非当前会话对 `store.message`/`store.part` 写入为 0（硬）；主会话输入 p95 增幅 ≤ 10% | P14 |
| 挂载行数 | ≤ 视口行数 + 2 × `PART_OVERSCAN` + `TAIL_ALWAYS`（硬） | P10 |
| 延迟 | 输入 p95 ≤ 16ms、p99 ≤ 33ms；`/` 打开 p95 ≤ 33ms 且无 > 100ms 的帧；冷滚动 p99 ≤ 33ms 且无 > 100ms 的帧 | P1、P5、P8 |

- 用户报告的两个场景（P5 `/`、P8 滚动）的"无 > 100ms 的帧"是写死的绝对上限，只许收紧，放宽需用户确认。
- 稳态内存：循环"流式、切换会话、回来"，第 3 个窗口堆增长相对第 2 个 ≤ 5%（P20）。

### 新组件的预算（每个 PR 描述必须写明）

- 它引起的 `store.message`/`store.part` 写入次数：必须为 0（事件驱动的新数据片写自己的分片，不写这两个）。F6 验收先例。
- 它在空闲、无新事件时的帧数：必须为 0。运行中的状态段用静态字符，不换帧（F4 2.2、F5 2）。
- 它是否订阅 `ticker`（`frame` 或 `second`）：只有位于视口内的动画或可见的秒级显示才订阅（见下）。
- 它是否注册 keymap layer：挂载时注册一次、带 `enabled` 函数、卸载时注销（F3 关键细节）。

### 计时与动画

- `context/ticker.ts` 是唯一的计时来源，接口三件：
  - `frame`：动画帧，`TICK_MS = 90`，受 `animations_enabled` 控制，关闭时恒为 0；
  - `second`：1 秒信号，与动画开关无关，仅在有订阅者时运行；
  - `at(time, cb)`：一次性到点回调，可取消，内部用单个调度定时器。

  订阅方式沿用 F2 方案 5 的 `subscribe()`；没有订阅者不创建定时器，窗口失焦时 `frame` 暂停。
- 只有 `context/ticker.ts`、`context/frame-clock.ts`（帧对齐回退）和 `terminal-win32.ts`（平台适配，不在渲染路径）允许出现 `setTimeout`/`setInterval`。检查：`grep -rln "setInterval\|setTimeout" packages/tui/src` 只命中这三个文件。新增白名单必须改本规范，并在 PR 里说明理由。组件内计时、自建轮询一律禁止。
- toast 时长、提问倒计时（F3）、已用时间（F4）、PR 的"3 分钟未响应"与"60 秒隐藏"（F6）全部用 `second` 或 `at`。
- P15（空闲 0 帧）在没有任何秒级显示可见时成立；显示秒级耗时的组件只在可见时订阅 `second`。
- 唯一允许的动画：braille spinner 按固定间隔换帧。不用 `TextAttributes.BLINK`，不做按时间改变透明度的循环动画，不留 `createFadeIn`。
- `Spinner` 只在位于视口内时订阅 `frame`。"位于视口内"由行表和视口区间判断，不是"是否挂载"（overscan、末尾行、`streaming` 行都是挂载状态但不一定可见）。

### keymap

- 普通按键不得重新注册 layer。`useBindings(() => …)` 的 accessor 顶层不得读取随按键变化的信号。条件放进 `enabled` 函数，由 keymap 派发时求值。
- 随按键变化的 `enabled` 函数体用 `untrack` 包裹，或只读非响应式值（如 `input.visualCursor.offset`）。
- 禁止对随按键变化的信号用 `reactiveMatcherFromSignal`：`grep -rn "reactiveMatcherFromSignal" packages/tui/src` 为空。
- 快捷键文字在会话级只算一次（`SessionContext.shortcuts`），消息组件里不得调用 `useCommandShortcut`。`/` 命令列表来自一次构建的注册表（带 `version`），不依赖 `useKeymapSelector`。
- 自动补全的各 memo 在 `!store.visible` 时直接返回空数组。

### 消息列表

- 行数 ≥ `WINDOW_MIN_ROWS`（30）时窗口化：视口上下各 `PART_OVERSCAN = 6` 行，末尾 `TAIL_ALWAYS = 4` 行始终挂载，`streaming` 行、选中行、展开中的行始终挂载。未挂载的连续行合并成一个占位盒。
- 行模型是 `Row { key, messageID, partID?, kind, revision }`，`RowKind` 现为 `user | text | reasoning | tool | meta | revert | notice`。
- 新增消息类型必须同时给出：新的 `RowKind`、高度估算、`revision` 的定义（内容变化时重新测量）。现有估算：`text` 按字符数除以内容宽度向上取整加边距，`tool` 2 行，`reasoning` 折叠态 1 行，`user` 按文本行数加内边距，其余 3 行（F2 3.3）。
- 组件内局部状态（展开、选中）一律提升到 `SessionViewState = Map<partID, …>`，卸载后再挂载不丢。滚动定位走行表，不依赖渲染节点。
- 宽度变化使缓存失效；视口上方高度修正用 `scroll.scrollBy(delta)` 保持锚点（照 `patch-diff.tsx`）。向上连续滚动 200 步，锚点漂移 ≤ 1 行（P11）。

### markdown 与高亮

- `TextPart` 的 `streaming` 取 `!isDone()`（`part.time?.end`），不得写死 `streaming={true}`：`grep -n 'streaming={true}' packages/tui/src/routes/session/index.tsx` 为空。
- 流式中内容 > `STREAM_MARKDOWN_MAX`（4KB）渲染纯文本，完成后升级；已完成 > `FINAL_MARKDOWN_MAX`（64KB）保持纯文本。统一用 `AdaptiveMarkdown`，不另写分支。
- 视图只在 `StreamBuffer.version`（每帧至多递增一次）变化时刷新内容；`markdown` 每帧至多解析一次。不对全文 `trim()`。
- 旧代码块首次进入视口才高亮，异步进行，主线程转换分帧，不阻塞帧。

### hover

- 悬停只对可点击元素生效（保持 `clickable() &&`）。
- 悬停只改单个元素的背景色，不经 store，不触发所在行或消息重渲染。
- N 次鼠标移动，帧数 ≤ 悬停状态切换次数 + 1；无悬停元素的区域为 0（P19）。

### CI 门槛位置

- `.azure-pipelines/ci.yml` 的 Linux 任务运行 `bun run bench:tui`（在 `packages/tui` 下）。
- 硬计数项和绝对上限项直接失败；其余耗时项对 `test/perf/baseline.json` 按机器系数比较（初值 1.30 倍）。
- `baseline-f21cabe7f.json` 只作对照，不再更新。更新 `baseline.json` 必须显式 `--update-baseline`，并在 PR 描述写明原因。

## 6. 扩展点的标准做法

### 6.1 新增一个 `/` 命令

必须改的文件：

1. `commands/registry.ts` 的注册处：一个 `CommandSpec`，字段 `id`（同时是 keymap 命令名，如 `session.new`）、`titleKey`、`descriptionKey?`、`category`、`scope`（`home`/`session`/`subagent` 的子集）、`slash?`（`name`、`aliases?`、`args: "none"|"optional"|"required"`、`hint?`）、`enabled?`（函数）、`hidden?`、`source`、`run`。
2. `i18n/zh-CN.ts` 与 `i18n/en.ts`：`titleKey`、`descriptionKey`，新分类还要 `command.category.<id>`。
3. 有默认键位时才改 `config/keybind.ts`（见 6.3）。
4. 服务端命令有已知参数候选时，改 `commands/server-args.ts` 的 `SERVER_COMMAND_ARGS`（先例：`dag-mode`）。

规则：

- `slash.name` 以内置优先；服务端同名命令隐藏并写一条日志。别名只保留通用习惯用法。
- `enabled` 是函数，不触发重新注册。命令列表不依赖 `useKeymapSelector`。
- 子 agent 视图只允许不改子会话、也不向子会话发请求的命令。`scope` 含 `subagent` 的集合是 F5（#1033）3.3 列出的 12 个（`/new`、`/sessions`、`/copy`、`/export`、`/agents`、`/config`、`/theme`、`/status`、`/help`、`/sidebar`、`/dag`、`/exit`）。扩大它需要修订 F5 与本文。
- 必填参数的命令，从命令面板选中时只把 `/名字 ` 填入输入框并聚焦，不直接执行。
- 需要编辑一小段文字的操作（重命名、编辑排队消息）用"回填输入框"：预填文本、状态行显示"正在编辑：… · esc 取消"、`⏎` 提交、`esc` 放弃并恢复原草稿。不新增输入对话框（F3 5.4）。
- 不恢复无斜杠的 `exit`、`quit`、`:q` 退出捷径。
- 已删除的命令名不得回来：`/share`、`/unshare`、`/org`、`/orgs`、`/switch-org`、`/variants`、`/timestamps`、`/thinking`、`/dag-cancel`、`/models`、`/mcps`、`/themes`、`/continue`、`/mo`、`/toggle-timestamps`、`/toggle-thinking`（F3 5.2）。

必须写的测试：`registry.list("home"|"session"|"subagent")` 快照；提交规则用例（内置本地执行、服务端走 `session.command`、未知 `/xxx` 当普通消息）；双语键齐全；子 agent 视图里该命令不可达时 SDK mock 写请求为 0。

### 6.2 新增一个面板

- 只能基于 `PanelShell` 的三个模板之一：`ListPanel`（选择）、`SettingsPanel`（设置行）、`DetailPanel`（只读详情、单行输入、汇总加行表）。需要第四种模板时，先停下提出（F3 5.4 明确不新增）。
- 面板栈最深 3 层；`esc` 返回上一层；`ctrl+c` 关闭全部。打开时保存焦点，关闭时还原，输入框草稿保留。
- 挂载时注册一次带 `enabled` 函数的 layer，卸载时注销；不得因面板开合重新注册全局 layer。面板的数据源只在打开时创建 memo，关闭期间不订阅。
- 按键提示由各模板 `hints` 加 `PanelHost` 通用项生成，key 取自 keymap（`formatKeyBindings`），不写死按键名。
- 单字母动作键只在没有过滤输入框的 `DetailPanel` 里启用。有过滤输入的 `ListPanel` 动作用 `ctrl+<key>`，且不用 leader `ctrl+x`；其标签只用 `tab`/`shift+tab` 切换，`left`/`right` 留给过滤框光标。
- 内容区超过 `maxRows` 在区内滚动；窄终端（< 100 列）先隐藏 `command` 与标签次要信息。警示类用 `tone="warning"` 与 `borderWarning`。
- 破坏性确认、二选一不做面板，用询问区的 `confirm`/`choice` 变体。

必须写的测试：80×24 与 120×40 各一张快照（三段结构位置）；打开、选中、关闭、一个动作；打开关闭后 `registerLayer` 增量不超过 P7 的上限；草稿保留。

### 6.3 新增一个键位

- 只在 `config/keybind.ts` 的 `Definitions` 与 `CommandMap` 登记，两者一一对应；同时在 `config/keybind-disposition.ts` 标 `new`（取值 `keep | change | remove | new`）。
- 命名：`Definitions` 键用 `snake_case`，命令名用点分（先例：`session_dagmode_toggle` 对应 `session.dagmode.toggle`）。
- 同一个键在同一上下文层里只做一件事；跨上下文重用靠"上下文层"区分，不在命令内部写 `if`。
- 页脚、`?` 帮助面板、回执里的按键文字由 keymap 生成，不硬编码键名。`TMUX` 环境变量存在时，抽屉开关显示 `<leader>b`。
- 已删除的键位名不得回来：`sidebar_toggle`、`session_child_cycle(_reverse)`、`session_parent`、`which_key_*`、`tips_toggle`、`plugin_manager`、`plugin_install`、`plugins.toggle`、`dialog.plugins.install`、全部 `dag_*`、`session_share`、`session_unshare`、`docs_open`、`console_org_switch`。检查：`grep -rn "dag_[a-z_]*" packages/tui/src/config/keybind.ts` 为空。
- 输入框不用 `ctrl+b`/`ctrl+f` 移动光标；`ctrl+d` 只在输入框为空时退出。
- `esc` 是优先级链，不得另写长 `if`。每层向 keymap 注册一次带 `enabled` 函数的绑定，位置按 F1 4.5 的顺序：补全 → 抽屉 → 询问区 → 模态面板 → 非模态详情面板 → 子 agent 返回父会话 → 会话忙碌（5 秒内第二次才中断）→ 无动作。层号以 F1 4.5 为准（子 agent 返回第 6 层、会话忙碌第 7 层）。新增一层需要修订 F1 与本文。

必须写的测试：处置表遍历 `Definitions` 无遗漏；同一上下文层内无重复键；`esc` 链每层一条用例；用户覆盖一个绑定后帮助与页脚文字同步变化。

### 6.4 新增状态带行或抽屉区块

状态带（`shell/status-band.tsx`，单文件）：

- 高度 0–2 行，不占用时高度为 0，不留空行。属于根会话；子 agent 视图显示根会话的工作流与目标；home 不显示。
- 窄终端（< 100 列）合并为一行。行的优先级与让位顺序以 F4（#1032）方案 1 和 F6（#1036）2.2 为准：DAG 行行尾先让位的是 `/dag` 提示 → 预算段 → 费用 → 并发段 → 阶段名 → 计数压缩 → 标题截断；进度条与模式标记（≤ 8 列）、非警示 PR 短标记（≤ 14 列）不让位。PR 警示态一定单独占一行，窄终端单行时 PR 警示 > DAG > 目标。
- 只读：点击 DAG 行只打开 `/dag`；点击 PR 行只用系统浏览器打开 URL。
- 无 `setInterval`、无定时拉取；已用时间用 `ticker.second`。
- 新增一行或一类标记时：写出显示条件、颜色 token、窄屏让位位置，并在 F4/F6 对应方案里登记（修订本文）。

抽屉（`shell/drawer.tsx`）：

- 默认隐藏，覆盖在主区右侧 40 列，从顶栏下沿到底区上沿，不盖底区与页脚，不挤压主区（`contentWidth` 不变）。宽 < 60 时整屏只显示"终端太小"，抽屉不设宽度回退分支（已删除 F4 5.1 的"宽 − 4"）。关闭方式：`esc`、点击背景（有文本选区时不关）、再按开关键、`/sidebar`。
- 区块顺序固定：会话、上下文、费用、目标、待办、修改的文件、服务（F4 5.2）。新增区块要写明：位置、数据来源、空状态（隐藏或占位）、是否随子会话变化（上下文、费用、待办、文件跟随子会话；目标始终是根会话；LSP、MCP 全局）。
- 区块是纯展示函数组件。抽屉关闭时不创建任何区块组件、不订阅任何数据。抽屉里不放任何操作按钮。
- 显示策略 kv `drawer_mode`（`hidden` 默认 / `auto` / `always`），不读旧 kv `sidebar`。

必须写的测试：80 与 120 列快照；两种语言 80 列不溢出换行；`ambiguous_width` 为 1 和 2 时 80 列都不溢出（状态带、抽屉）；写请求计数为 0；抽屉关闭时订阅计数为 0。

### 6.5 新增 toast

- 形状：`{ text, level: info|success|warning|error, duration?, onActivate?, dedupeKey? }`。只经页脚右侧的共享位置显示，不自建浮层。`grep -rn "<Toast" packages/tui/src` 只命中页脚一处。
- 页脚右侧是一个共享位置，优先级：leader 待选提示 > toast > hook 执行进度。toast 显示期间替换按键提示；hook 进度（F3 8）也占这个位置，不再放页脚左侧。
- 同时最多显示 1 条，排队最多 3 条，溢出丢最旧的 `info`。
- 相同 `dedupeKey` 10 秒内合并。新增 toast 必须声明自己的 `dedupeKey`。
- `onActivate` 存在时点击触发（如 F5 的"点击进入"）。
- 时长经 `ticker.at`，不得自建计时器。默认 4 秒，`error` 8 秒（F3 9）。
- 变体颜色：`info` 用 `text`，`success` 用 `success`，`warning` 用 `warning`，`error` 用 `error`。
- 超宽错误被截断，完整文本写日志并进 `/status` 的"最近消息"（最近 20 条），页脚附 `… /status`。
- 来源侧的去重规则：预算警告档每会话每档至多一次（F4 7.1）；PR 状态只在事件引起的迁移时弹，快照加载与重连刷新不弹，`cancelled` 不弹（F6 2.4）。
- 服务端 `tui.toast.show` 事件走同一入口。

必须写的测试：页脚位置快照；排队与溢出；`dedupeKey` 合并；`onActivate`；超长截断。

### 6.6 新增设置项

- 在 `/config` 的 `SettingsPanel` 加一行。`SettingRow` 的 `kind` 只有 `choice`、`toggle`、`text`、`action`。选项超过 6 个或为异步数据时用 `action` 推入 `ListPanel`。
- 每一行必须有真实的存储位置，没有存储的行不上线。PR 描述写明这一行的存储位置。
- 存储归属：只属于 TUI 的偏好放 kv（如 `animations_enabled`、`drawer_mode`、`dag_band`、`conceal_code`、`ambiguous_width`）；服务端也要读的放主配置的全局层，经 C1 的"写全局配置"接口落盘（如 `language`、`claudeCompat.hooks`、`dag.mode`、`dag.concurrency`、`dag.budget.tokens`）。项目层写这些键不生效并告警。
- C1 接口未就绪或 schema 缺失时，该行只读显示，不做空壳。
- `text` 行用 `validate` 返回错误文案键（非空则不提交）；`suffix` 用于行尾淡色附注。需要打开前确认的（如 Claude hooks 兼容）先出询问区 `confirm` 变体。
- 界面文字的切换（语言、主题）立即生效；语言只影响默认回复语言这一条系统提示指令。

必须写的测试："每行指出存储位置"遍历测试；C1 接口 mock 不可用时只读；值写入后的读回。

### 6.7 新增预填模板

- 只预填，永不自动提交。文本生成在功能目录（`dag/prefill.ts` 等纯函数），落地动作统一调用 `session/prefill.ts` 的 `prefillRootPrompt(text)`：导航到根会话 → 追加到草稿末尾并另起一行（不覆盖）→ 聚焦输入框 → 不提交。F3、F4、F5 的预填都调用它，不另写落地逻辑。
- 文字经 `t()` 生成，随界面语言变化。
- 模板出现与否只按显示状态筛选（如 `retry` 只对 `failed` 节点），仅为减少无效请求，不是权限判断。是否执行由主 agent 决定。
- 新增一种模板：在 `dag/prefill.ts` 的 `DagRequestKind` 加一个值，并改 `dagRequestKinds`（出现条件）与 `dagRequestText`（文字）；两种语言各补键。非 DAG 用途在对应功能目录新建纯函数，同样经 `prefillRootPrompt`。审阅时核对：`grep -rn "prefillRootPrompt" packages/tui/src` 应命中全部预填调用点，组件里没有直接写输入框内容的预填代码。
- 子会话权限询问的"拒绝并请主 agent 转达"：先回复一次不带说明的 `reject`，再回根会话预填"请转告子 agent <kind · 描述>："。

必须写的测试：出现条件；预填结果与焦点；`session.prompt` 调用为 0；有草稿时追加；两种语言各一份快照。

## 7. 主题与样式

- 只用 token。组件里禁止写颜色字面量。检查：`grep -rnE "#[0-9a-fA-F]{6}\b|RGBA\.from" packages/tui/src --include=*.ts --include=*.tsx | grep -v "^packages/tui/src/theme/"` 为空。主区变暗遮罩的 `RGBA(0,0,0,alpha)`（F1 3.1）是唯一例外，集中在 `shell/` 一处实现。
- 默认主题 `graphagent`（`DEFAULT_THEME` 常量），位于 `theme/assets/graphagent.json`，深浅两版同一个 JSON。不保留 `opencode` 旧主题，读不到已保存主题名时回到 `graphagent`，不迁移旧值。
- 新增 token 的流程（F1 1.2）：`ThemeJson` 里加可选字段 → `theme/index.ts` 的 `resolveTheme` 里给回退值（照 `backgroundMenu`、`selectedListItemText`）→ `Theme` 类型加同名必填字段 → 旧主题不改。`generateSystem` 走回退值，不显式写。`packages/opencode/src/cli/cmd/run/theme.ts` 的重复实现要复用 TUI 的 `resolveTheme` 或补同一组回退值，并有一致性测试。
- 现有可选 token：`textDim`、`backgroundSelected`、`backgroundUser`、`borderWarning`、`logoFace`、`logoAccent`、`logoShadow`、`statusRunning`、`statusQueued`、`statusPaused`。已完成用 `success`（灰），失败用 `error`，不再新增。
- 品牌色 `primary`（深 `#4fa3f0`，浅 `#1f6fc4`）白名单，其余位置一律用灰：
  1. logo 的 AGENT 字面和顶栏小标记的 `◆`。
  2. 输入框提示符 `›`。
  3. 列表、设置、询问里的选中行（符号和文字）及面板标题。
  4. 正在运行的东西：运行中 spinner、DAG 运行段、运行中状态符号（静态）。
  5. 页脚里当前 agent 名。
  6. 页脚 DAG 指示的 `◆ DAG`（开，F1 3.9）。
  7. 状态带行首的 `◆`（F4 1）。

  新增白名单位置需维护者批准，先停下提出。
- 调色板 lint 测试：`graphagent` 中除 `primary`/`accent` 及其派生（`logoAccent`、`statusRunning`）外没有第二个高饱和色相；`success` 为灰。对比度：`text`/`background` ≥ 4.5:1，`textMuted`/`background` ≥ 3:1。
- DAG 状态颜色与字符由纯函数映射（`dag/`），返回 token 名，不返回颜色值；颜色之外还靠字符区分（`━` 完成/失败/运行/暂停，`─` 排队，`╌` 跳过/取消/中止），不只靠颜色（F4 2.2）。
- 输入框光标不闪烁：`<textarea>` 显式传 `cursorStyle={{ style: "block", blinking: false }}`。`grep -rn "BLINK\|createFadeIn" packages/tui/src` 为空。
- 字宽：统一宽度函数是 `ui/width.ts` 的 `cellWidth(text)`，按设置 `ambiguous_width`（kv，`1` 默认 / `2`，在 `/config` 界面标签）计算。
  - 所有布局计算（截断、对齐、让位、列数预算）必须用 `cellWidth`。检查：`grep -rn "Bun.stringWidth" packages/tui/src | grep -v "^packages/tui/src/ui/width.ts"` 为空。
  - 禁止用字符串 `.length` 做宽度。`.length` 无法完整 grep（数组长度也命中）：`grep -nE "\.length" packages/tui/src/shell/status-band.tsx packages/tui/src/shell/pr-line.tsx packages/tui/src/shell/drawer.tsx packages/tui/src/shell/top-bar.tsx packages/tui/src/dag/bar.ts` 的命中项，PR 描述逐个说明不是字符串宽度。
  - 不全局禁用 Ambiguous 字形（`◆ ◇ ● ○ ◎ ━ ─ │ ╭` 等照常使用）。
  - 对齐敏感的布局（状态带、DAG 进度条、PR 行、抽屉、顶栏），在 `ambiguous_width` 为 1 和 2 时都要有 80 列不溢出的测试。
  - PR 行的压缩标记只用 ASCII 与 `✓`、`✗`（Neutral 宽度），两种设置下都不溢出（修订 F6 2.3 的"每个标记 1 列"）。
- 窄屏断点（各 Issue 已定，不自创新断点）：宽 < 60 或高 < 12 只显示"终端太小"；页脚 DAG 指示宽 < 80 只留 `◆`/`◇`；logo 宽 < 90 或高 < 22 退单行小标记；顶栏、状态带、面板在宽 < 100 隐藏次要信息或合并行。

## 8. 文案与双语

- 所有用户可见文字走 `t("key", params)`，包括命令标题与描述、面板标题与按键提示、toast、页脚、状态带、询问区、空状态、预填文字。命令分类等枚举用键，不用中文字面量。
- 不翻译：代码标识符、命令名（`/new`）、键名、`/config` 语言行的选项文字（`简体中文`、`English`）。
- 键名规则：`area.name`，点分，如 `subagent.readonly`、`dagmode.footer.on`、`command.session.new.title`、`error.child_session_read_only`。同一功能的键共用前缀（`dagmode.band.*`、`dagmode.panel.*`、`dagmode.drawer.*`、`dagmode.prefill.*`、`dagmode.budget.*`）。
- `i18n/zh-CN.ts` 与 `i18n/en.ts` 两张表键集合必须完全相同，每个键的占位符集合相同，没有空字符串。一致性测试由 F1 提供；缺任何一个键测试失败。
- 禁止在组件里拼接中文字符串。带变量的文案用占位符，不用字符串拼接。检查：F1 的 AST 扫描测试遍历 `packages/tui/src`（排除 `i18n/`）的字符串字面量与 JSX 文本，不得出现 CJK 字符（注释不计）。
- 按键名放进文案时用 `{key}` 占位，由 keymap 当前绑定填入；后备文本里不含 `{key}`。
- 80 列下两种语言都不得溢出换行。涉及状态带、页脚、顶栏路径、面板的新文案，各补一份 80 列快照。
- 语言来源：主配置 `language: "zh-CN" | "en"`；未配置时由 `resolveLanguage(config, env)` 推断，判断不出回退 `en`。优先级：用户在对话中明确要求的语言 > 配置 > 推断 > `en`。切换语言不需要重启，`t()` 读取语言 signal；已渲染的历史回执随之重新渲染（`renderDagModeReceipt`）。
- 品牌措辞与 B4 一致，品牌词 grep 验收由 F1 定义，审阅时核对。

## 9. 只读原则与安全

只读视图的定义是：TUI 在该视图里没有任何路径产生会改变对应对象的写请求。

- DAG（`/dag` 面板、状态带、抽屉）：不调用任何 `dag.*` 写接口。`grep -rnE "dag\.control|dagControl|dag-cancel" packages/tui/src` 为空；`grep -rn '"message"' packages/tui/src/dag` 为空。测试：在 SDK mock 下完成全部可达操作（选择、展开、`⏎`、`i`、切标签、点击状态带、开关抽屉）后，`dag.*` 写请求与 `session.command` 均为 0。唯一的写入口是主会话视图里 `<leader>d`，它恰好发一次 `session.command`（`/dag-mode on|off`），状态以服务端为准，TUI 不自存模式状态。
- 子 agent 视图（判定口径 `session.parentID != null`）：无 `Prompt`，底区只可能是 `ask` 或 `panel`；不显示 DAG 模式开关；`esc` 不触发中断。测试：触发所有可达操作后，SDK mock 的 `session.prompt`、`session.command`、`session.shell`、`session.abort`、`session.revert`、`session.fork`、`session.summarize`、`session.update` 调用次数均为 0。
- PR 行：点击只调用 `open` 打开 PR URL，不复制、不产生写请求（mock 计数 0）。
- "请主 agent 处理"= 预填主会话输入框，不提交（见 6.7）。任何停止、取消、重试、调超时都只能这样表达。
- 询问区例外：对已存在的待决请求作选择（`permission.reply`、`question.reply`）不算向子 agent 发送对话内容，回复使用请求自己的 `sessionID`。子会话来源的请求只有选项，没有自由文本。TUI 不识别也不过滤 DAG 节点的请求，自动裁决只在服务端做一次，`ask/` 下不得出现 DAG 相关分支：`grep -rniE "dag" packages/tui/src/ask` 为空。
- 远端字符串（PR 检查名、标题、review 文本、服务端错误等）显示前去掉控制字符与 ANSI 转义。F6 现状更严：PR 行不拉取也不显示 PR 标题和检查名称，review 文本服务端用 `safeReview` 净化后，TUI 渲染前再去一次。以后若加标题，必须先去转义。测试：含控制字符的 fixture 经净化后输出无转义序列。
- 不显示凭据。含密钥的输入行（`SettingRow` 的 `text`、`DetailPanel.input`）设 `secret` 字段（F3 接口）；密钥、授权码、令牌不写日志、不进 toast。审阅时核对：新增的输入行是否设了 `secret`，日志与 toast 文案里是否带出了输入值。

## 10. 测试约定

- 命令（`packages/tui` 下）：`bun run typecheck`（`tsgo --noEmit`）、`bun test`、`bun run bench:tui`。涉及 `run` 模式消费点的 PR 另跑 `cd packages/opencode && bun run typecheck && bun test test/cli/cmd/run`。
- 渲染测试用 `testRender`（`@opentui/solid`）。快照尺寸：面板、状态带、抽屉、页脚等组件 80×24 与 120×40；骨架测试 80×24、100×30、140×40；宽 < 60 或高 < 12 断言只渲染"终端太小"。
- SDK 用 `test/fixture/tui-sdk.ts` 的假实现。写请求计数是第一类断言：只读视图断言写请求为 0；有写入口的断言恰好 N 次。
- 时间用 `@opentui/core` 的 `ManualClock` 推进，不用真实睡眠。`grep -n "setTimeout\|sleep" packages/tui/test/perf/scenarios.ts` 为空。
- 帧数用 `CliRenderEvents.FRAME` 或 `getStats().frameCount`；其余计数用 `test/perf/counters.ts`（`registerLayer`、选择器求值、`frames()`、store 写入）。
- 双语：每个新增可见文案至少一个断言在 `zh-CN` 与 `en` 下各取一次；涉及排版的各一份快照。
- 测试文件 `*.test.ts` / `*.test.tsx`，`packages/tui/test/` 镜像 `src/` 路径（`src/dag/bar.ts` → `test/dag/bar.test.ts`）。性能基准在 `test/perf/`（F2a）。依赖方向检查是 `test/architecture.test.ts`。现有 `test/cli/cmd/tui/sync-*.test.tsx` 夹具保持原位。
- 删除旧代码时同步删除或改写对应测试（`test/feature-plugins/`、`test/plugin/`），不留失效用例。

每类改动的最低测试：

| 改动 | 最低测试 |
| --- | --- |
| 新 `/` 命令 | 注册表三范围快照；提交规则；双语键；只读视图写请求 0 |
| 新面板 | 80×24 与 120×40 快照；打开/选中/关闭/一个动作；草稿保留；layer 注册不增加 |
| 新键位 | 处置表遍历；同层无重复键；帮助文字随改键变化；涉及 `esc` 时每层一条用例 |
| 状态带行 / 抽屉区块 | 80/120 列快照；双语不溢出；写请求 0；无 `setInterval`；抽屉关闭时订阅 0 |
| 新服务端事件 | gate 决策；非完整集合会话 store 写入 0；重连刷新；乱序；空闲帧 0 |
| 新消息类型 / 行 | 高度估算；`revision`；窗口化挂载行数；展开状态卸载后保留 |
| 新设置项 | 存储位置遍历；C1 不可用时只读；读回 |
| 新预填模板 | 出现条件；`session.prompt` 为 0；草稿追加；双语 |
| 新 toast | 页脚快照；排队与溢出；`dedupeKey` 合并；截断 |
| 新 token | 遍历 `DEFAULT_THEMES` 均有值；`run/theme.ts` 一致；对比度与调色板 lint |
| 新动画 / 计时 | P15–P19 相关用例；`ticker` 订阅与取消；`ambiguous_width` 为 1 和 2 的 80 列用例（对齐敏感布局） |
| 任何渲染路径改动 | `bun run bench:tui` 对照表附 PR 描述 |

## 11. 禁止事项清单

每条都有检查方式；"审阅"表示按其后内容核对。

- 不新增全局 store 或 context，F1/F2/F3 定义的除外（`FrameClockProvider`、`EventGateProvider`、ticker、`PanelHost`、语言 signal）。审阅：PR 差异里出现新的 `createContext(` 需在描述里说明并经维护者批准。
- 不引入新的 UI 或状态库依赖。审阅：`packages/tui/package.json` 的依赖差异；新增依赖需维护者批准。
- 不在 TUI 里实现任何 DAG 或子 agent 控制。`grep -rnE "dag\.control|dagControl|dag-cancel" packages/tui/src` 为空；`grep -rn "dag_[a-z_]*" packages/tui/src/config/keybind.ts` 为空。
- 不恢复旧插件槽 API。`grep -rn "@opencode-ai/plugin" packages/tui` 为空；`grep -rn "pluginRuntime\|api.slots\|Slot name=" packages/tui/src` 为空；`packages/tui/src/plugin/` 与 `feature-plugins/builtins.ts` 不存在。
- 不加 `plugin` 路由；路由类型只有 `home`、`session`、`diff`；`app.tsx` 不用 `<Show … keyed>` 包 Session。
- 不写颜色字面量（第 7 节 grep）。
- 不在组件内计时：`grep -rln "setInterval\|setTimeout" packages/tui/src` 只命中 `context/ticker.ts`、`context/frame-clock.ts`、`terminal-win32.ts`。
- 不往 `component/` 新增文件：`git diff --diff-filter=A --name-only <基线> -- packages/tui/src/component` 为空。
- 不直接用 `Bun.stringWidth`、不用 `.length` 算宽度（第 7 节）。
- 展示组件与纯函数不调用 SDK（第 3 节 grep）。
- 不用 `reactiveMatcherFromSignal`、不在 `useBindings` accessor 里读随按键变化的信号；`grep -n "cursorVersion" packages/tui/src/component/prompt/index.tsx` 为空。
- 不用旧对话框：`grep -rn "useDialog\|DialogSelect\|DialogConfirm\|DialogAlert\|DialogPrompt\|DialogProvider" packages/tui/src` 为空（F3 迁移完成后）。
- 不复活已下线功能：`grep -rniE "gitlab|opencode-go|go_upsell|console_org|console_state|DialogConsoleOrg|isConsoleManagedProvider|opencode\.ai/zen|\bZen\b" packages/tui/src` 为空。
- 不在渲染路径里做同步 IO。审阅：组件体、`createMemo`、渲染回调、`onLifecyclePass` 里不得出现同步文件读写、同步子进程。
- 不吞错误。错误经 toast 或页脚统一出口显示，超长错误写日志并进 `/status` 最近消息。审阅：新增的 `catch` 不得为空，`.catch(() => {})` 需写明理由。
- 不向子会话产生写请求（第 9 节）。
- 不用 `streaming={true}` 写死、不用 `TextAttributes.BLINK`、不保留 `createFadeIn`、不保留 `<spinner`、`opentui-spinner`：对应 grep 见第 5、7 节，`grep -rn "<spinner\|opentui-spinner" packages/tui/src packages/tui/package.json` 为空。
- 不写硬编码文案、不拼接中文（第 8 节）。
- 不写私有地址、本机路径、内部目录、AI 署名（提交信息、PR 描述、Issue、代码、注释、文档）。检查：`bun run check:hosts`；审阅提交信息与 PR 描述。

## 12. PR 自检清单

F1–F6 以及此后任何触及 `packages/tui` 的 PR，描述里逐条勾选。不适用的写"不适用"和原因，不得删除条目。审阅者对任一未勾选或勾选无依据的条目拒收。

```
- [ ] 范围：改动落在第 2 节目录树内；无自创目录或模式；与 Issue 冲突处已在描述说明（第 1 节）
- [ ] 分层：test/architecture.test.ts 通过；dag/、pr/ 无 Solid import；展示组件未调用 SDK；组件未直接订阅 Worker 事件（第 3 节）
- [ ] 数据流：未在 createEffect 里写 store 做派生；流式文本未进 store；新事件已走五步接入（第 4 节）
- [ ] 渲染预算：已写明 store.message/part 写入=0、空闲帧=0、ticker 订阅、layer 注册（第 5 节）
- [ ] 计时：setInterval/setTimeout 只在 context/ticker.ts、context/frame-clock.ts、terminal-win32.ts；计时用 second/at（第 5 节）
- [ ] 字宽：布局计算用 cellWidth；ambiguous_width 为 1 和 2 的 80 列测试已补（第 7 节）
- [ ] component/ 未新增文件（第 2 节）
- [ ] keymap：普通按键不重注册 layer；新键位只在 config/keybind.ts 与处置表登记；esc 链位置正确（第 5、6.3 节）
- [ ] 窗口化：新消息类型已给 RowKind、高度估算、revision（第 5 节）
- [ ] 扩展点：按第 6 节对应小节的"必须改的文件"逐个改了
- [ ] 主题：无颜色字面量；新 token 已按流程补回退值；品牌色未出现在白名单外（第 7 节）
- [ ] 文案：可见文字全部走 t()；zh-CN 与 en 键集合一致；80 列两种语言不溢出（第 8 节）
- [ ] 只读与安全：只读视图写请求为 0（SDK mock 断言）；远端字符串已去控制字符；无凭据外泄（第 9 节）
- [ ] 测试：已按第 10 节"最低测试"表补齐；快照尺寸齐全
- [ ] 禁止事项：第 11 节的 grep 全部为空
- [ ] cd packages/tui && bun run typecheck 通过
- [ ] cd packages/tui && bun test 通过
- [ ] cd packages/tui && bun run bench:tui（F2a 基准）通过，对照表附描述；渲染路径改动必附
- [ ] bun run check:hosts 通过（S1 #1037 落地后）
- [ ] 涉及 run 模式消费点时：cd packages/opencode && bun run typecheck && bun test test/cli/cmd/run 通过
- [ ] 描述与提交信息无私有地址、本机路径、AI 署名
```

Issue 编号：F1=#886、F2a=#1007、F2=#1025、F3=#1020、F4=#1032、F5=#1033、F6=#1036、C1=#1013、C3=#1023、A4=#1006、W1=#1035、S1=#1037。

## 附录 A：已决定事项（摘要）

- Q1 面板目录为 `panel/`：模板 `shell.tsx`、`list.tsx`、`settings.tsx`、`detail.tsx`，具体面板 `panel/<名>.tsx`；抽屉留在 `shell/drawer.tsx`；功能纯逻辑放 `dag/`、`pr/`。
- Q2 数据层就是 `context/`；读经 `useSync()` 加 `createMemo`；写只在 `routes/`、`panel/`、`ask/`、`commands/` 的事件处理函数里经唯一的 `useSDK()`；重连唯一入口 `onResync(fn)`。
- Q3 保留 `keymap.tsx`、`config/keybind.ts`、`config/keybind-disposition.ts`，不建 `keymap/`。
- Q4 `context/ticker.ts`（F1 实现，F2 迁移现有动画）提供 `frame`、`second`、`at(time, cb)`；`setTimeout`/`setInterval` 只允许出现在 `ticker.ts`、`frame-clock.ts`、`terminal-win32.ts`。
- Q5 页脚右侧一个共享位置，优先级 leader 提示 > toast > hook 进度。
- Q6 `esc` 链层号以 F1 4.5 为准。
- Q7 品牌色白名单扩为 7 项，新增页脚 `◆ DAG` 与状态带行首 `◆`。
- Q8 `ui/width.ts` 的 `cellWidth(text)` 按 `ambiguous_width`（1 默认 / 2）计算；对齐敏感布局两种设置下 80 列都不溢出；PR 压缩标记只用 ASCII 与 `✓`、`✗`。
- Q9 预填文本在功能目录生成，落地统一经 `session/prefill.ts` 的 `prefillRootPrompt(text)`。
- Q10 骨架补 `ask/`、`session/`、`attention/`、`context/`；`component/` 冻结。
- Q11 toast 形状 `{ text, level, duration?, onActivate?, dedupeKey? }`，最多显示 1 条、排队 3 条，同 `dedupeKey` 10 秒内合并，时长经 `ticker.at`。
- Q12 `test/` 镜像 `src/` 路径，基准在 `test/perf/`。
- Q13 删除 F4 5.1 的"宽 < 60 取 宽 − 4"分支。
- 依赖方向检查定名 `script/check-tui-imports.ts`，以 `test/architecture.test.ts` 在 `bun test` 里运行，由 F1 落地。
