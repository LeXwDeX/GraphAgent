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
- 第 2 节目录树和第 3 节分层描述 F1（#886）合并后的现状：已存在的目录和文件照实列出，尚未落地的逐项标注所属 Issue（F4 #1032、F5 #1033、F6 #1036）。新代码按这棵树放置，标为"未落地"的文件由所属 Issue 新建。
- 技术栈固定：opentui（`@opentui/core`、`@opentui/solid`、`@opentui/keymap`）加 Solid；server 在 Worker，SDK 的 fetch 经 `postMessage`（Worker RPC）。不换渲染框架（F2 #1025 "不做"）。
- 公开仓库：本文与代码、注释、文案、提交信息不写本机路径、内网地址、主机名、AI 署名。提交前运行 `bun run check:hosts`。

## 2. 目录结构（现状）

```
packages/tui/src/
  app.tsx               # provider 树与 AppFrame 装配（F1 3.3）
  shell/                # 骨架（F1）：app-frame、top-bar、footer（及 footer-status、dag-indicator、hook-progress）、
                        #   drawer（开关与浮层容器）、status-band（槽位，F4 的 DAG 行与目标行，F6 的 PR 行与提醒行，#1618 的信任行）；bottom-zone（F3）；
                        #   subagent-path（子 agent 视图的顶栏路径与溢出折叠，F5；后台运行的标签见 6.4 的“子 agent 视图的后台标签”，#1058）；
                        #   pr-line.tsx（F6：PR 行、提醒行与状态带选行的纯布局函数）；
                        #   trust-line.ts（#1618：状态带信任警示行的纯布局，加上它数的条数）；
                        #   background-mark.ts（#1058：状态带的后台标记与后台行的纯布局，状态带与抽屉共用其中的后台运行计数与命名）；
                        #   pr-tracker.ts、pr-tracker-context.tsx（F6：PR 与提醒的跟踪，状态带只经后者读它）
  panel/                # 面板模板与具体面板（F3）：
                        #   shell.tsx（PanelShell）、list.tsx、settings.tsx、detail.tsx、host.tsx（PanelHost）
                        #   具体面板 panel/<名>.tsx，如 panel/sessions.tsx；panel/dag.tsx（F4 已落地）、panel/agents.tsx（/agents，F5 已落地）
  ask/                  # ask-queue.ts：询问区队列；local.tsx、local-ask.tsx：confirm/choice（F3）
  commands/             # registry.ts、server-args.ts（另有 catalog.ts、context.tsx、palette.ts）：/ 命令注册表（F3）；
                        #   命令 run 回调可经 useSDK() 发写请求
  config/               # keybind.ts、keybind-disposition.ts：键位唯一来源（F1 4）；index.tsx：TUI 配置 provider
  keymap.tsx            # keymap 注册与 hooks（保留，不建 keymap/ 目录）
  context/              # 数据层与 provider
                        #   sync.tsx（store、onResync）、event.ts、event-gate.ts、frame-clock.ts、stream-buffer.ts、
                        #   interest.ts（interest 聚合器）、session-summary.ts、session-destination.tsx（首页新会话的目标目录）、
                        #   ticker.ts、sdk.tsx、route.tsx、theme.tsx …
  routes/               # home.tsx（及 home/）、session/、diff/
                        #   session/index.tsx 的 Main 按 `role` 区分主会话与子 agent 视图（子 agent 视图内容 F5 未落地）；
                        #   同目录还有 rows.ts、fold.ts（什么可折叠的纯判定）、expand.ts（ctrl+o 选块）、tool-row.tsx（工具调用行 `ToolRow` 的纯展示组件，#1614）、result-card.ts（后台结果卡的版面纯函数）、reasoning-line.ts（推理行的文字与时长的纯函数，#1615）、permission.tsx、question.tsx、ask-surface.tsx、drawer.tsx（抽屉区块）…
  session/              # 会话级辅助：prefill.ts、siblings.ts（同级排序）、navigate.ts（进入子 agent、失效回父）、
                        #   subagents.ts（子 agent 的 kind、描述、状态标记、/agents 的行模型与分组序等纯函数，顶栏、面板与同级键共用，F5、#1058）
                        #   subagent-record.ts（子 agent 记录的任务块与结束行的判定和文字）
                        #   background.ts（后台 Task 的状态与耗时的纯函数：状态取值 结果 > job > 摘要，#1058；排队与开始运行的时刻由服务端的 job 状态给出，旧服务端退回推断，#1407）
                        #   background-card.ts（后台结果卡的纯函数：只按 part 的 metadata 认结果，取正文、首行与标题，#1058）
                        #   synthetic-message.ts（用户消息是否合成的纯判定，撤销、最近用户消息与 PR 跟踪共用，#1408）
  attention/            # index.ts、notify.ts（F1 已迁入）；F5 补子 agent 提醒
  dag/                  # model.ts、waves.ts：纯函数（F1 已迁入）；bar.ts、prefill.ts、mode.ts（DAG 模式的预算档位与用量）、fold.ts（dagFold：展开槽的可见行，#1158）（F4 已落地）
  pr/                   # state.ts：prLineState、短标记、toast 与警示清除的纯函数；reminder.ts：提醒倒计时的纯函数（F6）
  theme/                # index.ts、schema.ts、assets/graphagent.json（F1 1）
  i18n/                 # index.ts（t()）、zh-CN.ts、en.ts、receipt.ts（F1 3.6、3.9）
  ui/                   # 无状态基础组件：border.ts、link.tsx、width.ts（cellWidth）、toast.tsx、adaptive-markdown.tsx
  prompt/               # 存量：输入框的数据辅助（display、history、frecency、stash、part、queued-message、traits）；不在第 3 节依赖表内
  component/            # 冻结：不得新增文件；现有组件随各 F Issue 迁出到 ui/、panel/、shell/
  util/
packages/tui/test/      # 镜像 src/ 路径（src/dag/model.ts → test/dag/model.test.ts）
  perf/                 # F2a 基准框架（F2a 方案 1）
  architecture.test.ts  # 依赖方向检查，调用 script/check-tui-imports.ts（F1）
  source-guards.test.ts # 源码文本守卫（第 10 节）
  i18n/                 # 文案表、硬编码文案、品牌词与已下线功能、英文文案棘轮的测试
  preload.ts            # 测试进程的隔离：HOME 与 XDG 数据目录指到临时目录（bunfig.toml 的 [test] preload，第 10 节）
packages/tui/script/    # check-tui-imports.ts、check-tui-text.ts、english-text-baseline.txt
```

目录职责（一句话）与落地 Issue：

- `shell/`：整屏固定列布局的各区域组件。F1 已落骨架（`app-frame`、`top-bar`、`footer`、`drawer`、`status-band` 槽位），F3 已落 `bottom-zone`；F5 已落 `subagent-path`（子 agent 视图顶栏路径的纯布局函数，顶栏与页脚的子 agent 分支用它）；状态带的 DAG 行与目标行已落地（F4 PR2，#1032），PR 行、提醒行与它们的纯布局 `pr-line.tsx` 已落地（F6，#1036），信任行与它的纯布局 `trust-line.ts` 已落地（#1618）。`pr-tracker.ts` 是 PR 与提醒的跟踪（交接判断、警示保留、`ticker.at` 一次性回调、toast 都在这里），`pr-tracker-context.tsx` 是状态带读它的只读接口；状态带只排版 tracker 给出的结果。
  - 输入框（`Prompt`）画在 `bottom-zone` 的输入框槽里：主区 → 状态带槽 → 输入框 → 页脚，抽屉只覆盖主区（F4 PR0，#1032）。`home`、`session` 路由在 setup 里调用 `useBottomZoneOptional()?.setComposer({ render })` 装入自己的 `Prompt`（草稿、提交、焦点的接线仍留在路由里），卸载时调用返回的撤销函数（只撤销自己装的那一份）。`render` 在槽里创建，不在路由的 provider 树里，只能读到应用级 context；路由自己提供的（会话的 `LocationProvider`，`@` 文件搜索靠它定位目录）要在 `render` 里重新提供。
  - 输入框的外形与高度（#1616）：一个圆角框，框内左边是宽 2 的 `›` 列（独立 `<text>`，shell 模式为 `$`），右边是 textarea。textarea 高 = 折行后的行数（按显示宽度），下限 1，上限 `prompt.max_height`（默认 `max(6, floor(终端高 / 3))`，随终端高度变化）；框高 = textarea 高 + 2（上下边框），空闲时 3 行。到上限后框不再增高，textarea 内部滚动；`›` 固定在框的第一行，续行与首行文字左对齐。`editing()` 的状态行画在框内最上面，另占 1 行，不计入上限（框高 = textarea 高 + 3）。`test/prompt/composer-height.test.tsx` 固定这些数字，改规则要同时改它。
  - `AppFrame` 的 `statusBand`、`bottomZone`、`drawer` 经 `Slot` 只构造一次：直接写 `<Show when={props.x}>{props.x}</Show>` 会把 prop 里的 JSX 构造两次，多出来的一份不上屏却一直在跑（面板、输入框、key layer 都会重复）。
- `panel/`：面板底板 `PanelShell` 与三个模板，加 `PanelHost`（栈式，已替代 `DialogProvider`），以及各具体面板，均已落地（F3）。功能的纯逻辑放功能目录（`dag/`、`pr/`），不放 `panel/`；`/dag` 面板 `panel/dag.tsx` 已落地（F4），`/agents` 面板 `panel/agents.tsx` 已落地（F5，只读数据层已有的会话、`taskIndex`、作业状态与摘要，打开时不加载子会话）。
  - `ListPanel` 的选中按条目 `id` 记，不按下标：条目换位，或 `group` getter 随数据换组，选中都跟着条目走；选中的条目消失时选中留在原下标（截到列表末尾），那个位置上的条目从此是被选中的。没传 `selectionKey` 的列表保持原样：`items` 一变，选中回到 `current` 或第一项。传了 `selectionKey` 的列表（自己筛选条目的所有者，如 `/agents`，传它筛选用的文字）`items` 变化不重置选中，只在 `selectionKey` 变化（模板自己过滤的列表还包括模板的过滤文字变化）时回到 `current` 或第一项。
  - `/agents` 的分组（#1058 6）：列表是根会话的直接子会话，分三组，空组不显示组头。顺序固定：后台（后台运行中，其次排队，其次状态未知）→ 前台（仍在运行的前台子 agent）→ 已结束（其余：后台完成、失败、已中断、已取消，前台完成、失败，以及状态未知的前台会话，它们不被说成在运行）；组内按开始时间倒序，同刻按 id 升序。分组、排序、行模型都在 `session/subagents.ts`（`subagentRows`），面板只排版；组头走 `ListItem.group`，且是随行状态变化的 getter。默认选中第一行，所以有后台运行中的子 agent 时落在其中最新的那一个（运行中排在排队之前），状态带的点击靠这一点。选中按子 agent 的 id 记：某个子 agent 的状态迁移让顺序变了（换组、换位），选中仍在原来那个子 agent 上，`⏎`、`ctrl+r` 作用于它；选中的子 agent 消失（会话被删）时选中留在原位置（截到末行）；只有用户改过滤文字才回到第一行（`/agents` 把过滤文字作为 `selectionKey` 交给 `ListPanel`）；只是状态词或耗时变了同样不动选中。
  - 列：状态符号（● 运行、○ 排队、✓ 完成、✗ 失败、已中断、已取消；排队用 `statusQueued`，状态未知不画符号）、`kind · 描述`、发起者（`background.row.byUser`/`byAgent`；没有 Task 链接的会话，如 DAG 节点，是 `—`）、状态文字 · 工具次数 · 耗时。后台运行的状态取 `backgroundStatus`，其词沿用 `subagent.state.*`，只有排队、已中断、已取消用 `background.agents.status.*`；排队的运行没有耗时（`—`，不读时钟），运行中的后台运行的耗时从服务端报的开始运行时刻（job 状态的 `since`，不含排队）起算，没有时取 Task 调用的开始时刻（续跑的任务会话很老），已上报结果的取结果里开始运行到结束之差，没有开始运行时刻时取起止之差；行的排序仍按 Task 调用的开始时刻；F5 的冷启动规则（`—`、不说 0）不变。发起者与状态两列各按本列最宽的一行对齐，名称取剩余宽度，80 列下 `ambiguous_width` 为 1 和 2 都不溢出。
  - 标题区计数 `N · a 个后台运行 · q 个排队`（`background.agents.count`、`.count.running`、`.count.queued` 三个键，为 0 的段省略，`a`、`q` 只数状态已知的后台运行）：标题是 JSX（`ListPanelProps.title` 接受 JSX），计数用 `textMuted`，按标题行剩余宽度截断；没有子 agent 时不画计数。
  - 选中行下方的详情（`ListItem.description` 可以是多行；`ListPanel` 把每一项的行与详情包在同一个列里，滚动到该项时详情一并进入视口，不会被裁掉）：第一行是委托 prompt；已有结果上报的后台运行再加一行 `结果：{首行} · 结果已回注`，首行取根会话已加载的结果消息里 `<task_result>`/`<task_error>` 之间的第一个非空行（`backgroundResultLine`），消息没加载时不猜，只写 `结果已回注`；已中断而没有结果上报的写 `未回注（已中断）`。运行中、排队、前台和其余状态没有这一行。
  - `ctrl+r`（`subagent.relay`）仍是唯一动作，预填按选中行的状态选模板（`subagentRelayText`，只预填不发送，经 `prefillRootPrompt`）：后台运行中或排队 `background.prefill.cancel`（带 `task_id`，让主 agent 用 task 工具的 cancel）；后台完成 `background.prefill.continue`；后台失败、已中断、已取消 `background.prefill.retry`（原因取子会话摘要错误的第一行，没有则用状态词）；前台与状态未知的后台沿用 F5 的 `subagent.relay.prefill`。没有停止、重试等控制键；`⏎` 进入、`esc` 关闭不变。
- `ask/`：权限、提问、`confirm`、`choice` 的队列（F3）。权限与提问的展示组件在 `routes/session/`（`permission.tsx`、`question.tsx`），经 `ask-surface.tsx` 汇入队列；`confirm`、`choice` 的展示组件在 `ask/local.tsx`，调用入口 `askConfirm`、`askChoice` 在 `ask/local-ask.tsx`。
- `commands/`：内置与服务端命令的统一注册表（F3）。
- `config/`：键位 `Definitions`、`CommandMap` 与处置表（F1）。
- `context/`：provider 与数据层。F1 已新增 `event-gate`、`frame-clock`、`stream-buffer`、`interest`、`ticker`（计时唯一来源，`frame`/`second`/`at`）；现有动画与秒级显示均经 `ticker`，由 `test/source-guards.test.ts` 守住（第 5 节）。
- `routes/`：`home`、`session`（`role` 不是 `root` 的会话渲染为子 agent 视图，内容 F5 未落地）、`diff`。F1、F5。
  - Task 行（`routes/session/index.tsx` 的 `Task`，#1058、#1614）：用 `ToolRow` 画成两行块。第一行 `⏺ Task {kind} · {描述}`：`kind` 与描述取 `session/subagents.ts` 的 `subagentKind`、`subagentDescription`（小写原样，和 `/agents`、顶栏同一实现，子会话还没进会话列表时读 Task 调用的 `subagent_type` 与 `description`）；发起者与前后台标签（`formatSubagentTags`，读 `taskIndex[child]`，没有链接时读 Task part 的 metadata）靠右，`textDim`，宽度不够时先于标题整段不画，标题不为它截断。第二行 `⎿ {状态词} · {N 次工具调用} · {时长}`：后台运行的状态行由 `backgroundStatus` 决定，每个状态一条固定文案（`formatBackgroundStatus`）和一个颜色 token（`BACKGROUND_COLOR`，圆点与状态行同色），`unknown` 与前台行一样；前台行运行中 `primary`、完成 `success`、失败 `error`，文案全部走 `t()`，键在 `subagent.row.*`，后台行的键在 `background.row.*`；圆点是运行中的 braille spinner（只在视口内订阅 `frame`），其余是静态 `⏺`。已结束的行耗时是结果上报的开始运行到结束之差（没有开始运行时刻时取起止之差），不读时钟；运行中的行从服务端报的开始运行时刻起算（#1407），前台运行中的行从 Task 调用开始起算。行尾 `进入`（`background.row.enter`，`textMuted`，指针在行上时 `text`）与整行是同一个点击，经 `openSubAgent`，不发请求；前台运行中的行（Task part 仍在运行且不是后台）在状态后接 `转后台 {键}`（`background.hint.move`，`textDim`，键取 `session.background` 的当前绑定，没有绑定时整段不画），后台运行与已结束的行没有。消息尾部没有提示行：原来的 `ctrl+x down 查看子 agent · ctrl+x w 转后台` 一行（`AssistantTaskHint`）与键 `background.hint.view` 已随 #1615 删去，进入子 agent 靠这一行的 `进入`、`/agents` 与顶栏，转后台靠这一行自己。调用本身失败的行没有 `进入`，点击展开错误（`errorExpanded`）。`TaskRead`、`TaskCancel`（`action` 为 `read`、`cancel`）是单行 `⏺ Task {background.row.readCall | cancelCall}`，没有结果行；等待授权、被拒绝、失败时才在其下补一行状态，点击进入目标任务的子 agent（失败的调用点击展开错误）。
  - 后台结果卡（`routes/session/index.tsx` 的 `BackgroundResultCard`，#1058）：运行结束后服务端加进会话的那条用户消息（文本 part 带 `metadata.backgroundResult`）画成一张卡，不再随合成文本隐藏；窗口化与非窗口化两条路径都画。只有 metadata 认卡，文本里写了 `<task_result>` 不算，命令留给模型的 “Summarize…” 等没有 metadata 的合成文本仍不出行。折叠态两行（标题行带状态与耗时，首行预览加提示），`ctrl+o` 展开全文（与助手文本同一个 `AdaptiveMarkdown`），点击进入子 agent（`openSubAgent`，不发请求）；提示里的键名取 `view.expand.toggle` 的当前绑定（`ctx.shortcuts.expand`）。文案键在 `background.card.*`。这条消息仍是合成文本：消息跳转、最近用户消息、撤销与重做（只在用户写的消息之间走：撤销的目标不选它，回填也不含它的文字，重做不停在它上，一次重做把撤销带走的结果消息一并恢复，撤销横幅的“N message reverted”也只数用户写的消息；位于撤销目标之后的结果消息随服务端 revert 一并撤掉，#1408）、`panel/message`、`panel/fork`、`panel/timeline`、排队消息与 PR 跟踪继续把它排除在用户的话之外；`/copy`、`/export` 把卡写成 `### 标题` 加正文。
  - 会话路由的跳转（#1058 7）：`SessionRoute.messageID` 是一次性的跳转请求，点后台运行结果的 toast 时由 `app.tsx` 的 `openResult` 带上。`routes/session/index.tsx` 等该会话的激活结束（激活以滚到末尾收尾，跳转要排在它之后；路由带 `messageID` 时，切换会话排的 50 ms 滚到底也不排）再滚到那条消息（每次切换会话先清掉“已激活”，所以回到之前看过的会话时，跳转等的是这一次的激活）：窗口化的转录走行表（`scrollToMessageID`），未窗口化的转录按节点 id（用户消息、任务块与后台结果卡有，结果卡的 id 是它所在消息的 id）；所以点 toast 落在结果卡上。画不出来的消息（没有 `backgroundResult` 的 synthetic 文字不成行）没有位置，跳到转录末尾。滚完就把 `messageID` 从路由上摘掉（`navigate` 时不带它），所以再次请求同一条消息会再滚一次；不设定时器，由激活完成的信号和 `messageID` 的变化触发。
- `dag/`、`pr/`：无 I/O 的纯函数。`dag/` 已有 `model.ts`、`waves.ts`、`bar.ts`、`prefill.ts`、`fold.ts`（`dagFold`：由节点的 `expanded_from`、波次和已展开的槽算出工作流的可见行顺序，见 6.4）；`pr/` 已有 `state.ts`、`reminder.ts`（F6）。`dag/` 不得 import `ui/`，所以 `bar.ts` 自带进度条字形的字宽（`━ ─` 为 Ambiguous，`╌` 为 Neutral），`test/dag/bar.test.ts` 用 `cellWidth` 逐条核对。
- `theme/`：token 表、`resolveTheme`、主题 JSON（F1）。
- `i18n/`：双语文案表与 `t()`（F1）。
- `session/`：会话级辅助函数：预填 `prefill.ts`；同级排序 `siblings.ts`（`(time.created, id)` 升序，是创建序的基础排序）；子 agent 的 `i/N`、`←→`、`<leader>down` 与 `/agents` 共用 `subagents.ts` 的分组序（`subagentChildren`、`subagentSiblings`，顺序随子 agent 的状态变化，`←→` 因此按列表从上到下走）；导航 `navigate.ts`（`openSubAgent` 是进入子 agent 的唯一入口，`returnToParent` 处理子会话失效）；子 agent 的 `kind`、描述、状态标记（符号与颜色 token）和 `/agents` 的行模型、分组序、详情与预填文字 `subagents.ts`（顶栏、面板、同级键、提醒共用的唯一实现；`subagentSource(sync.data)` 把 Task 链接、作业状态与摘要三处接成行的来源）；记录 `subagent-record.ts`（子 agent 记录开头的任务块取哪条消息的文字、结束后那一行的状态与文字；结束状态与顶栏标记同源 `subagentMarker`，会话自己的状态未知时才看父会话的前台 Task 调用）；后台结果卡 `background-card.ts`（`backgroundCard(part, kind?)` 认出结果、取 `<task_result>`/`<task_error>` 里的正文与首行，不信文本、只认 metadata；`backgroundCardTitle` 出标题行的字，`/copy` 与卡共用）；后台 Task 的状态 `background.ts`（`backgroundStatus` 按“服务端上报的结果 > 运行所属 job 的状态 > 子会话摘要”取值，先匹配者胜，后来的来源不改写先来的；排队由服务端上报：job 的 `queued` 就是排队，带 `since` 的 `running` 就是已占到槽、在运行；只有旧服务端（从不报 `queued`，它的 `running` 也不带 `since`）才退回推断：job 在跑而子会话没跑过一轮、没调过工具即排队，详见下面“后台运行的排队”（#1407）；三处都没有说法时为 `unknown`。`backgroundElapsed` 对运行中的运行取 `now` 减去服务端报的开始运行时刻（没有时取 `startedAt`），对排队中的取 `now - startedAt`（已等了多久，界面不显示），对已结束的取结果里开始运行到结束之差（没有开始运行时刻时取起止之差），不知道时返回空，不取负值）；合成消息 `synthetic-message.ts`（`isSyntheticMessage(parts)`：有文本且全部文本 part 都是 `synthetic` 的用户消息不是用户的话，没有文本 part 的消息（文件、压缩）不算合成；撤销的目标（最近一条不合成的用户消息，没有则不动作）、重做的下一站（之后第一条不合成的用户消息，没有则整体恢复）、`session.messages_last_user` 与 PR 跟踪的 `dismissContext` 共用这一个判定，不各写一份，#1408）。
- `attention/`：提醒与注意力上报。F1 已迁入 `index.ts` 与 `notify.ts`，F5 补子 agent 提醒：权限请求（任何运行方式）和后台运行的结果到达（#1058 7，见 6.5）；前台子 agent 的结束不弹 toast，子 agent 结束的声音与系统通知（`agent_completed`）不变。
- `ui/`：无状态展示件，不访问数据；含统一宽度函数 `width.ts`。
- `prompt/`：存量目录，放输入框的数据辅助（展示文本、历史、frecency、暂存、part、排队消息、特性），不在第 3 节依赖表内。
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

| 目录                                                                            | 不得 import                                                                                  | 检查                                                                                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ui/`                                                                           | 数据层（`sync`、`sdk`、`event-gate` 等）、`shell/`、`panel/`、`ask/`、`commands/`、`routes/` | 依赖方向检查                                                                                              |
| `dag/`、`pr/`                                                                   | `solid-js`、`@opentui/solid`、`context/*`、数据层                                            | `grep -rn -e "solid-js" -e "@opentui/solid" -e "/context/" packages/tui/src/dag packages/tui/src/pr` 为空 |
| `theme/`、`i18n/`                                                               | 数据层、组件目录                                                                             | 依赖方向检查                                                                                              |
| 数据层                                                                          | `ui/`、`shell/`、`panel/`、`ask/`、`commands/`、`routes/`                                    | 依赖方向检查                                                                                              |
| `shell/`、`panel/`、`ask/`、`commands/`、`session/`、`attention/`、`component/` | `routes/`                                                                                    | 依赖方向检查                                                                                              |

- `ui/` 可以读主题 token（现状先例：`ui/toast.tsx` 用 `useTheme`），文字由调用方经 props 传入。
- 依赖方向检查：脚本 `script/check-tui-imports.ts`，遍历 `packages/tui/src` 的 import，按上表判错。它在 `packages/tui` 的 `bun test` 里以 `test/architecture.test.ts` 运行（CI 必跑），改上表规则必须同时改脚本与本文。脚本的 `EXEMPTIONS` 登记存量违规，F1 收口（#886 验收 34）时已清空，`test/architecture.test.ts` 断言它为空：新代码按依赖方向改 import，不得新增条目。机制保留，供用合成目录树的测试使用，过期条目仍会让测试失败。
  - 数据层不能 import `ui/`。需要提示时由上层注入回调：先例是 `LocalProvider` 的 `notify` 属性，`app.tsx` 里的 `LocalWithToast` 把它接成 toast；`SDKProvider` 的 `onChildSessionReadOnly`（服务端以 409 `ChildSessionReadOnlyError` 拒绝写向子会话时，由 SDK 的 `fetch` 包装调用，#1618）同样由 `app.tsx` 里的 `SDKWithToast` 接成 toast，`context/sdk.tsx` 不 import `ui/`。`script/check-tui-text.ts` 的英文字面量棘轮把 `notify({ text })` 与 `toast.show({ text })` 同样计入，改走回调不会让文案从棘轮里消失。
  - 数据层的状态模块放 `context/`，不放 `routes/`：先例是首页新会话目标目录 `context/session-destination.tsx`，路由、`component/` 与 `app.tsx` 都从那里读。
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
- 重连：唯一入口是 `context/sync.tsx` 提供的 `onResync(fn)` 注册表；F4、F6 等功能注册各自的刷新函数，不自建重连监听。`reconnected` 后所有 `hydrated` 会话重新 `sync`，buffer 清空，已加载会话的摘要由快照重建；其余数据片（`dag` 汇总、`goal`、`pr_watch`、`reminder`、`dagNodes`、`dagMode`、`usage`、`overhead`）各自全量刷新（`dag` 汇总与 `dagMode` 在同一个刷新里读完，之后路由的根还缺快照而需要时补取；`dagRunning` 没有读口，由这两处读取带回）。快照加载与重连刷新不得触发 toast（F6 2.4）。新增数据片必须在同一 PR 里向 `onResync` 注册刷新函数；只存在客户端内存、服务端没有读口的片除外，如 `dag_focus`（用户在 `/dag` 面板里选过、打开过的工作流，按根会话记，会话删除时清掉），没有可刷新的东西。
- 禁止轮询 DAG 节点或 PR 状态。拉取触发点只有：首次需要、`resync`、`graphRev` 跳变、重连（F4 2.1）。
- `usage` 片（#1475，`GET /session/:id/usage`，按根会话记整棵任务树的 token 分项与费用）只读被 watch 的根：`sync.usage.watch(rootID)` 把该根的引用计数加 1 并读一次，返回的函数放手（归零即不再读）。刷新只有三个触发点，且都要求该根的计数大于 0：`usage.watch` 本身、该树内任一会话的 `session.turn.settled`（经 `rootOf` 沿 `store.session` 的父链上溯到根）、`onResync`（读全部被 watch 的根）；读取期间再触发的根只记一笔，读完再读一次，所以一阵触发只多读一次。失败写 `TuiLog` 并保留旧值；`session.deleted` 清掉该会话的读取、计数与数据。没有 watch 的根不产生读取，普通会话、首页与抽屉关闭时的 `/usage` 请求数为 0。
- `overhead` 片（#1461，`GET /session/:id/overhead`，按被 watch 的会话记它最近一次请求除消息外携带的内容：每个来源的字节、估算 token 与哈希，以及模型的窗口、来源与占比）只读被 watch 的会话，键是会话自己，不上溯到根，子 agent 视图读的是子会话自己的：`sync.overhead.watch(sessionID)` 把该会话的引用计数加 1 并读一次，返回的函数放手（归零即不再读）。刷新只有三个触发点，且都要求该会话的计数大于 0：`overhead.watch` 本身、该会话自己的 `session.turn.settled`（服务端在回合里逐步记录，回合结束时读到的是最后一步；树里别的会话的回合不触发）、`onResync`（读全部被 watch 的会话）；读取期间再触发的会话只记一笔，读完再读一次。失败写 `TuiLog` 并保留旧值；`session.deleted` 清掉该会话的读取、计数与数据。没有 watch 的会话不产生读取，普通会话、首页与抽屉关闭时的 `/overhead` 请求数为 0。这一片没有事件：告警走服务端的 `tui.toast.show`（见 6.5）。

### 新增一种服务端事件的接入步骤

1. manifest 登记：在 `packages/schema/src/event-manifest.ts` 登记事件，并在 C1 5.6 的分级表登记范围。`pr.watch.updated`（F6 1.2）是先例：`session-summary`，非 durable。
2. EventGate 分类：在 `scopeOf` 里归入 `global`、`session-summary`、`session-full` 之一。归 `session-summary` 的事件体积必须小。
3. store 分片：按 `sessionID` 或实体 ID 建键，用 `reconcile` 写入。写入点集中在 `sync.tsx` 的事件分支，不在组件里。
4. selector：组件只读 `createMemo` 派生值。同时写出重连刷新逻辑。
5. 测试：gate 决策用例；非完整集合会话的 `store.message`/`store.part` 写入为 0；乱序或重连用例（扩展 `test/cli/cmd/tui/sync-*.test.tsx` 夹具）；无新事件时帧数为 0。

## 5. 渲染预算与性能红线

数字来自 F2（#1025）方案 7.4 的"目标"列和 F2a（#1007）基准。机器无关的计数标"硬"，直接失败。

| 红线                                              | 要求                                                                                                                                      | 检查（F2a 场景）                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 空闲                                              | 无运行中的会话、无新事件时渲染帧数为 0（硬）                                                                                              | P15、P15b、P15c、P15d                           |
| 忙碌                                              | spinner 在屏内时 ≤ `2 × 1000 / TICK_MS + 2` 帧 / 2 秒（硬）                                                                               | P16                                             |
| 屏外 spinner                                      | 消息区 spinner 全部滚出视口时，帧数与屏外个数无关（硬）；底区被面板或询问区占用时为 0（硬）                                               | P17、P17b                                       |
| 失焦、空白区鼠标                                  | 窗口 `blur` 且忙碌 0 帧；无悬停元素的区域移动鼠标 0 帧（硬）                                                                              | P18、P19                                        |
| layer 注册                                        | 连续输入 50 个普通字符 `registerLayer` 为 0（硬）；`/` 序列整体 ≤ 2（打开一次、关闭一次）（硬）                                           | P3、P7                                          |
| selector 求值                                     | 每次按键的 keymap 选择器求值次数，S 档与 L 档相同（硬）                                                                                   | P4                                              |
| store 写入                                        | 流式 delta 对 `store.part` 写入为 0；每帧对 `store.message`/`store.part` 写入 ≤ 1（硬）                                                   | P13                                             |
| 流式一帧的读文本                                  | 一帧流式输出只读正在写入的那条 part 的文本，次数与会话长度无关（硬）；窗口化会话的流式 p95 ≤ 2 × L 档（附 2 ms 噪声下限，随机器系数放宽） | `test/routes/session/stream-cost.test.tsx`、P12 |
| 干扰                                              | 非当前会话对 `store.message`/`store.part` 写入为 0（硬）；主会话输入 p95 增幅 ≤ 10%                                                       | P14                                             |
| 挂载行数（仅超过 `WINDOW_MIN_ROWS` 的窗口化会话） | ≤ 视口行数 + 2 × `PART_OVERSCAN` + `TAIL_ALWAYS`（硬）                                                                                    | P10                                             |
| 延迟                                              | 输入 p95 ≤ 16ms、p99 ≤ 33ms；`/` 打开 p95 ≤ 33ms 且无 > 100ms 的帧；冷滚动 p99 ≤ 33ms 且无 > 100ms 的帧                                   | P1、P5、P8                                      |

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
- toast 时长、提问倒计时（F3）、已用时间（F4）、PR 的"3 分钟未响应"与"60 秒隐藏"、提醒倒计时（F6）全部用 `second` 或 `at`；F6 的三项都在 PR tracker 里用 `at`，状态带不订阅。
- P15（空闲 0 帧）在没有任何秒级显示可见时成立；显示秒级耗时的组件只在可见时订阅 `second`。Task 行（#1058、#1614）只在“运行中（后台或前台）且位于视口内（`ctx.isVisible`）”时订阅：排队、已结束、滚出视口的行不订阅，状态变了或滚出视口就取消。
- 唯一允许的动画：braille spinner 按固定间隔换帧。不用 `TextAttributes.BLINK`，不做按时间改变透明度的循环动画，不留 `createFadeIn`。
- `Spinner` 只在位于视口内时订阅 `frame`。"位于视口内"由行表和视口区间判断，不是"是否挂载"（overscan、末尾行、`streaming` 行都是挂载状态但不一定可见）。

### keymap

- 普通按键不得重新注册 layer。`useBindings(() => …)` 的 accessor 顶层不得读取随按键变化的信号。条件放进 `enabled` 函数，由 keymap 派发时求值。
- 随按键变化的 `enabled` 函数体用 `untrack` 包裹，或只读非响应式值（如 `input.visualCursor.offset`）。
- 禁止对随按键变化的信号用 `reactiveMatcherFromSignal`：`grep -rn "reactiveMatcherFromSignal" packages/tui/src` 为空。
- 快捷键文字在会话级只算一次（`SessionContext.shortcuts`），消息组件里不得调用 `useCommandShortcut`。`/` 命令列表来自一次构建的注册表（带 `version`），不依赖 `useKeymapSelector`。
- 自动补全的各 memo 在 `!store.visible` 时直接返回空数组。

### 消息列表

- 行数 ≥ `WINDOW_MIN_ROWS`（2000，依据见 `test/perf/README.md` 的“窗口化阈值”：OpenTUI 0.8.3 上约 2000 行以内全挂载满足全部延迟预算，窗口化的滚动反而更贵）时窗口化：视口上下各 `PART_OVERSCAN = 6` 行，末尾 `TAIL_ALWAYS = 4` 行始终挂载，`streaming` 行、选中行、展开中的行始终挂载。未挂载的连续行合并成一个占位盒。
- 行模型是 `Row { key, messageID, partID?, kind, revision, attached? }`（`attached` 只有 `user` 行带：消息带文件或目录，它们的标签在正文下占一行；并入 `revision`），`RowKind` 现为 `user | text | reasoning | tool | meta | revert | notice | delegation | handback | result`；`meta` 只有被中断的回合有（键 `interrupted:<messageID>`，一行 `message.interrupted`，`textMuted`，缩进与助手文字的正文对齐，即 `ROW_INDENT + MARK_CELLS`），`notice` 只有失败的回合有（键 `error:<messageID>`，错误块），除此之外一个回合在它的最后一个 part 行之后没有别的行：原来的 `task:` 通知行与 `summary:` 元信息行已随 #1615 删去（模型在顶栏、agent 在页脚、耗时只在 `/copy`、`/export` 的转录标题里），行表也不再需要最后一条助手消息的 id；`delegation`、`handback` 只在子 agent 视图出现，`result` 是后台结果卡，键 `part:<partID>`（part 是那条合成文本），折叠 id 就是该 part id，所以 `foldRowKey` 不变；`delegation` 是该会话第一条用户消息（会话窗口里的第一条）改画成的“任务 · 来自主会话”块，取代同一条消息的 `user` 行，`handback` 是结束后追加在表尾的一行，二者都由 `createRowTable` 的 `delegation`、`handback` 入参给出；`revision` 分别取被取代的 `user` 行的 revision 加 Task 描述和展开标志、取那一行的文字（切换语言会重新测量）。`delegation` 行没有 part：它的 `partID` 就是它的 key，也是它在 `SessionViewState` 里的折叠 id（`delegation:<messageID>`，`delegationFoldID`），所以提示词按 `ctrl+o` 或点击都能展开（见下）。
- 新增消息类型必须同时给出：新的 `RowKind`、高度估算、`revision` 的定义（内容变化时重新测量）。现有估算：`text` 按字符数除以（内容宽度 − `ROW_INDENT` 3 − `MARK_CELLS` 2）向上取整加 1 行间隔，`tool` 折叠态 2 行（调用行与结果行），打开时按输出行数加 3（行表给打开的工具行记输出行数：Edit、Write 没有收起提示，记 diff 或写入的行数减 1；apply_patch 每个文件是两行加它的 diff，文件之间隔一个空行，总高度再减去估算已加的 3 行），`reasoning` 折叠态 2 行（间隔与头行），打开时按正文折行数（宽度同 `text`）加 3，`user` 按字符数除以（内容宽度 − 左右内边距各 `USER_PADDING` 1 − `MARK_CELLS` 2）向上取整，加 1 行间隔，有附件标签（`attached`）再加 1，`delegation` 按提示词折行数加 5 行（折叠态至多 `DELEGATION_PROMPT_LINES` 行加一行省略号，展开态取全部折行数；会折叠的提示词在其下另有空行加提示行共 2 行，展开与否都在），`handback` 2 行，`result` 折叠态 5 行（上方空行、上下内边距、标题、预览）、展开态按正文折行数加 7 行，`meta`（被中断的一行）2 行（间隔与一行字），`notice`（错误块）按错误信息最长一行的折行数（宽度同 `text`：左边框与内边距占 `ROW_INDENT`）加 3 行（间隔与上下内边距，行表给错误行记这一行的字符数），`revert` 5 行（F2 3.3）。
- 行表按消息增量维护（`routes/session/row-table.ts`）：每条消息一个 memo，只读自己的 parts，store 写入或一帧流式只重算它所属的那一条消息，`rowData` 只在某条消息贡献的行变了时重算。已结束的 part（有 `time.end`）读快照（`settledPartText`），不订阅 stream version；正在写入的 part 只在还没有可显示的文字时订阅，出现首批文字后不再订阅。新代码不得在行表或行内组件里对已结束的 part 调用 `readPartText`，也不得在行表里为未变化的 part 重新派生文本（`createTextFacts` 按文本缓存）。
- 正在写入的 text/reasoning 行，`revision` 不含正文，只含 `done` 等标志，结束时按全文计算一次。正文变化会让每帧都产生新的 `Row`，使该行每帧重挂载、其后的行全部失效；它的高度靠挂载后的实测（`streaming` 行始终挂载）。`chars`（高度估算）因此只在该行出现与结束时更新。
- 窗口化的行是否挂载经 `createSelector` 逐行询问（`pinned`、末尾、视口三个选择器），视口移动一行只唤醒进出窗口的那几行；`gaps` 用普通循环计算，内容相同的 map 不替换。不要让每一行都读同一个会随滚动变化的 signal。
- 组件内局部状态（展开、选中）一律提升到 `SessionViewState = Map<partID, …>`，卸载后再挂载不丢。滚动定位走行表，不依赖渲染节点。
- 可折叠的块（点击展开的推理、工具输出、工具错误，子 agent 视图任务块的提示词，以及后台结果卡）的判定写在 `routes/session/fold.ts` 的纯函数里，块和 `ctrl+o`（`view.expand.toggle`）共用：`foldFlag(part, env, source)` 返回点击会翻转的视图标志，没有可折叠内容时返回空；任务块没有 part，判定是 `delegationFolds(text, width)`（提示词超过 `DELEGATION_PROMPT_LINES` 行或这些行在内容宽度下的字符上限，与工具输出同一个 `outputOverflows`；块用 `ctx.width`，`foldOfRow` 用同一个 `contentWidth()`），`foldOfRow` 对 `delegation` 行在它为真时返回 `expanded`；结果卡的判定是 `resultCardFolds(card, width, ambiguousWidth)`（正文不止一行，或首行比预览行的余宽宽；余宽随 `ambiguous_width`，因为卡的左边框 `┃` 是 Ambiguous 字形），`foldOfRow` 对 `result` 行同样返回 `expanded`，点击卡不折叠它，而是进入子 agent。行数、字符数、思考模式、“失败且画成一行”这些条件只在那里定义，组件不另写一份；工具输出统一在超过 `TOOL_FOLD_LINES`（6）行或这些行的字符上限时折叠（`foldOutput`），折叠后调用行下只留一行结果（bash 取最后一行，通用工具取第一行），其下一行写被折掉的行数与展开键。Edit、Write、apply_patch 不按行数折叠，也不画提示行：已完成的调用一律是两行块（调用行与汇总行，汇总是 `+N −N`，Write 是“写入 N 行”，诊断错误数接在后面），diff 或写入的文件只在展开（`ctrl+o` 或点击）后画在汇总行下，展开后也没有收起提示；判定是 `editRows`、`writeRows`、`patchFileRows`（`diffRows` 数 diff 的行），组件给 `ToolCall` 传 `opens`，不传 `folds`；apply_patch 每个文件是自己的两行块，整个调用共用一个展开标志，被删除的文件没有 diff 可展开；这三类失败的调用与其他工具一样画成一行，错误走 `errorExpanded`。`ctrl+o` 从行表末尾往前，按 store 里的 part 判定，不看块是否已挂载：窗口化转录会卸载视口以外的块，它们正是前几次按键要够到的。先展开最近一个已折叠的块，再往前一个，全部展开后收起最近的一个；翻转的是点击用的同一个标志，翻转后该行被 `pinnedKeys` 固定（折叠 id 经 `foldRowKey` 换成行 key：part 行是 `part:<partID>`，任务块就是它自己的 id），挂载时即为展开态，所以按键和点击随时互相接续。新增一种可折叠的块，要在 `fold.ts` 加判定并让组件用它，否则按键会绕过它。视口以外的块展开后不会自动滚动到位。
- 宽度变化使缓存失效。
- 窗口化转录保持视口内容不动：视口之上的行高变化（未测过的行首次挂载并被测量、行被展开或收起）用 OpenTUI 原生的 `scroll.anchor(行节点)` 保持锚点，由布局在同一帧里调整偏移；不用 `scroll.scrollBy(delta)`，它要等下一帧测到新高度才补偿，每次修正先跳一帧再跳回（#1277 实测 44 次跳动变成 96 次）。`SessionTranscript` 的窗口控制器每个 pass 锚定视口顶部所在的行（该行须已被上一次布局放好）；贴底时不锚定，让滚动盒继续跟随新内容。
- 窗口按布局之后的偏移取：行表已经知道、布局尚未应用的变化（行集合变了，或某行的 `revision` 变了，例如展开）折算进偏移再算窗口，否则视口里的行会被卸载一帧，屏幕上出现空白。测量不在其中，它读的是已被锚定的布局。
- 在窗口化转录里跳到一条未挂载的消息（`session.message.next/previous`、`session.messages_last_user`）：先 `scrollTo` 行表位置，再在 `afterLayout` 里用 `scrollChildIntoView` 把目标行对齐到视口顶部，那一帧画出来时目标已经在位（行表位置里未测过的行用的是估算高度）。
- 向上逐行滚动 450 步，视口顶部所在的行每步在屏幕上下移一行：跳动 0 次、漂移 ≤ 1 行（P11，按该行的屏幕位置度量，不看 `scrollTop`，因为保持锚点的转录会自己移动偏移）。
- 内容不足一屏的转录贴着主区底部，即贴着状态带或输入框（#1615，原型的 `.main{justify-content:flex-end}`）：`<scrollbox>` 带 `contentOptions={{ minHeight: "100%", justifyContent: "flex-end" }}`，内容盒至少与视口等高、内容靠下，所以短会话没有可滚动的范围，最后一条消息与它下面的状态带或输入框之间只隔主区自己的 1 行 `paddingBottom`。内容超过一屏时内容盒就是内容的高度，布局、滚动偏移与锚点与不设这两个选项时一样：窗口化的转录行数 ≥ `WINDOW_MIN_ROWS`，总是这一种，未窗口化的一屏以上也是；内容长过视口时仍由 `stickyScroll`、`stickyStart="bottom"` 跟随末尾。守这一点的测试是 `test/routes/session/short-session.test.tsx`（短会话贴底、有状态带时贴状态带、一屏以上的内容高度与视口逐行核对、增长越过一屏时最后一行不动）与 `test/routes/session/windowing.test.tsx`（P11 的窗口化与未窗口化两条路径）。后果：短会话里打开一个块（推理、工具输出）是向上长的，它下面的行不动，块的头行上移；新增转录元素的测试不得假定内容从视口顶部开始，要按相对位置或底边断言。

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
- 夜间 PTY 端到端基准是单独的 Azure 流水线 `.azure-pipelines/nightly-pty.yml`：每晚（和手动）从 `main` 跑 `bun run bench:tui:pty` 五次，对 `test/perf/pty-baseline.json` 输出比值表。它不进入分支保护、不挡 PR，只告警；PTY 基线不在 `baseline.json` 里，更新同样需要评审并在 PR 描述写明原因（见 `test/perf/README.md`）。

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
- 子 agent 视图只允许不改子会话、也不向子会话发请求的命令。`scope` 含 `subagent` 的集合是 F5（#1033）3.3 列出的 12 个（`/new`、`/sessions`、`/copy`、`/export`、`/agents`、`/config`、`/theme`、`/status`、`/help`、`/sidebar`、`/dag`、`/exit`）。扩大它需要修订 F5 与本文。调试类命令（`app.debug`、`app.console`、`app.heap_snapshot`）只在 `home`、`session`，不在子 agent 视图的面板里；键位照常可用。会改会话或向会话发请求的键（撤销、重做、压缩、后台化、重命名、分叉）在子 agent 视图里随命令一并关闭，`enabled` 取 `!readOnly()`，`test/routes/session/subagent-keys.test.tsx` 逐键验证。
- 必填参数的命令，从命令面板选中时只把 `/名字 ` 填入输入框并聚焦，不直接执行。
- 需要编辑一小段文字的操作（重命名、编辑排队消息）用"回填输入框"：预填文本、状态行显示"正在编辑：… · esc 取消"、`⏎` 提交、`esc` 放弃并恢复原草稿。不新增输入对话框（F3 5.4）。
- 不恢复无斜杠的 `exit`、`quit`、`:q` 退出捷径。
- 已删除的命令名不得回来：`/share`、`/unshare`、`/org`、`/orgs`、`/switch-org`、`/variants`、`/timestamps`、`/thinking`、`/dag-cancel`、`/models`、`/mcps`、`/themes`、`/continue`、`/mo`、`/toggle-timestamps`、`/toggle-thinking`（F3 5.2）。

必须写的测试：`registry.list("home"|"session"|"subagent")` 快照；提交规则用例（内置本地执行、服务端走 `session.command`、未知 `/xxx` 当普通消息）；双语键齐全；子 agent 视图里该命令不可达时 SDK mock 写请求为 0。

### 6.2 新增一个面板

- 只能基于 `PanelShell` 的三个模板之一：`ListPanel`（选择）、`SettingsPanel`（设置行）、`DetailPanel`（只读详情、单行输入、汇总加行表）。需要第四种模板时，先停下提出（F3 5.4 明确不新增）。
- 面板栈最深 3 层；`esc` 返回上一层；`ctrl+c` 关闭全部。打开时保存焦点，关闭时还原，输入框草稿保留。
- 挂载时注册一次带 `enabled` 函数的 layer，卸载时注销；不得因面板开合重新注册全局 layer。面板的数据源只在打开时创建 memo，关闭期间不订阅。
- 按键提示由各模板 `hints` 加 `PanelHost` 通用项生成，key 取自 keymap（`formatKeyBindings`），不写死按键名。一对相反方向的命令写成一条 `PanelHint`（`key` 加 `also`），两边各只绑一个裸方向键且成对（上下、左右）时合成一条（`↑↓ 选择`），否则退回两条同标签的提示（`shell.tsx` 的 `hintEntries`）。
- 单字母动作键只在没有过滤输入框的 `DetailPanel` 里启用。有过滤输入的 `ListPanel` 动作用 `ctrl+<key>`，且不用 leader `ctrl+x`；其标签只用 `tab`/`shift+tab` 切换，`left`/`right` 留给过滤框光标。
- 内容区超过 `maxRows` 在区内滚动；窄终端（< 100 列）先隐藏 `command` 与标签次要信息。警示类用 `tone="warning"` 与 `borderWarning`。
- 破坏性确认、二选一不做面板，用询问区的 `confirm`/`choice` 变体。

必须写的测试：80×24 与 120×40 各一张快照（三段结构位置）；打开、选中、关闭、一个动作；打开关闭后 `registerLayer` 增量不超过 P7 的上限；草稿保留。

### 6.3 新增一个键位

- 只在 `config/keybind.ts` 的 `Definitions` 与 `CommandMap` 登记，两者一一对应；同时在 `config/keybind-disposition.ts` 的 `Disposition` 登记处置（`keep | change | new`）和 `layer`（取自 `Layers`）；删除的键位名不再留在 `Definitions`，登记到 `test/keybind-disposition.test.ts` 的 `REMOVED`（放在 `src` 之外，已下线功能守卫才不会命中）。
- 命名：`Definitions` 键用 `snake_case`，命令名用点分（先例：`session_dagmode_toggle` 对应 `session.dagmode.toggle`）。
- 同一个键在同一上下文层里只做一件事；跨上下文重用靠"上下文层"区分，不在命令内部写 `if`。
- 页脚、`?` 帮助面板、回执里的按键文字由 keymap 生成，不硬编码键名。`TMUX` 环境变量存在时，抽屉开关显示 `<leader>b`。
- 已删除的键位名不得回来：`sidebar_toggle`、`session_child_cycle(_reverse)`、`session_parent`、`which_key_*`、`tips_toggle`、`plugin_manager`、`plugin_install`、`plugins.toggle`、`dialog.plugins.install`、全部 `dag_*`、`session_share`、`session_unshare`、`docs_open`、`console_org_switch`。检查：`grep -rn "dag_[a-z_]*" packages/tui/src/config/keybind.ts` 为空。
- 输入框不用 `ctrl+b`/`ctrl+f` 移动光标；`ctrl+d` 只在输入框为空时退出。输入框层只绑 `Definitions` 与 `keymap.tsx` 里 `inputExtraBindings` 列出的固定别名；不得改回 `registerManagedTextareaLayer`，它会追加库默认的 64 个键位（含 emacs 的 `ctrl+b`/`ctrl+f`/`ctrl+d`）。
- `esc` 是优先级链，不得另写长 `if`。每层向 keymap 注册一次带 `enabled` 函数的绑定，位置按 F1 4.5 的顺序：补全 → 抽屉 → 询问区 → 模态面板 → 非模态详情面板 → 子 agent 返回父会话 → 会话忙碌（5 秒内第二次才中断）→ 无动作。层号以 F1 4.5 为准（子 agent 返回第 6 层、会话忙碌第 7 层）。新增一层需要修订 F1 与本文。
  - 有一处实际行为与这个顺序相反：模态面板打开时，`PanelHost` 压入 `modal` 模式，`BottomZone` 让输入框失焦；`base` 模式里的抽屉绑定和绑在输入框上的补全绑定因此都不生效。抽屉或补全弹层与模态面板同时存在时，先关面板（第 4 层），再关抽屉（第 2 层）或补全（第 1 层）。这是保留的现状，`test/esc-chain.test.tsx` 的两条"modal over …"用例固定了它；要改成抽屉、补全优先，需要同时改这些绑定的模式或焦点处理并修订本文。询问区出现时面板被挂起，二者不会同时响应 esc。

必须写的测试：处置表遍历 `Definitions` 无遗漏；同一上下文层内无重复键；`esc` 链每层一条用例；用户覆盖一个绑定后帮助与页脚文字同步变化。前两项由 `test/keybind-disposition.test.ts` 覆盖：同层出现新的重复键时，先改默认值或注册位置；确需保留的，登记到该测试的 `KNOWN_CONFLICTS` 并写明原因与 Issue。

### 6.4 新增状态带行或抽屉区块

状态带（`shell/status-band.tsx`，单文件）：

- 高度 0–2 行，不占用时高度为 0，不留空行（画不出内容的行同样不占行）。属于根会话；子 agent 视图显示根会话的工作流、目标、PR 与提醒（信任行是项目级的，各视图相同）；home 不显示。
- 窄终端（< 100 列）合并为一行。行的优先级与让位顺序以 F4（#1032）方案 1 和 F6（#1036）2.2 为准：DAG 行行尾先让位的是后台标记（#1058）→ `/dag` 提示 → 预算段 → 费用 → 并发段 → 阶段名 → 计数压缩 → 标题截断；进度条与模式标记（≤ 8 列）、非警示 PR 短标记（≤ 14 列）不让位。信任警示行（#1618）排在最前；PR 警示态一定单独占一行，窄终端单行时信任警示 > PR 警示 > DAG > 目标。行的优先级与选取由 `pr-line.tsx` 的 `chooseBandRows` 统一给出，见下面“PR 行与提醒行”与“信任行”。
- 只读：点击 DAG 行只打开 `/dag`；点击 PR 行只用系统浏览器打开 URL；点击后台标记或后台行只打开 `/agents`；点击信任行只打开 `/trust`。
- DAG 行（F4 PR2）：显示策略 kv `dag_band`（`auto` 默认，有活跃或未确认失败的工作流才显示；`always`；`hidden`），`always` 且没有工作流时显示一行“没有工作流”；`/dag` 面板（panel id `dag`）打开时隐藏，目标行不受影响。主工作流用 `selectMainWorkflow`，其余折叠成行尾 `+N 个`；用户在面板里选过、打开过的工作流记在 `sync.dag.focus`（面板写，状态带只读）。当前波用 `dagCurrentWave`，进度条用 `layoutDagBar`，节点表未加载时按汇总计数画。点击 DAG 行经命令注册表执行 `dag.open`。状态带由 `app.tsx` 以表达式传给 `AppFrame` 的 `statusBand`，不经 memo：槽在 `BottomZoneProvider` 里创建它，它才读得到面板栈。让位（预算为正常档时；警告与耗尽档的例外见下）：先去后台标记（#1058），再去 `/dag` 提示，再预算、tokens、并发，再 `+N 个`，再波次，再等待主 agent，再把计数压成 `n/m`，再把标题截到 12 列。文字与进度条谁先定宽（#1619 修订 F4 方案 1、2.3 原写的“文字先让位，条只在最少文字也放不下时才收窄”）：文字先取最丰富的一级，进度条在剩下的宽度里每节点取至多 3 格（`SLOTS_PER_NODE`）、至少 2 格（`MIN_SLOTS_PER_NODE`）：从最丰富的一级起逐级往下，取第一个“文字放得下、进度条每节点不少于 2 格”的级别，只找到最少文字（计数压成 `n/m`、标题截到 12 列）为止；一级都找不到（窄屏，或节点很多的工作流）才回到原来的取法：进度条按最少文字定宽并取走剩余的全部宽度（每节点从 3 格降到 1 格，再按波分段），文字取放得下的最丰富一级。让位的先后顺序、模式标记与 PR 标记不让位的规则都不变，变的只是进度条为了让更多文字留下，让出每节点的第三格。宽度每多一格，文字只会更丰富或不变，唯一的例外是进度条由每节点 1 格升到 2 格的那个宽度（那里文字退回最少文字，因为回到原来的取法时进度条只有 1 格）；进度条自己的格数不随宽度单调，文字多放下一块时它可能从 3 格回到 2 格。逐宽度的用例在 `test/shell/status-band-layout.test.ts`。颜色：行首 `◆` 用 `primary`，进度条按状态 token，说明文字 `textMuted`，分隔符与提示 `textDim`，失败数 `error`、暂停 `statusPaused`；运行中的数量不用品牌色。
- DAG 模式的显示（F4 PR4，#1032 7；只读，数据都由数据层的现成切片派生，状态带不自己取数）：行尾自左向右依次是等待主 agent（`warning`）、模式标记、用量段、`+N 个`、`/dag` 提示。
  - 模式标记：模式取根会话自己的 `dagMode`（`session.updated` 维护）；开时 `模式开`（`text`），关而有工作流在跑（`running`、`stepping`）时暗色 `模式关`（`textDim`），其余情况没有标记；至多 8 列，不让位，只有窄到进度条也放不下时才最后去掉，不用品牌色。
  - 用量段：全进程并发 `running/cap`、`{tokens} tok`、`预算 {百分比}%`，预算段按档位着色（正常 `textMuted`、警告 `warning`、耗尽 `error`），未设预算不显示百分比；费用段没有数据来源，不做。档位与服务端同一刀（`dag/mode.ts` 的 `dagBudgetTier`：用量 ≥ 预算为耗尽，≥ ⌊预算 × `warn_ratio`⌋ 为警告）。用量取根会话自己各工作流摘要的 `tokens` 之和（事件驱动），在其上叠 `store.dagMode` 快照（预算、`warnRatio`、`limits`）：快照在路由进入的会话树有 DAG 模式开或有工作流时取一次（进入树、该树来了摘要事件、根会话的模式变为开，三个时刻；在途读不重复发），会话的预算字段变化（`session.updated`）、全局 `dag` 配置变化（`config.updated` 的 `keys` 含 `dag`；该事件不经 `useEvent`，数据层直接听 SDK 事件源）与重连时再取（重连时路由的根没有快照而按上述条件需要时，也在此时补取），没有轮询；普通会话与首页不产生读取，唯一的例外是 `/config` 面板在会话里打开时为根会话取一次（`sync.dag.readMode`，已有或在途不重复发，之后随上述刷新更新；#1290），面板经 `sync.session.root` 找树的根（只沿这条父链逐级查，选择器里不遍历会话表）。`limits` 里每项限额都带服务端的生效值（`concurrency`、`maxTotalNodes`）和配置值（`configuredConcurrency`、`configuredMaxTotalNodes`，未配置为 `null`），`/config` 的并发行以它为准，`test/source-guards.test.ts` 守着面板里没有数字回退。并发段的 `running` 是全进程的计数，摘要事件只给它所属的那个会话带上，所以取全进程最近一次的报告（`sync.data.dagRunning`：任一会话的摘要或汇总读取里的 `concurrencyRunning`，或快照的 `limits.running`，以后到者为准），其次才是根会话自己摘要里的，再其次是快照里的（`dagUsage` 的 `running` 输入）。
  - 让位的档位例外：预算为警告或耗尽档（用量段带百分比）时，预算段与等待主 agent 提到计数压缩和标题截断之后才让位，顺序是 `/dag` 提示、tokens、并发、`+N 个`、波次、计数压成 `n/m`、标题截到 12 列、等待主 agent、预算。两条让位链共用上一条的取法（文字先定宽，进度条每节点至少 2 格）：预算与等待主 agent 和其余文字一样，可以让进度条从每节点 3 格收窄到 2 格，但不会收到 2 格以下。找不到这样的级别时回到原来的取法：进度条只按最少文字（标记、12 列标题、`n/m`）定宽，不为这两段收窄，它们只取进度条与最少文字之外的余宽；余宽只够其一时留预算。正常档维持上一条的顺序。
  - 等待主 agent：任一工作流 `checkpointPending` 且（根会话空闲，或其最近一个回合以 `error` 结束，读 `turn_settled`）。
  - 预算 toast 只有服务端 `DagBudget` 发出的那一份（`tui.toast.show`）；TUI 不为档位变化、快照加载或重连刷新自弹 toast，只按档位着色（#1032 D6）。服务端 toast 的消息已以标题开头时只显示一次（`ui/toast.tsx` 的 `serverToastText`）。
  - `/dag` 面板的对应部分：summary 区第一行是模式行（`DAG 模式：开/关 · 运行 x/y（全进程） · 节点上限 n · token 用量/预算`，token 段按预算档位着色，放不下时截断不换行）；计数行之后依次是该工作流的工作目录与分支行（#1618，`textMuted`，只读，没有按钮：数据来自 `WorkflowSummary.worktree`，不新增读取；服务端按 `workflow status` 同一规则给出，已结算的状态优先，没有则取配置里的 live 指针并记 `active`，没用 `isolation: "worktree"` 的工作流和旧服务端没有这个字段，整行不画。`active`、`kept` 写 `工作目录 {路径} · 分支 {分支}`（键 `dagmode.panel.worktree`，没有分支只写前半，`dagmode.panel.worktree.noBranch`）；`removed` 写 `分支 {分支} · 目录已清理`（`dagmode.panel.worktree.removed`，没有分支整行不画）。路径与分支经 `remoteLine` 去转义，路径用 `ui/width.ts` 的 `truncateCellsLeft` 按显示宽度从左截断，分支完整显示；整行仍放不下时才截行尾，不换行。该行收掉 #1032 验收 12 的“有据偏离”）、用量行（`dagUsageText`，键 `dagmode.panel.usage`，`textMuted`：`用量 输入 · 输出 · 推理 · 缓存 读 写 · 费用`，数字用 `formatDagTokens`，费用经 `costLabel`，有未标价的部分写 `$x + 未知`、全部未标价写 `未知`；数据来自 `WorkflowSummary` 已有的 `tokensInput`、`tokensOutput`、`tokensReasoning`、`tokensCacheRead`、`tokensCacheWrite`、`cost`、`costUnknown`，不新增读取，六个数字字段缺任一个（旧服务端）就不画这一行，按内宽 `truncateCells` 截断不换行；#1475）、质量行（`quality` 的 `reviews`、`stillOpen`、`completeness`，按工作流计数，`null` 时没有）、预算耗尽时对暂停的工作流（非检查点）说明恢复条件、以及 `coverageCount > 0` 时的“覆盖与截断”块（至多 4 个失败、跳过、取消、中止的节点及原因，其余只计数；服务端的计数还含不对应节点的条目，单独说明，不新增服务端读口）。
- `/dag` 面板折叠展开生成的子节点（#1158 PR5）：折叠规则只在 `dag/fold.ts` 的 `dagFold` 里定义，面板只画它给出的行。
  - 归属与画法：compose 展开生成的节点带 `expanded_from`（线上字段名，`DagNodeRow` 原样保留）；被在场节点的 `expanded_from` 指到的节点是展开槽（slot，展开后即同 id 的 join 节点）。子孙画在槽下，不在自己的波位置：波列留空，缩进（每层 2 格）写在名称格里，状态符号仍占一列；`▸`/`▾` 列只在工作流里有槽时才预留，没有标记的工作流渲染与此前逐字节相同；`expanded_from` 过期（指向的槽不在场）的节点按顶层画。
  - 折叠状态：默认折叠，已展开的槽里的嵌套槽同样折叠。状态放在组件外，同 `DagPanelState.expanded`（`unfolded`、`toggleUnfolded`），键为 `nodeKey(workflowID, slotID)`。槽行折叠与展开时都显示槽自己（join）的状态和直接子节点数（`dagmode.panel.fold.child` 与 `.children` 两个键，英文单复数分开）。
  - 按键：槽行上 `space` 折叠或展开，经 `DetailPanel` 的 `onToggle` 与 `DetailRow.toggleLabel`（有 `toggleLabel` 的行按 `space` 调 `onToggle`，选中时显示 `space` 提示；其他行不变）；`⏎` 行为不变。选中的节点被折起时，选中移到可见的祖先槽（`dagFold` 的 `hidden`）。
  - 提示行让位：槽行上折叠提示取代 `o` 详情提示（键本身仍可用）；窄于 120 列（`SLOT_REQUEST_HINT_WIDTH`）时 `i` 提示也让位，仍保留关闭提示。
  - 进度条、计数与当前波仍按全部节点算，不论折叠；行上的波号不重排，整波折在槽下时，摘要里的波次可能没有对应的可见行。
  - 只读：折叠与展开只改视图，`dag.*` 写请求与 `session.command` 均为 0；`test/panel/dag.test.tsx` 的 `the panel is read-only` 用例覆盖。
- 目标行（F4 PR2）：有目标就显示，不受 `dag_band` 控制；`waiting`、`paused` 带 `pausedReason` 时原因用 `warning` 色占状态位。让位：先去 `/goal` 提示，再截目标文字（至少留 12 列），再去子目标计数，最后去轮数。窄终端只显示一行，按下面的优先级取第一行，没有更高的行时才显示目标行；宽终端有 PR 警示行和 DAG 行时目标行让位给抽屉（`DrawerGoal` 始终显示根会话的目标）；有信任行时，信任行之外只再取排在最前的一行，所以有 DAG 行、PR 警示行或 PR 行时目标行同样让位，只有信任行加目标行时两行同在。目标文字、原因、工作流标题都经 `util/remote-text.ts` 的 `remoteLine` 去转义。缺目标文字或缺状态的目标体（`isGoalShown` 为假，含服务端把“没有目标”回成 null 的情形）不画行、不占高度，也不抛错：行布局里抛出的错误会让状态带所有行停止更新。
- PR 行与提醒行（F6，#1036 2）：数据来自 `usePrTracker()` 的 `items(root)`、`reminder(root)`（根会话；没有 provider 时没有 PR、没有提醒）。状态带不算 PR 状态与时间，只排版 tracker 给出的结果，也不订阅任何时钟。纯布局都在 `shell/pr-line.tsx`（`layoutPrRow`、`layoutReminderRow`、`prTailText`、`prOpenUrl`、`chooseBandRows`），测试在 `test/shell/pr-line.test.ts`。
  - 选行：优先级 信任警示（#1618）> PR 警示 > DAG > PR（非警示，只在没有 DAG 行时）> 目标 > 提醒，至多 2 行，窄终端（< 100 列）只取第一行；画不出内容（宽度为 0）的行不占行。有 DAG 行且 PR 都非警示时，PR 不单独成行，`prTailMark` 的短标记（≤ 14 列，`textMuted`）作为不让位的一组接在 DAG 行行尾（`/dag` 提示之后），与模式标记一样只在最后一级（超出规格的极窄终端）让位；`dag_band=always` 的“没有工作流”行同样带它。有 PR 警示且有 DAG 行时，宽终端是 PR 警示行加 DAG 行，窄终端只有 PR 警示行；有信任行时它是第一行，宽终端是信任行加其余里排在最前的一行，窄终端只有信任行。被信任行或 PR 警示挤出状态带的工作流不再向 `sync.dag.watch` 声明（`SessionStatusBand` 的 `watched` 按 `dagShown()` 判定，`test/shell/status-band.test.tsx` 的“信任行”各组守着这一点）。`/dag` 面板打开与 `dag_band` 只管 DAG 行，PR 行和提醒行与目标行一样不受影响。
  - PR 行：一个 PR 写成 `PR #1035  ✓ 通过 · agent 处理中`，标签 `textMuted`、编号 `text`，结果与说明各用 `prLineState` 给的 token，分隔符 `textDim`；警示态（`tone` 为 `warning`）标签与编号用 `warning`；监视中是 `CI 4/6` 或“等待 CI”（`textMuted`）。多个 PR 压成 `PR !#1040 ~#1036 ✓#1035 +2`（`prCompact`，警示在前，有警示用 `warning`，否则 `textMuted`），放不下的计入 `+k`。放不下时从行尾截断（`truncateCells`），先截说明，再截结果；只用主题 token，不用 `primary`；`ambiguous_width` 为 1 和 2 时都不超宽。
  - 文字与语言（#1409）：tracker 保留与比较的只有事实（`pr/state.ts` 的 `PrLineFacts`：kind、outcome、标志，加上 PR 编号与 CI 计数），不保存译文；服务端条目消失后保留的常驻警示就是当时那份事实的纯拷贝。文字由 `prLineWords` 在画行时经 `t()` 生成（`layoutPrRow`），toast 在弹出时生成，所以切换界面语言后常驻警示立即换成新语言。tracker 判定时不读 `t()`，语言切换不会让它重算：不换行、不弹 toast、不改变保留与消除；`sameItem` 只比 kind、outcome 和 CI 计数。
  - 提醒行：`提醒 · {time}后 · {text}`，到期为 `提醒 · 已到期 · {text}`（`reminder.band.in`、`reminder.band.due`），`textMuted`，到期用 `warning`；提醒文字在行尾，放不下时截它（经 `remoteLine` 去转义）。不可点击。
  - 点击 PR 行：用系统浏览器（`open`）打开第一个 PR（警示的在前）的 URL，只放行 `http`、`https`，选区守卫与点击 DAG 行相同，不产生任何请求；`open` 失败时没有可显示的出口，`.catch(() => {})` 留空。
- 信任行（#1618，登记于 F4（#1032）方案 1 与 F6（#1036）2.2 的选行规则，落实 #1032 验收 29；纯布局在 `shell/trust-line.ts` 的 `layoutTrustRow(count, width, ambiguousWidth)` 与 `trustChangeCount(entries)`，测试在 `test/shell/trust-line.test.ts`）：自上次确认后新增或被改过的项目命令（hook、MCP、formatter 等）在确认之前暂停执行，这一行把条数说出来。
  - 显示条件：数据来自 `sync.data.trust`（`ProjectTrustEntry[]`），条数 N 是 `state === "pending"` 且 `change !== undefined` 的条目数；N 为 0 不画行、不占高度。没有 `change` 的待决条目（首次访问项目）以及已信任、已拒绝的条目不计：它们只由页脚提醒与首次打开的信任面板（`app.tsx` 的 `trustPrompted`）覆盖。home 没有状态带，同样只有页脚。信任属于项目，不属于某个会话，所以子 agent 视图里这一行与主会话相同。
  - 版面与颜色：`⚠ 项目命令有 {n} 处变化，未确认前暂停执行`，`/trust` 提示靠右（命令名，不翻译）；文案键 `trust.band.changed.one`、`trust.band.changed.many`，英文按单复数拆键，中文两键同文。`⚠` 与正文 `warning`，提示 `textDim`，不用品牌色。让位：先去 `/trust` 提示，再用 `truncateCells` 截正文，`⚠` 恒保留，宽到放不下 `⚠` 时不画；宽度全部走 `cellWidth`、`truncateCells`，`ambiguous_width` 为 1 和 2 时都不超宽。
  - 选行与落位：信任行是警示行，优先级最高，所以不带后台标记：标记落到它下面第一条非警示行上，只有信任行时标记与后台行都不画（`pr-line.tsx` 的 `isWarning`）。窄终端只取第一行，所以只有信任行。
  - 点击：整行可点，经命令注册表运行 `trust.open`（`useCommands().run("trust.open", { args: "", origin: "palette" })`，与点击 DAG 行运行 `dag.open` 同一做法；面板是 `manage` 模式，列出全部条目，只列变化条目的 `changed` 模式要另有一条可见命令，不在 #1618 内），有文本选区时不触发，点击本身不产生任何写请求，写入只发生在面板里提交决定时。`clickOf` 里 `trust` 对应 `openTrust`。
  - 与页脚提醒的关系：两者并存，分工不同。页脚 `⚠ N 条项目命令未信任 · /trust`（`shell.footer.trust`）保持原样，计数是全部待决条目（含没有变化的首次条目），在 home 与会话页都在，信任行出现时也不撤；状态带信任行只在“有变化”时出现，是醒目的那一行。
  - 预算：`store.message`、`store.part` 写入 0；空闲、无新事件时帧数 0；不订阅 `ticker`（不读时钟）；不注册 keymap layer；没有新增 `createEffect`，只有两个 `createMemo`（数条数、排版），条数是原始值，条目状态不变的 store 写入不会让它重新排版。
- 后台标记与后台行（#1058 4）：数据来自根会话的后台 Task（`session/background.ts` 的 `backgroundItems`，状态取值 结果 > job > 摘要；排队是服务端 job 状态的 `queued`，见下面“后台运行的排队”）。只数运行中与排队中的后台运行（`running`、`queued`）：未知、已结束的运行、前台运行，以及 watch_pr、DAG、hook 都不计入。纯布局在 `shell/background-mark.ts`，选行与落位仍由 `chooseBandRows` 统一给出；状态带不订阅任何时钟，所以不显示耗时（耗时在抽屉）。
  - 标记：`◇ 后台 n`，有排队时 `◇ 后台 n·排k`（英文 `◇ bg n`、`◇ bg n·qk`，键 `background.band.mark`、`background.band.markQueued`），数字至多 99，`textMuted`。宽度 ≤ 12 列（`ambiguous_width` 为 2 时 ≤ 14 列，`◇` 与 `·` 为 Ambiguous）：带排队的写法超出预算时退回不带排队的写法（中文在 n ≥ 10 时），所以预算对任何计数成立，`test/shell/background-mark.test.ts` 在两种语言、两种宽度下核对。
  - 落位：接在已选中的行里第一条非警示行的行尾，排在 PR 短标记之后。警示行不带它：PR 警示行，以及预算在警告或耗尽档的 DAG 行（`dagUsageAlert`，与 `DAG_ALERT_CHAIN` 同一判断）；信任行（#1618）同样不带：它是第一行，也是警示行。DAG 行与 `always` 的“没有工作流”行里它是最后一组，是 `DagLevel.background`，在两条让位链的最前，早于 `/dag` 提示让位，且整行放不下就不画；目标行、PR 行、提醒行在原有排版之外接它：只在行里剩得下两格间隔加标记时才接在行尾（目标行在 `/goal` 提示之后），剩不下就不画，不占目标文字、PR、提醒的任何一列。
  - 后台行：只在没有任何别的行被选中时出现，优先级最低（有信任行或 PR 警示行时不出现）：`◇ 后台 n · kind 描述 · kind 描述 · +k`，行尾 `/agents`（`background.band.row` 只是其中的“后台 n”）；描述经 `remoteLine`，kind 至多 12 列。放不下时先截描述（每条至少留 6 列，较长的先截），再把第二项并入 `+k`，再去第一项，最后去 `/agents`。
  - 窄终端（< 100 列）既无标记也无后台行，抽屉的“后台任务”区块列出它们。`n` 为 0 时二者都消失，状态带因此为空则高度为 0。
  - 可见性：属于根会话，子 agent 视图同样显示。`dag_band=hidden` 与 `/dag` 面板打开只去掉 DAG 行（`target()` 的门控只管 DAG 行），标记落到余下的行上，没有余下的行时用后台行。
  - 点击：标记是行里独立的一段（`BandSpan.action` 为 `agents`，`BandLine` 把它画成自己的 `<text>`），点击标记和点击后台行都经命令注册表运行 `agent.subagents`（与点击 DAG 行运行 `dag.open` 同一做法，有选区时不触发）；点标记时该行自己的点击（`/dag`、PR 页面）不再触发。不产生任何请求。
- 无 `setInterval`、无定时拉取。状态带不订阅任何时钟（`ticker.frame`、`second`、`at` 都不用）：运行段是静态字符；PR 的“3 分钟未响应”“60 秒隐藏”与提醒倒计时全在 PR tracker 里，每行至多一个 `ticker.at` 一次性回调，到点由 tracker 更新它给出的结果，状态带随之重排。根会话的消息历史未加载（没打开过，或已被 LRU 逐出）时，tracker 只用上次加载时见过的回复或用户中止作为“已处理”的证据；没见到回复不算未响应，也不算回合出错，3 分钟计时等历史加载后再判。
- 新增一行或一类标记时：写出显示条件、颜色 token、窄屏让位位置，并在 F4/F6 对应方案里登记（修订本文）。

后台运行的排队（#1407，`session/background.ts`、`context/lifecycle-mirror.ts`）：

- 排队由服务端报，客户端不推断：job 的 lifecycle 状态区分 `queued`（子 run 在等并发槽）与 `running`（已占槽）。`lifecycle.transitioned` 与 `POST /lifecycle/states` 都带它；状态带 `since`：`queued` 的 `since` 是开始排队的时刻，`running` 的是真正开始运行的时刻。
- `backgroundStatus` 按服务端的话取：`queued` 就是排队；带 `since` 的 `running` 就是运行中，子会话还没 busy、也没调过工具同样如此。服务端没有这个状态（旧服务端从不说 `queued`，它的 `running` 也没有 `since`）时，才退回原来的推断：子会话既不是 busy/retry、`toolCalls` 又为 0，判为排队。`since` 的有无就是区分两者的标记；`entryFromTransition` 只在转入或转出 `queued` 的事件里给它，其余由随后的 `POST /lifecycle/states` 的回答带来。
- 耗时不含排队：运行中的从 job 的 `since` 起算（`backgroundRunningAt`），已结束的从结果的 `runningAt`（服务端写进 `metadata.backgroundResult`，由结束记录存在 `child_run.outcome` 里，所以重启后补发的结果同样带它；运行从未开始、进程异常退出后被恢复的运行，以及记录它之前的旧行没有）起算，都没有时取 Task 调用的开始时刻。排队的运行没有耗时。排序仍按 Task 调用的开始时刻，先来先排。
- 测试在 `test/session/background.test.ts`（含“并发上限为 1，连发 3 个”与旧服务端两组）、`test/cli/cmd/tui/sync-background.test.tsx`（事件与回答的整条链）、`test/shell/status-band.test.tsx`、`test/routes/session/drawer-content.test.tsx`、`test/panel/agents.test.tsx`（三个界面）。

子 agent 视图的后台标签（#1058 8，`shell/subagent-path.ts`、`shell/top-bar.tsx`）：

- 后台运行的视图在顶栏路径的当前段末尾追加标签，前台不加：`background.row.background`（`后台`）；从前台转入后台的 `background.row.promoted`（`后台（已转）`）。数据来自 Task 链接的 `background`、`promoted`（`SubagentLookup.task` 取这两项，`SubagentView.execution` 带出，`sameSubagentView` 比较它，memo 才会随之更新）；没有链接的会话（DAG 节点）没有标签。
- 标签用 `DESCRIPTION_SEPARATOR` 接在描述之后，颜色 `textMuted`，计入当前段宽度，所以顶栏给模型信息留的余宽也随之减少（模型信息本来就先让位）。
- 标签最先让位：只有整条路径不截断时才画，放不下就是前台运行的那一条（描述、中间段、根标题照旧按 `layoutSubagentPath` 的顺序让位），不会画半个标签。`test/shell/subagent-path.test.ts` 的逐宽度用例核对这一点：任何预算下，带标签的布局要么是不带标签的布局加上完整的标签，要么与它逐项相同。

抽屉（`shell/drawer.tsx`）：

- 默认隐藏，覆盖在主区右侧 40 列，从顶栏下沿到底区上沿，不盖底区与页脚，不挤压主区（`contentWidth` 不变）。宽 < 60 时整屏只显示"终端太小"，抽屉不设宽度回退分支（已删除 F4 5.1 的"宽 − 4"）。关闭方式：`esc`、点击背景（有文本选区时不关）、再按开关键、`/sidebar`。背景点击不用覆盖主区的命中盒（它会吞掉转录的滚轮与选区），而是 `AppFrame` 主区列的 `onMouseUp`：点击从落点冒泡上来，抽屉是兄弟节点，自己的点击不会到这里；只在抽屉显示时传 `onDrawerBackdrop`。子 agent 视图同样能开抽屉，`esc` 先关抽屉再返回父会话。
- 区块顺序固定：会话、上下文、固定开销（#1461）、费用、目标、后台任务（#1058 5）、待办、修改的文件、服务（F4 5.2），最底一行是 `<开关键> 关闭`；“修改的文件”本期隐藏（#1032 D8：H5 之后数据源基本为空），重新启用时按 5.2 的回合结束后 HTTP `diff` 取数；DAG 模式状态一行（`DAG 模式 开 {key}` / `DAG 模式 关`，`{key}` 取 `session.dagmode.toggle` 的实际绑定）在费用与目标之间，只读、不可点击，子 agent 视图没有这一行。新增区块要写明：位置、数据来源、空状态（隐藏或占位）、是否随子会话变化（上下文、固定开销、待办、文件跟随子会话；费用按根会话整棵任务树汇总，子 agent 视图另加一行“本会话”；目标与后台任务始终是根会话；LSP、MCP 全局）。
  - 后台任务区块（`routes/session/drawer.tsx` 的 `DrawerBackground`）：位置在目标与待办之间；数据来源是根会话的后台 Task（`taskIndex`、job 的 lifecycle 镜像、子会话摘要，状态由 `session/background.ts` 判定），只列运行中与排队中的运行，已结束的在 `/agents`；空状态为隐藏（不占位、不占间隔）；子 agent 视图里仍显示根会话的后台任务（同目标区块）。标题 `后台任务 n`（`background.drawer.title`，n 是运行中加排队中的全部，不设上限），至多 3 行，运行中的在前、排队的在后，各自新到旧；每行是标记（运行 `●` 用 `statusRunning`，排队 `○` 用 `statusQueued`，都是静态字符）、`kind · 描述`（名字同 `/agents`，描述经 `remoteLine`）和运行中那一行右对齐的耗时（`formatDagDuration`：`58s`、`2m 14s`，从开始运行的时刻起算、不含排队，排队的没有耗时）；超出的在最后一行写 `… 还有 k 个 · /agents`（`background.drawer.more`）。每行按 `DRAWER_TEXT_CELLS`（抽屉宽 − 6，留出内边距与滚动条列）用 `truncateCells` 截断，先截描述，窄到名字与耗时放不下时去掉耗时。耗时只在抽屉打开且列出的行里有运行中的时订阅一份 `ticker.second`（排队的没有耗时，不订阅）；抽屉关闭时区块不创建，订阅为 0。纯逻辑在 `drawer-model.ts` 的 `backgroundSection`、`backgroundRunLine`，测试在 `test/routes/session/drawer-model.test.ts`、`drawer-content.test.tsx`。
  - 固定开销区块（`routes/session/drawer.tsx` 的 `DrawerOverhead`，#1461）：位置在上下文与费用之间；数据来源是 `sync.data.overhead[会话]`（`GET /session/:id/overhead`，服务端按请求记的清单，TUI 不自己估算），会话取屏幕上的那个，所以子 agent 视图显示子会话自己的；空状态为隐藏（不占位、不占间隔）：服务端还没有这个会话的请求（回零）、未读到、读取失败时都没有区块。标题 `固定开销`（`drawer.overhead`），第一行是总量与占窗口的份额 `≈{tokens} tokens · {percent}%`（`drawer.overhead.total`，`tokens` 用 `toLocaleString("en-US")`，`percent` 是取整的 `ratio`，窗口来源是 `default`（模型没声明窗口，用的是假定的窗口）时百分比前加 `~`，约定同上下文区块的 `estimateMark`），其后是 `tokens` 最大的前 5 个来源，从大到小，每行 `≈<tokens> <source> <label>`（`source` 是服务端给的来源名原样，不译；`label` 是 instructions 段读取的文件，经 `remoteLine` 去转义，没有就不写）。每行按 `DRAWER_TEXT_CELLS` 用 `truncateCells` 截断，只读，不可点击，颜色 `textMuted`。
    - 读取只在区块挂载期间：`DrawerOverhead` 里唯一的 `createEffect` 调 `sync.overhead.watch(sessionID)`，`onCleanup` 里调返回的函数放手；体内不写 store（答案由 `sync` 在读取完成后写 `overhead` 片）。抽屉关闭时区块不创建，计数归零，之后的 `session.turn.settled` 不再引起读取；换到另一个会话时放手旧的、watch 新的。
    - 预算：`store.message`、`store.part` 写入 0（只写 `overhead` 片，答案与已有值相同时不产生变化）；空闲、无新事件时帧数 0；不订阅 `ticker`；不注册 keymap layer。
    - 纯逻辑在 `drawer-model.ts` 的 `overheadSection`，测试在 `test/routes/session/drawer-model.test.ts`、`drawer-content.test.tsx`（80 与 120 列、两种语言、`ambiguous_width` 为 1 与 2 不溢出，点击无写请求，抽屉关闭后无 `/overhead` 请求）、`test/cli/cmd/tui/sync-overhead.test.tsx`（三个触发点、合并、重连、删除、失败、放手）与 `test/app-overhead.test.tsx`（真实 App 里的区块与告警 toast）。
  - 费用区块（`routes/session/drawer.tsx` 的 `DrawerCost`，#1475）：位置在固定开销与 DAG 模式行之间；数据来源是 `sync.data.usage[根]`（`GET /session/:id/usage`：根会话、task 子 agent、DAG 节点会话整棵树，由服务端汇总，TUI 不自己加总），根取 `SessionDrawer` 已有的 `rootID()`，所以主会话与子 agent 视图读的是同一份。`usage` 未加载时只有一行 `—`；加载后依次是总费用（`costLabel`：有未标价的部分写 `$x + 未知`，全部未标价写 `未知`，不写 `$0.00`）、`输入 · 输出`、`推理`、`缓存 读 · 写`（数字用 `formatDagTokens`，键 `drawer.usage.*`），屏幕上是子 agent 时末尾再加 `本会话 {cost}`（`drawer.cost.session`，用该会话自己的 `cost` 与 `tokens`，经 `unpriced` 判定）。每行按 `DRAWER_TEXT_CELLS` 用 `truncateCells` 截断，只读，不可点击。
    - 读取只在区块挂载期间：`DrawerCost` 里唯一的 `createEffect` 调 `sync.usage.watch(rootID)`，`onCleanup` 里调返回的函数放手；体内不写 store（答案由 `sync` 在读取完成后写 `usage` 片）。抽屉关闭时区块不创建，计数归零，之后的 `session.turn.settled` 不再引起读取；换到另一棵树时放手旧根、watch 新根。
    - 预算：`store.message`、`store.part` 写入 0（只写 `usage` 片，答案与已有值相同时不产生变化）；空闲、无新事件时帧数 0；不订阅 `ticker`；不注册 keymap layer。提示框的费用段仍是会话自己的 `cost`，`cost` 为 0 而有用量时写 `未知`，没有用量时不显示（不 watch，不发请求）。
    - 纯逻辑在 `drawer-model.ts` 的 `usageLines`，测试在 `test/routes/session/drawer-model.test.ts`、`drawer-content.test.tsx`（80 与 120 列、两种语言、`ambiguous_width` 为 1 与 2 不溢出，点击无写请求，抽屉关闭后无 `/usage` 请求）、`test/cli/cmd/tui/sync-usage.test.tsx`（三个触发点、合并、重连、删除、失败、放手）与 `test/prompt/usage-segment.test.tsx`。
- 区块是纯展示函数组件。抽屉关闭时不创建任何区块组件、不订阅任何数据。抽屉里不放任何操作按钮。
- 显示策略 kv `drawer_mode`（`hidden` 默认 / `auto` / `always`），不读旧 kv `sidebar`。`auto` 跟随实时宽度（> 120 列打开）。开关键、`/sidebar`、`esc`、背景点击只改内存里的手动状态（`useDrawer`，按 kv 实例各一份，不落盘），当次运行内优先于 `drawer_mode`；在 `/config` 改策略（`drawer.setMode`）时清掉手动状态，新策略立即生效（#1032 D7）。

必须写的测试：80 与 120 列快照；两种语言 80 列不溢出换行；`ambiguous_width` 为 1 和 2 时 80 列都不溢出（状态带、抽屉）；写请求计数为 0；抽屉关闭时订阅计数为 0。

### 6.5 新增 toast

- 形状：`{ text, level: info|success|warning|error, duration?, onActivate?, dedupeKey? }`。只经页脚右侧的共享位置显示，不自建浮层。`grep -rn "<Toast" packages/tui/src` 只命中页脚一处。
- 页脚右侧是一个共享位置，优先级：leader 待选提示 > toast > hook 执行进度。toast 显示期间替换按键提示；hook 进度（F3 8）也占这个位置，不再放页脚左侧。
- 同时最多显示 1 条，排队最多 3 条。溢出先丢最旧的 `info`，再丢最旧的 `success`，队列里只剩 `warning`、`error` 时才丢最旧的一条：较新的 `success` 不会把仍在排队的警示挤掉。
- 相同 `dedupeKey` 10 秒内合并。新增 toast 必须声明自己的 `dedupeKey`。
- `onActivate` 存在时点击触发（如 F5 的"点击进入"）。
- 时长经 `ticker.at`，不得自建计时器。默认 4 秒，`error` 8 秒（F3 9）。
- 变体颜色：`info` 用 `text`，`success` 用 `success`，`warning` 用 `warning`，`error` 用 `error`。
- 超宽错误被截断，完整文本写日志并进 `/status` 的"最近消息"（最近 20 条），页脚附 `… /status`。
- 来源侧的去重规则：预算警告档每会话每档至多一次（F4 7.1），这一份由服务端发出，TUI 不自弹第二份；固定开销告警（#1461）同理：根会话每次请求带的固定内容超过模型窗口的 25% 时，服务端对每个会话的每个模型发一次 `tui.toast.show`（标题 `Fixed request overhead is large`，`warning`，8 秒），页脚显示 `<title>: <message>`，TUI 不自弹，快照加载与重连刷新也不弹，常驻显示是抽屉的固定开销区块；PR 状态只在事件引起的迁移时弹，快照加载与重连刷新不弹，`cancelled` 不弹（F6 2.4）；唯一例外是纯由时间引起的“已通知”到“未响应”，到点弹一次：tracker 的 effect 在到点之后第一次重算时弹（回调比到点晚几毫秒，期间的读取或别的 watch 的事件可能先重算，不能因此吞掉它）。只有时钟自己的那一步才算：同一条目、同一份通知（`prNoticeAt` 相同）在自己的 `nextAt` 过后由 `awaiting`/`notified` 变成 `unresponsive`（`prClockMoved`）；读取在这段时间里带来的别的差异（条目被换掉、结果变了、`noReply`、失败的回合、CI 计数）一律静默并入，快照与重连仍不弹。toast 键按 watch 加迁移区分（`pr:<watch>:<结果或警示种类>`），所以不同迁移不会互相合并；同一 watch 先因通知积压超过三分钟弹过一次“未响应”、送达后又三分钟没回应时，按通知（`prNoticeAt`）各弹一次，同一份通知不重复弹。
- 后台运行结束的 toast（#1058 7，`attention/notify.ts`）：触发是结果 part 的 `message.part.updated` 事件（通过 `backgroundResultOf` 的 synthetic 文本，服务端写进启动该运行的会话），不是子会话的 `session.status`/`session.error`；快照加载、hydrate、重连刷新不走事件通路，所以不弹，同一子会话同一 `endedAt` 的结果重复到达也只弹一次。只对当前根会话的树，正在看那个子会话时不弹；完成用 `background.toast.done`（`success`），失败与已中断用 `background.toast.failed`（`error`），`dedupeKey` 是子会话 id。点击（`onActivate`）把用户带到结果所在的会话并滚到结果消息（`openResult(sessionID, messageID)`，跳转见 `routes/` 一节），落在结果卡上。toast 只能用鼠标点击激活（`shell/footer-status.tsx` 的 `onMouseDown`），没有键位，所以文案写“点击查看”，不写 `⏎`：主会话输入框有焦点时 `⏎` 会提交草稿。同一子会话 10 秒内的第二个结果与第一个合并（`dedupeKey` 相同，`ui/toast.tsx` 的 `merge` 换成第二个的文字与点击目标并重新起算窗口，不叠成两个）；第一个已经消失（成功 4 秒、失败 8 秒之后）就是一个新 toast。前台子 agent 的结束不弹，权限请求的 toast（`subagent.toast.permission`，点击进入该子 agent）不变。
- 服务端 `tui.toast.show` 事件走同一入口。

必须写的测试：页脚位置快照；排队与溢出；`dedupeKey` 合并；`onActivate`；超长截断。

### 6.6 新增设置项

- 在 `/config` 的 `SettingsPanel` 加一行。`SettingRow` 的 `kind` 只有 `choice`、`toggle`、`text`、`action`。选项超过 6 个或为异步数据时用 `action` 推入 `ListPanel`。
- 每一行必须有真实的存储位置，没有存储的行不上线。PR 描述写明这一行的存储位置。
- 存储归属：只属于 TUI 的偏好放 kv（如 `animations_enabled`、`drawer_mode`、`dag_band`、`conceal_code`、`ambiguous_width`）；服务端也要读的放主配置的全局层，经 C1 的"写全局配置"接口落盘（如 `language`、`claudeCompat.hooks`、`dag.mode`、`dag.concurrency`、`dag.budget.tokens`）。项目层写这些键不生效并告警。
- 服务端对某个值另有生效值的行（`dag.concurrency`：配置值会被子 agent 池夹住，没配置时由调度器给默认值）：行里显示服务端读口给出的生效值，配置值与生效值不同时两者都显示，TUI 不自带默认值常量；没有读口的数据时（首页）只显示配置值，未设置就显示“未设置”（#1290）。
- C1 接口未就绪或 schema 缺失时，该行只读显示，不做空壳。
- `text` 行用 `validate` 返回错误文案键（非空则不提交）；`suffix` 用于行尾淡色附注。需要打开前确认的（如 Claude hooks 兼容）先出询问区 `confirm` 变体。
- 界面文字的切换（语言、主题）立即生效；语言只影响默认回复语言这一条系统提示指令。
- 行的版式（#1617）：每行三列，标记 2 格、名称 22 格、值紧跟名称。名称最多 21 格（末格留空），超出按 `cellWidth` 截断，所以新增行名中英都要核对，超了就改短。值后面依次是 `suffix` 与选中行的“换一个（i/n）”提示；选中行的 `description` 画在面板底部的说明行里（`PanelShell` 的 `note`），一行放得下就不要写长。
- 只汇报、不持有设置的行（快捷键）用 `readonly`：正常着色，可选中看说明，回车与点击不做任何事。写入路径不可用的行用 `disabled`：变暗且不可操作，原因写在 `suffix` 里（子 agent 视图里改会话模型的两行就是这样，因为那会向子会话发写请求）。

`/config` 的标签与行（#1617）。标签顺序固定：通用（`general`）、界面（`interface`）、模型（`model`）、DAG 模式（`dag`）、权限（`permissions`）、快捷键（`shortcuts`）；`/config` 默认打开界面，`/permissions` 打开权限。每一行的存储位置：

| 标签     | 行                                       | 种类                | 存储                                                                                                                                                                  |
| -------- | ---------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通用     | 语言                                     | choice              | 全局配置 `language`                                                                                                                                                   |
| 通用     | 自动压缩                                 | toggle              | 全局配置 `compaction.auto`（未设置按开）；`compaction.trigger_ratio` 已设置时在行尾注明百分比，行里不带默认值                                                         |
| 通用     | 文件上下文                               | toggle              | kv `file_context_enabled`                                                                                                                                             |
| 通用     | 粘贴摘要                                 | toggle              | kv `paste_summary_enabled`                                                                                                                                            |
| 通用     | 按目录过滤会话                           | toggle              | kv `session_directory_filter_enabled`                                                                                                                                 |
| 通用     | 终端标题                                 | toggle              | kv `terminal_title_enabled`                                                                                                                                           |
| 界面     | 主题                                     | action              | kv `theme`（推入主题面板）                                                                                                                                            |
| 界面     | 主题模式                                 | choice              | kv `theme_mode_lock`、`theme_mode`                                                                                                                                    |
| 界面     | 动画                                     | toggle              | kv `animations_enabled`                                                                                                                                               |
| 界面     | 推理过程                                 | toggle              | kv `thinking_mode`（`show`、`hide`）                                                                                                                                  |
| 界面     | 时间戳                                   | toggle              | kv `timestamps`                                                                                                                                                       |
| 界面     | 工具详情                                 | toggle              | kv `tool_details_visibility`                                                                                                                                          |
| 界面     | 通用工具输出                             | toggle              | kv `generic_tool_output_visibility`                                                                                                                                   |
| 界面     | 滚动条                                   | toggle              | kv `scrollbar_visible`                                                                                                                                                |
| 界面     | 差异换行                                 | toggle              | kv `diff_wrap_mode`                                                                                                                                                   |
| 界面     | 抽屉                                     | choice              | kv `drawer_mode`                                                                                                                                                      |
| 界面     | 代码块隐藏                               | toggle              | kv `conceal_code`                                                                                                                                                     |
| 界面     | DAG 状态带                               | choice              | kv `dag_band`                                                                                                                                                         |
| 界面     | 字符宽度                                 | choice              | kv `ambiguous_width`                                                                                                                                                  |
| 模型     | 当前模型                                 | action              | `local.model` 的 `model.json`（按 agent 记）；回车经命令注册表运行 `model.list`，打开 `/model` 的列表面板                                                             |
| 模型     | 推理强度                                 | choice 或 action    | `local.model.variant`：选项是 `default` 加当前模型的变体，调用与 `panel/variant.tsx` 相同；超过 6 个选项时为 action，打开 `VariantPanel`；当前模型没有变体时不可操作 |
| 模型     | 标题模型                                 | text                | 全局配置 `small_model`（`provider/model`，必须是已连接 provider 的模型）；只能设置，合并写入没有清除一个键的语义，所以空值不能提交，清除要改配置文件                   |
| DAG 模式 | 新会话默认 DAG 模式                      | toggle              | 全局配置 `dag.mode`                                                                                                                                                   |
| DAG 模式 | DAG 并发上限                             | text                | 全局配置 `dag.concurrency`（生效值的显示见上）                                                                                                                        |
| DAG 模式 | DAG token 预算                           | text                | 全局配置 `dag.budget.tokens`                                                                                                                                          |
| 权限     | 编辑、Bash、网络请求、项目外目录         | choice              | 全局配置 `permission.<工具>`                                                                                                                                          |
| 快捷键   | 命令标题（值是按键，说明取命令的 `desc`） | action（`readonly`） | 不存储：由 keymap 生成，与 `/help` 共用 `panel/help.tsx` 的 `useShortcutEntries()`（跳过 `hidden`、没有标题、`Panel` 分类、没有键位的命令），按分类与标题排序 |

写入 `compaction`、`small_model` 与写 `language`、`permission` 一样，全局配置里除 `dag` 外的键都不在 `HOT_RELOAD_GLOBAL_KEYS` 里，写入后实例会重建。

没有真实存储的行不上线。设计原型里有、现在没有可用存储的行，不为它们新增配置键，列在这里（#1617）：

| 原型的行                                                                       | 现状                                                                                                                                                                                                                                                                                                                        | 处理                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 完成通知（任务完成时 / 需要我输入时 / 关闭）                                   | 没有三选一的存储。`tui.json` 里有 `attention.enabled`（默认 false）、`attention.notifications`、`attention.sound` 三个布尔值，是文件配置；`/config` 目前只能写 kv 与全局配置层（`sdk.client.global.config.update` 写的是 `graphagent.json`），没有写 `tui.json` 的路径                                                          | 跳过                                                |
| 检查更新（开 / 关）                                                            | `autoupdate` 键还在 schema 里，但描述写明“Deprecated compatibility setting; built-in application updates are disabled and this value is ignored”，旧的升级接口也只回 400（`groups/global.ts`：Built-in updates disabled），没有任何功能可开关                                                                                | 跳过；#1281（安装、升级与远程配置并入主程序）落地后再加 |
| 窄终端（自动 / 始终紧凑）                                                      | 断点是固定常量（顶栏 `TOP_BAR_WIDE_WIDTH`、状态带 `BAND_NARROW_WIDTH`、面板 `PANEL_NARROW_WIDTH`，都是 100 列），没有设置项                                                                                                                                                                                                | 跳过                                                |
| 推理过程、工具输出的三态（折叠 / 展开 / 隐藏，超过 6 行折叠 / 全部展开 / 只显示标题） | kv 只有两态（`thinking_mode` 的 `show`、`hide`；`tool_details_visibility`、`generic_tool_output_visibility` 两个开关）                                                                                                                                                                                                       | 保留现有的两态行，不合并成三态                      |

必须写的测试："每行指出存储位置"遍历测试（`test/panel/config.test.tsx` 的 `STORES` 与上面的行表一一对应，加一行要两处一起改）；C1 接口 mock 不可用时只读；值写入后的读回。

### 6.7 新增预填模板

- 只预填，永不自动提交。文本生成在功能目录（`dag/prefill.ts` 等纯函数），落地动作统一调用 `session/prefill.ts` 的 `prefillRootPrompt(text)`：导航到根会话 → 追加到草稿末尾并另起一行（不覆盖）→ 聚焦输入框 → 不提交。F3、F4、F5 的预填都调用它，不另写落地逻辑。
- 文字经 `t()` 生成，随界面语言变化。
- 模板出现与否只按显示状态筛选（如 `retry` 只对 `failed` 节点），仅为减少无效请求，不是权限判断。是否执行由主 agent 决定。
- 新增一种模板：在 `dag/prefill.ts` 的 `DagRequestKind` 加一个值，并改 `dagRequestKinds`（出现条件）与 `dagRequestText`（文字）；两种语言各补键。非 DAG 用途在对应功能目录新建纯函数，同样经 `prefillRootPrompt`（先例：`session/subagents.ts` 的 `subagentRelayText`，按子 agent 的状态选 `background.prefill.*` 或 `subagent.relay.prefill`）。审阅时核对：`grep -rn "prefillRootPrompt" packages/tui/src` 应命中全部预填调用点，组件里没有直接写输入框内容的预填代码。
- 子会话权限询问的"拒绝并请主 agent 转达"：先回复一次不带说明的 `reject`，再回根会话预填"请转告子 agent <kind · 描述>："。

必须写的测试：出现条件；预填结果与焦点；`session.prompt` 调用为 0；有草稿时追加；两种语言各一份快照。

## 7. 主题与样式

- 只用 token。组件里禁止写颜色字面量。检查：`grep -rnE "#[0-9a-fA-F]{6}\b|RGBA\.from" packages/tui/src --include=*.ts --include=*.tsx | grep -v "^packages/tui/src/theme/"` 只允许命中下面三处，新增例外必须改本规范并在 PR 里说明理由：
  - `context/local.tsx` 的 `RGBA.fromHex`：解析用户配置里 agent 的 `#rrggbb` 颜色，不是内置颜色。
  - `component/error-component.tsx` 的两套固定配色（镜像 `graphagent.json`）：崩溃的可能正是主题 context，崩溃页不能依赖它。
  - `routes/session/index.tsx` 的 `RGBA.fromValues`：用 `warning` token 的通道值加 `thinkingOpacity` 合成推理文字色，没有颜色字面量。
- 主区变暗用 `AppFrame` 的 `opacity`（`DIMMED_OPACITY`），不用半透明 box 盖住文字：OpenTUI 对 alpha 小于 255 的填充会把盖住的宽字符（CJK）清成空格，中文转录会整片消失（F1 3.1 原写的"绝对定位的 `RGBA(0,0,0,alpha)` 盒子"因此不再采用，视觉意图不变）。抽屉在变暗层之后，以全强度画在它上方，先后不影响叠放。
- 默认主题 `graphagent`（`DEFAULT_THEME` 常量），位于 `theme/assets/graphagent.json`，深浅两版同一个 JSON。不保留 `opencode` 旧主题，读不到已保存主题名时回到 `graphagent`，不迁移旧值。
- 新增 token 的流程（F1 1.2）：`ThemeJson` 里加可选字段 → `theme/index.ts` 的 `resolveTheme` 里给回退值（照 `backgroundMenu`、`selectedListItemText`）→ `Theme` 类型加同名必填字段 → 旧主题不改。`generateSystem` 走回退值，不显式写。`packages/graphagent/src/cli/cmd/run/theme.ts` 的重复实现要复用 TUI 的 `resolveTheme` 或补同一组回退值，并有一致性测试。
- 现有可选 token：`textDim`、`backgroundSelected`、`backgroundUser`、`borderWarning`、`logoFace`、`logoAccent`、`logoShadow`、`statusRunning`、`statusQueued`、`statusPaused`。已完成用 `success`（灰），失败用 `error`，不再新增。
- 转录里行首标记与底色（#1615，只用 token）：用户消息一行 `›`（`primary`）加正文（`text`），整块底色 `backgroundUser`，悬停只把这一块自己的底色换成 `border`（子 agent 视图不可点，不悬停）；排队标记 `warning`，时间 `textDim`，附件标签 `textMuted`。助手文字 `⏺` 用 `success`。被中断的回合只有一行 `message.interrupted`，`textMuted`，没有标记，缩进与助手文字的正文对齐。推理 `∴` 与文字折叠时整行 `textDim`，打开或进行中仍是 `warning` 合成色（上面第三处例外）。标记占 `MARK_CELLS` 列，折行的续行悬挂在标记之下；`∴` 是 Ambiguous 字形，单行的推理行按 `cellWidth` 截断（`reasoningLine`）。
- 品牌色 `primary`（深 `#4fa3f0`，浅 `#1f6fc4`）白名单，其余位置一律用灰：
  1. logo 的 AGENT 字面和顶栏小标记的 `◆`。
  2. 列表、设置、询问里的选中行（符号和文字）及面板标题。
  3. 正在运行的东西：运行中 spinner、DAG 运行段、运行中状态符号（静态）。
  4. 页脚里当前 agent 名。
  5. 页脚 DAG 指示的 `◆ DAG`（开，F1 3.9）。
  6. 状态带行首的 `◆`（F4 1）。
  7. 输入框提示符 `›`（shell 模式为 `$`，#1616）。
  8. 用户消息行首的 `›`（#1615）。

  输入框提示符 `›` 在 #886 收口时曾决定不做并从白名单删去（输入门禁与光标几何风险高，收益只是一个装饰字符），由 #1616 按设计原型恢复，现为第 7 项。风险靠结构守住：`›` 是与 textarea 并排的独立 `<text>`（宽 2 的一列），画在 textarea 之外，不进 textarea 的内容与光标坐标；`test/prompt/composer-chrome.test.tsx` 逐项守住输入门禁与光标位置，`test/shell/brand-color.test.tsx` 用真实渲染的输入框核对 `›` 与 `$` 为 `primary`。用户消息行首的 `›`（第 8 项）是只读的转录文字，没有输入门禁与光标，那条理由不适用。

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
- 键名规则：`area.name`，点分，如 `subagent.readonly`、`dagmode.footer.on`、`command.session.new.title`、`error.child_session_read_only`。同一功能的键共用前缀（`dagmode.band.*`、`dagmode.panel.*`、`dagmode.drawer.*`、`dagmode.prefill.*`、`dagmode.budget.*`、`background.row.*`、`background.card.*`、`background.band.*`、`background.drawer.*`、`background.agents.*`、`background.prefill.*`、`background.toast.*`、`trust.band.*`）。
- `i18n/zh-CN.ts` 与 `i18n/en.ts` 两张表键集合必须完全相同，每个键的占位符集合相同，没有空字符串。一致性测试由 F1 提供；缺任何一个键测试失败。
- 禁止在组件里拼接中文字符串。带变量的文案用占位符，不用字符串拼接。检查：F1 的 AST 扫描测试遍历 `packages/tui/src`（排除 `i18n/`）的字符串字面量与 JSX 文本，不得出现 CJK 字符（注释不计）。
- 按键名放进文案时用 `{key}` 占位，由 keymap 当前绑定填入；后备文本里不含 `{key}`。
- 80 列下两种语言都不得溢出换行。涉及状态带、页脚、顶栏路径、面板的新文案，各补一份 80 列快照。
- 语言来源：主配置 `language: "zh-CN" | "en"`；未配置时由 `resolveLanguage(config, env)` 推断，判断不出回退 `en`。优先级：用户在对话中明确要求的语言 > 配置 > 推断 > `en`。切换语言不需要重启，`t()` 读取语言 signal；已渲染的历史回执随之重新渲染（`renderDagModeReceipt`）。
- 品牌措辞与 B4 一致；上游产品词（`opencode`、`anomalyco`）由 `script/check-tui-text.ts` 的品牌词守卫在 `bun test` 里检查（第 10 节），不再靠 grep 和审阅。

## 9. 只读原则与安全

只读视图的定义是：TUI 在该视图里没有任何路径产生会改变对应对象的写请求。

- DAG（`/dag` 面板、状态带、抽屉）：不调用任何 `dag.*` 写接口。`grep -rnE "dag\.control|dagControl|dag-cancel" packages/tui/src` 为空；`grep -rn '"message"' packages/tui/src/dag` 为空。测试：在 SDK mock 下完成全部可达操作（选择、展开、`space` 折叠/展开子树、`⏎`、`i`、切标签、点击状态带、开关抽屉）后，`dag.*` 写请求与 `session.command` 均为 0。唯一的写入口是主会话视图里 `<leader>d`，它恰好发一次 `session.command`（`/dag-mode on|off`），状态以服务端为准，TUI 不自存模式状态。
- 子 agent 视图（判定口径 `session.role !== "root"`，由服务端按 `child_binding` 派生，见 `src/session/role.ts`；#1288 之前是 `session.parentID != null`）：无 `Prompt`，底区只可能是 `ask` 或 `panel`；不显示 DAG 模式开关；`esc` 不触发中断；用户消息块不可点击（点击不打开操作列表，选中文本照常可复制）；任务块的提示词折叠时，点击只展开或收起它（视图状态，不发请求，有选中文本时不翻转）。测试：触发所有可达操作（点击消息、命令面板里每个不离开视图的命令、会话键、`←→`、滚轮、`esc`，`test/app-subagent-readonly.test.tsx`）后，SDK mock 的 `session.prompt`、`session.command`、`session.shell`、`session.abort`、`session.revert`、`session.fork`、`session.summarize`、`session.update` 调用次数均为 0。
- PR 行：点击只调用 `open` 打开 PR URL（只放行 `http`、`https`），不复制、不产生写请求（mock 计数 0）。
- 后台标记与后台行：点击只运行命令 `agent.subagents`（打开 `/agents` 面板），不产生写请求（mock 计数 0）；抽屉的后台任务区块里没有任何可点击的东西。
- 信任行：点击只运行命令 `trust.open`（打开 `/trust` 面板），点击本身不产生写请求（mock 计数 0）；信任决定只在面板里提交时才写。
- "请主 agent 处理"= 预填主会话输入框，不提交（见 6.7）。任何停止、取消、重试、调超时都只能这样表达。
- 询问区例外：对已存在的待决请求作选择（`permission.reply`、`question.reply`）不算向子 agent 发送对话内容，回复使用请求自己的 `sessionID`。子会话来源的请求只有选项，没有自由文本。TUI 不识别也不过滤 DAG 节点的请求，自动裁决只在服务端做一次，`ask/` 下不得出现 DAG 相关分支：`grep -rniE "dag" packages/tui/src/ask` 为空。
- 远端字符串（PR 检查名、标题、review 文本、服务端错误等）显示前去掉控制字符与 ANSI 转义。F6 现状更严：PR 行不拉取也不显示 PR 标题和检查名称，review 文本服务端用 `safeReview` 净化后，TUI 渲染前再去一次。以后若加标题，必须先去转义。测试：含控制字符的 fixture 经净化后输出无转义序列。
- 不显示凭据。含密钥的输入行（`SettingRow` 的 `text`、`DetailPanel.input`）设 `secret` 字段（F3 接口）；密钥、授权码、令牌不写日志、不进 toast。审阅时核对：新增的输入行是否设了 `secret`，日志与 toast 文案里是否带出了输入值。

## 10. 测试约定

- 命令（`packages/tui` 下）：`bun run typecheck`（`tsgo --noEmit`）、`bun test`、`bun run bench:tui`。涉及 `run` 模式消费点的 PR 另跑 `cd packages/graphagent && bun run typecheck && bun test test/cli/cmd/run`。
- 渲染测试用 `testRender`（`@opentui/solid`）。快照尺寸：面板、状态带、抽屉、页脚等组件 80×24 与 120×40；骨架测试 80×24、100×30、140×40；宽 < 60 或高 < 12 断言只渲染"终端太小"。
- SDK 用 `test/fixture/tui-sdk.ts` 的假实现。写请求计数是第一类断言：只读视图断言写请求为 0；有写入口的断言恰好 N 次。
- 测试进程不碰用户真实的目录：`test/preload.ts`（`bunfig.toml` 的 `[test] preload`）在任何 `src/` import 之前，把 `GRAPHAGENT_TEST_HOME` 与 `XDG_*` 指到一个临时目录，整个测试结束后删除。原因是 `@graphagent/core/global` 首次 import 时就按 XDG 变量定下 `Global.Path.*` 并建目录，`TuiLog` 的日志文件也在其中，不隔离的话错误路径会往已安装版本的真实日志里追加。新增测试不得读写真实的 HOME 与 XDG 目录；`test/util/log.test.ts` 守住 `TuiLog` 的目标路径。
- 时间用 `@opentui/core` 的 `ManualClock` 推进，不用真实睡眠。`grep -n "setTimeout\|sleep" packages/tui/test/perf/scenarios.ts` 为空。
- 帧数用 `CliRenderEvents.FRAME` 或 `getStats().frameCount`；其余计数用 `test/perf/counters.ts`（`registerLayer`、选择器求值、`frames()`、store 写入）。
- 读帧不能和渲染抢：原生缓冲还在呈现上一帧时，`captureCharFrame()`、`captureSpans()` 会抛 `OutputBusy`。先 `await renderOnce()` 再读；等待画面出现用 `test/fixture/frames.ts` 的 `renderUntilFrame(app, 谓词, 说明)`（每轮先渲染再读帧，按真实时间等，默认 10 秒，超时报告最后一帧；`test/routes/dag-mode-harness.tsx` 的 `waitForFrame` 同样按时限等），一次性读取用 `readFrame`/`readSpans`（遇到 `OutputBusy` 会重新渲染再试；三者都在 `frames.ts`，harness 转出）。不要在 `waitFor` 里裸轮询 `captureCharFrame()`，也不要写固定轮数的 `renderOnce` 循环：渲染轮数不等于真实时间，负载下等的 I/O 还没完成就超了（#1406）。一个进程里同时挂两个场景时，`ThemeProvider` 的模块级 `ready` 会让先挂的场景重建子树，先读完前一个场景的帧再挂下一个。会抛错的挂载要在失败时销毁渲染器（`mountRoute`、`mountSessionShell` 已经这样做），否则它的定时器和帧会继续跑，拖慢并连累同一进程里后面的用例。
- 双语：每个新增可见文案至少一个断言在 `zh-CN` 与 `en` 下各取一次；涉及排版的各一份快照。
- 测试文件 `*.test.ts` / `*.test.tsx`，`packages/tui/test/` 镜像 `src/` 路径（`src/dag/model.ts` → `test/dag/model.test.ts`）。性能基准在 `test/perf/`（F2a）。依赖方向检查是 `test/architecture.test.ts`。现有 `test/cli/cmd/tui/sync-*.test.tsx` 夹具保持原位。
- 源码守卫都在 `bun test` 里运行：`test/source-guards.test.ts` 把第 5、7、11 节里能用 grep 表达的断言（计时器白名单、`Bun.stringWidth`、`BLINK`/`createFadeIn`、`config/keybind.ts` 里的 `dag_` 键、颜色字面量只出现在第 7 节列的三处、旧插件槽 API）固化成按行匹配的测试，注释计入，与文中的 grep 同口径。`script/check-tui-text.ts` 提供三个守卫：品牌词（字符串字面量与 JSX 文本里不得出现上游产品词，白名单 `BRAND_ALLOWLIST` 封闭，每项写明理由）、已下线功能（第 11 节那条 grep 的原文扫描，并检查已删文件没有复活）、英文文案棘轮（绕过 `t()` 的英文字面量只减不增，基线是 `script/english-text-baseline.txt`，`--update-baseline` 只删不增）；它可以在 `packages/tui` 下 `bun script/check-tui-text.ts` 单独运行，`test/i18n/` 里的测试调用同一份实现，第 8 节的 CJK 扫描也在其中。
- 键位处置表：`config/keybind-disposition.ts` 为每个 `Definitions` 键登记处置（`keep | change | new`）和所属上下文层（`Layers`，含 esc 链各层的注册位置与优先级）。漏登记过不了类型检查，`test/keybind-disposition.test.ts` 再双向核对该表、检查同一层内没有重复键、检查已删除的键位名没有复活。
- 删除旧代码时同步删除或改写对应测试（`test/feature-plugins/`、`test/plugin/`），不留失效用例。

每类改动的最低测试：

| 改动                | 最低测试                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 新 `/` 命令         | 注册表三范围快照；提交规则；双语键；只读视图写请求 0                                                                              |
| 新面板              | 80×24 与 120×40 快照；打开/选中/关闭/一个动作；草稿保留；layer 注册不增加                                                         |
| 新键位              | 处置表遍历；同层无重复键；帮助文字随改键变化；涉及 `esc` 时每层一条用例                                                           |
| 状态带行 / 抽屉区块 | 80/120 列快照；双语不溢出；写请求 0；无 `setInterval`；抽屉关闭时订阅 0                                                           |
| 新服务端事件        | gate 决策；非完整集合会话 store 写入 0；重连刷新；乱序；空闲帧 0                                                                  |
| 新消息类型 / 行     | 高度估算；`revision`；窗口化挂载行数；展开状态卸载后保留；可折叠的块有 `fold.ts` 判定（窗口化会话里已卸载的块 `ctrl+o` 也能展开） |
| 新设置项            | 存储位置遍历；C1 不可用时只读；读回                                                                                               |
| 新预填模板          | 出现条件；`session.prompt` 为 0；草稿追加；双语                                                                                   |
| 新 toast            | 页脚快照；排队与溢出；`dedupeKey` 合并；截断                                                                                      |
| 新 token            | 遍历 `DEFAULT_THEMES` 均有值；`run/theme.ts` 一致；对比度与调色板 lint                                                            |
| 新动画 / 计时       | P15–P19 相关用例；`ticker` 订阅与取消；`ambiguous_width` 为 1 和 2 的 80 列用例（对齐敏感布局）                                   |
| 任何渲染路径改动    | `bun run bench:tui` 对照表附 PR 描述                                                                                              |

## 11. 禁止事项清单

每条都有检查方式；"审阅"表示按其后内容核对。

- 不新增全局 store 或 context，F1/F2/F3 定义的除外（`TickerProvider`、`PanelHost`、语言 signal）。FrameClock 由 `SDKProvider` 内部创建，EventGate 由 `SyncProvider` 经 `sdk.setEventGate` 设置，二者没有独立的 provider。审阅：PR 差异里出现新的 `createContext(` 需在描述里说明并经维护者批准。
- 不引入新的 UI 或状态库依赖。审阅：`packages/tui/package.json` 的依赖差异；新增依赖需维护者批准。
- 不在 TUI 里实现任何 DAG 或子 agent 控制。`grep -rnE "dag\.control|dagControl|dag-cancel" packages/tui/src` 为空；`grep -rn "dag_[a-z_]*" packages/tui/src/config/keybind.ts` 为空。
- 不恢复旧插件槽 API。`grep -rn "@graphagent/plugin" packages/tui/src packages/tui/package.json` 为空（不含本文）；`grep -rn "pluginRuntime\|api.slots\|Slot name=" packages/tui/src` 为空；`packages/tui/src/plugin/` 与 `feature-plugins/builtins.ts` 不存在。
- 不加 `plugin` 路由；路由类型只有 `home`、`session`、`diff`；`app.tsx` 不用 `<Show … keyed>` 包 Session。
- 不写颜色字面量（第 7 节 grep）。
- 不在组件内计时：`grep -rln "setInterval\|setTimeout" packages/tui/src` 只命中 `context/ticker.ts`、`context/frame-clock.ts`、`terminal-win32.ts`。
- 不往 `component/` 新增文件：`git diff --diff-filter=A --name-only <基线> -- packages/tui/src/component` 为空。
- 不直接用 `Bun.stringWidth`、不用 `.length` 算宽度（第 7 节）。
- 展示组件与纯函数不调用 SDK（第 3 节 grep）。
- 不用 `reactiveMatcherFromSignal`、不在 `useBindings` accessor 里读随按键变化的信号；`grep -n "cursorVersion" packages/tui/src/component/prompt/index.tsx` 为空。
- 不用旧对话框：`grep -rn "useDialog\|DialogSelect\|DialogConfirm\|DialogAlert\|DialogPrompt\|DialogProvider" packages/tui/src` 为空。
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
- [ ] bun run check:hosts 通过
- [ ] 涉及 run 模式消费点时：cd packages/graphagent && bun run typecheck && bun test test/cli/cmd/run 通过
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
- Q7 品牌色白名单扩为 7 项，新增页脚 `◆ DAG` 与状态带行首 `◆`；#886 收口时删去输入框 `›`（降为 6 项），#1616 按设计原型恢复（`›`，shell 模式为 `$`，第 7 项），#1615 加入用户消息行首的 `›`（第 8 项），现为 8 项。
- Q8 `ui/width.ts` 的 `cellWidth(text)` 按 `ambiguous_width`（1 默认 / 2）计算；对齐敏感布局两种设置下 80 列都不溢出；PR 压缩标记只用 ASCII 与 `✓`、`✗`。
- Q9 预填文本在功能目录生成，落地统一经 `session/prefill.ts` 的 `prefillRootPrompt(text)`。
- Q10 骨架补 `ask/`、`session/`、`attention/`、`context/`；`component/` 冻结。
- Q11 toast 形状 `{ text, level, duration?, onActivate?, dedupeKey? }`，最多显示 1 条、排队 3 条，同 `dedupeKey` 10 秒内合并，时长经 `ticker.at`。
- Q12 `test/` 镜像 `src/` 路径，基准在 `test/perf/`。
- Q13 删除 F4 5.1 的"宽 < 60 取 宽 − 4"分支。
- 依赖方向检查定名 `script/check-tui-imports.ts`，以 `test/architecture.test.ts` 在 `bun test` 里运行，由 F1 落地。
