# 无人值守权限

[English](./unattended-permissions.en.md)

有些会话没有人回答权限询问：DAG 工作流的节点，以及 DAG 模式开启时 `task` 派出的子智能体。本文把它们叫作无人值守会话，讲三件事：它们有多大的自由度（`dag.permission` 三档）、内置安全保险清单拦什么不拦什么、怎样在它们的工具前面接一个外部命令守卫。

这些都不是沙箱。见 SECURITY.md 的 [No Sandbox](../SECURITY.md#no-sandbox)：安全保险清单、三档和守卫 hook 防的是诚实但会犯错的智能体，不是安全边界。需要真正的隔离，请在 Docker 或虚拟机里运行 GraphAgent。

## 三档

`dag.permission` 有三个取值，默认是 `allow`。

| 档位       | 无人值守会话得到什么                                                                                   | 适合                                     |
| ---------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `allow`    | 从不询问。`deny` 规则最先生效，安全保险清单拒绝命中的调用，其余自动放行。                              | 希望工作流不被打断（默认）。             |
| `ask`      | 每一次编辑、每一条 shell 命令、每一次 MCP 工具调用都等你批准。                                         | 想逐步确认，也接受等待。                 |
| `readonly` | 只读的工具面：不能改文件，bash 只剩一小批只读的 git 和 gh 查询，MCP 工具默认不可用，除非你按名字放行。 | 只做调研和审核、不许改任何东西的工作流。 |

档位只作用于无人值守会话。你自己的会话仍然按原来的权限模式、`hookPermissions.mode`、`--dangerously-skip-permissions` 和 agent 规则运行。DAG 模式关闭时的 `task` 子智能体不是无人值守会话，照旧向你询问。

### 怎么设置

写在用户级配置里：配置目录（`GRAPHAGENT_CONFIG_DIR`，没设就是 `~/.config/graphagent`）下的 `graphagent.json` 或 `graphagent.jsonc`：

```json
{
  "dag": {
    "permission": "ask"
  }
}
```

`dag.permission` 只认全局层。写在 `<root>/.agents/settings.json` 或 `settings.local.json` 里的值会被忽略，并给出一条告警，指明文件和键名，所以共享的仓库没办法替你放宽或收紧档位。取值不合法是配置错误。

每次权限请求发生时都重新读取档位，不会缓存到某个工作流或会话上，所以改档后，在途节点从下一次调用起就按新档位走。GraphAgent 对全局配置保留一份快照：经 GraphAgent 自己写入的改动立即生效，手工编辑文件要等配置重新加载后才会读到（保险起见重启一次）。

DAG 模式开启、档位又不是 `allow` 时，主智能体会在 DAG 模式的提示里得知（`ask` 档提示节点会等待，`readonly` 档提示节点只读）。`/dag-mode` 本身不显示也不修改档位。

### `allow`

行为没有变化。无人值守会话的权限请求从不展示给你：

1. 你配置的 `deny` 规则先拒绝，先于一切。
2. 命中安全保险清单（见下）或你在 `dag.safety.extra` 里追加的规则时，调用被拒绝，节点收到一条指明规则和原因的工具错误，继续运行。拒绝会记在节点上，`inspect`、覆盖段和最终报告里都能看到。
3. 你自己写的、带具体 pattern 的 allow 规则（`bash: {"npm publish *": "allow"}`）可以放行 SF-1 至 SF-5 和 `SX-n`。整键的 allow（`bash: "allow"`）不行，SF-6 任何 allow 都放行不了。
4. 其余全部放行，包括本来会询问的那些。

### `ask`

无人值守会话的每次编辑（`edit`、`write`、`apply_patch`）、每条 shell 命令、每次 MCP 工具调用都变成一条权限询问，和别的询问一样展示，来源是该节点自己的会话。这一档不运行安全保险清单，由你逐条判断。`deny` 规则仍然直接拒绝，不询问。

下面这些调用不需要询问：

- 你自己的 allow 规则带具体 pattern 就能覆盖的调用：`bash: {"bun test*": "allow"}` 让 `bun test` 直接执行。MCP 工具的 allow 要写明确切的工具名，不带通配符；`bash: "allow"` 和 `mcp_*` 都不算。
- 同一个会话里你已经回复过“始终允许”的 pattern。回复不会带到别的节点。

读取和搜索类工具（`read`、`grep`、`glob`）、`agent` 工具和其他权限键不会多问。原本就会问的仍然会问：项目外的路径、`.env` 文件、重复调用、规则写成 `ask` 的调用，以及 hook 返回 `ask`。hook 返回的 allow 和 `acceptEdits` 都不能跳过这一档发出的询问。配置了 `hookPermissions.mode: dontAsk` 时，这类调用直接被拒绝，不询问。

你拒绝一条请求后，该子会话的当前回合结束，节点的这次 attempt 按引擎的一贯方式收尾。等你回复的节点仍然占着并发槽位，等待时间也计入节点超时，你不在时节点会超时。图要保持小。

`graphagent run` 没有人可以回答：它自动拒绝节点和 task 子会话的询问，不会卡住，启动时往 stderr 打印一行档位提示。`--dangerously-skip-permissions` 仍然只作用于主会话。

### `readonly`

这一档下，含有会写入的节点的工作流启动不了：`start`、`extend`、`replan`、`recover`、`retry` 都会拒绝，报错里写明是 `dag.permission` 的缘故。草稿和校验不受影响。如果在写入节点运行中途切到 `readonly`，该节点不会被取消，它之后发出的编辑请求会被拒绝。

无人值守会话（包括 `task` 子智能体）得到的工具面是：

- 没有 `edit`、`write`、`apply_patch`。
- `bash` 只能执行内置 `review` agent 允许的那批只读 git 和 gh 查询（`git diff`、`git log` 之类）。其他命令一律拒绝，`npm test`、`rm`、`git commit` 也不例外。你自己写的 allow 规则放不宽它：想放宽就换档。
- MCP 工具默认拒绝，除非你的配置按名字放行了那一个工具。`server_*`、`*` 这样的通配符不算。
- `read`、`grep`、`glob` 和 `agent` 工具照常可用。

这一档从不询问。需要你批准的调用（比如读项目外的路径）按规则 `RO-1` 拒绝。安全保险清单照常生效，而且排在前面，各按自己的编号拒绝：凭据文件是 SF-2，重复调用是 SF-5，hook 返回 `ask` 是 SF-6。被工具面拒绝的调用只是普通的规则拒绝，不记为安全拦截。

这只是收窄工具面，不是隔离：`bash` 的名单是对命令文本的字面规则，shell 可以经由重定向写文件，没有规则会读到它。

## 安全保险清单

在 `allow` 档里，以及在 `readonly` 档适用的范围内，无人值守会话的调用要过下面这些规则，每次拒绝都带着编号：

| 编号 | 拒绝                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SF-1 | 项目外写入：`edit`、`write`、`apply_patch` 的目标。shell 命令里点名了项目外路径（`cd`、`rm`、`cp`、`mv`、`cat` 等）或在项目外的 `workdir` 里运行，读取也算。 |
| SF-2 | 用 `read`、`grep`、`glob` 读凭据文件：`.env` 和 `.env.*`（`.env.example` 等除外）、`*.pem`、`*.key`、SSH 密钥和 `.ssh/**`、`.aws/credentials`、`.npmrc` 等。 |
| SF-3 | 破坏性命令：`git reset --hard`、`git clean`、force push、`sudo`、`shutdown`、`reboot`、`mkfs*`、`dd ... of=/dev/...`。                                       |
| SF-4 | 对外发布：`npm publish`、`pnpm publish`、`yarn publish`、`yarn npm publish`、`cargo publish`、`docker push`、`gh release ...`、`gh pr merge`。               |
| SF-5 | 重复完全相同的调用（死循环）。                                                                                                                               |
| SF-6 | 需要人确认的调用：hook 返回 `ask`，或声明需要用户交互的 MCP 工具。                                                                                           |
| SX-n | 你在全局 `dag.safety.extra` 里追加的规则，只能拒绝。                                                                                                         |
| RO-1 | 仅 `readonly` 档：需要你批准的调用。                                                                                                                         |

清单只看结构化的事实：权限键、原生工具给出的路径、请求由哪个工具发起，以及对单条简单命令的字面通配符。它从不解释 shell 文本。

### 它不覆盖什么

下面这些是设计如此。想覆盖它们就得去解析 shell，而且解析出来仍然不是边界。

- shell 工具自带的路径检测看不到的项目外写入：重定向（`> ../x`）、`tee`、`sed -i`、`ln`、改变工作目录的包装器（`env -C`）。
- 在 shell 里读凭据文件（`cat .env`、`grep -f`），以及对含有凭据文件的目录做 `grep` 搜索。
- 任何改变命令原文的写法：`env X=1 git reset --hard`、`command git ...`、变量与函数、`bash -c '...'`、`curl ... | sh`。字面规则表读不到它们。
- 推送到默认分支（`git push origin main`）：除 force push 外的 `git push` 一律放行。
- 原生工具周围的文件系统花样：硬链接、检查与访问之间路径被替换、Windows 特有的路径写法，以及 MCP 工具的路径参数。

想要更强的兜底：加 `deny` 规则或 `dag.safety.extra`，在工具前面接外部命令守卫（见下一节），或者在 Docker、虚拟机里运行。

## 在工具前面接命令守卫

GraphAgent 对子会话的工具调用同样会运行你的 PreToolUse hook，时间早于工具自己的权限请求。hook 返回 `deny`，调用就停下：工具不执行，模型收到 `[Tool denied by hook] <原因>`，会话继续。所以命令守卫（读一条 shell 命令、拦下危险命令的程序）适合做成 hook。

GraphAgent 不内置、不下载、不分发任何守卫，代码里也不引用其中任何一个的实现。守卫由你自己安装，再接进来。

### 配置

放在用户级的 hooks 文件里：配置目录下的 `hooks.json`（通常是 `~/.config/graphagent/hooks.json`）：

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "/absolute/path/to/guard",
          "inputFormat": "claude-code",
          "timeout": 10,
          "onFailure": "block"
        }
      ]
    }
  ]
}
```

- 用用户级文件。它不经信任确认就加载，项目关不掉它：项目 `hooks.json` 或 `hooks.local.json` 里的 `disableAllHooks` 只关项目这一侧，碰不到你的全局 hook（#1325）。只有你自己全局文件里的 `disableAllHooks` 才能关掉守卫。
- `inputFormat: "claude-code"` 让为 Claude Code 写的守卫看到它期望的名字（`Bash`、`tool_input.command`）。matcher 无论选哪种输入格式，都用 Claude 的工具名（shell 工具是 `Bash`）。
- `command` 写绝对路径。裸命令名会按 GraphAgent 进程的 `PATH` 查找，它可能比你的 shell 里的短。在默认的失败行为下，启动不了的守卫等于没装。
- `timeout` 的单位是秒（默认 30）。要留够守卫给出答复的时间。
- `onFailure` 决定守卫坏了意味着什么。默认情况下，hook 启动不了、超时、退出码不是 0 或 2、输出无法解析，都只产生一条告警，调用照常执行（fail-open）。写 `"onFailure": "block"` 则改为拒绝该调用（fail-closed）。用户级 hook 对你所有的会话生效，所以用 `block` 时，守卫坏掉也会拒绝你自己会话里的 shell 命令。请有意识地选，并用一条它该拒绝的命令验证一次。

hook 文件改动后会自动重新加载。

### 守卫看到什么

无人值守会话的工具类事件（`PreToolUse`、`PostToolUse`、`PostToolUseFailure`）带的 `permission_mode` 随档位而定：

| 档位       | `permission_mode`                                                          |
| ---------- | -------------------------------------------------------------------------- |
| `allow`    | `dontAsk`：没有人可问，拿不准的守卫应该拒绝。                              |
| `readonly` | `plan`：会话是只读的。                                                     |
| `ask`      | 不覆盖，保持会话原来的值（`default`，或你配置的 `hookPermissions.mode`）。 |

`allow` 和 `readonly` 两档下会话做什么由档位决定，所以这个值会盖过你配置的 `hookPermissions.mode`。你自己的会话，以及 DAG 模式关闭时的 `task` 子智能体，取值不变。子会话还会带 `agent_id` 和 `agent_type`。

`allow` 和 `readonly` 两档下不会有询问到你这里，所以无人值守会话不会运行 PermissionRequest hook。`ask` 档下照旧运行。

### 守卫的答复起什么作用

| 守卫答复             | 效果                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `deny`（或退出码 2） | 调用不执行，模型收到 `[Tool denied by hook] <原因>` 后继续。三档都一样。                       |
| `ask`                | `allow` 和 `readonly` 档：没有人可问，按 SF-6 拒绝。`ask` 档：询问到达你这里，由你的答复决定。 |
| 无输出、`allow`      | 调用进入正常的权限流程。                                                                       |

DAG 节点的调用被 hook 拒绝时，GraphAgent 把它当作安全拦截记在节点上：一条 `NodeSafetyDenied` 事件，规则是 `HOOK`，权限键取该工具对应的键，摘要是 hook 给的原因（截到 200 字符）。原因会随节点一起保存，守卫不要把命令里的机密回显进去。它出现在节点的 `inspect` 状态里、覆盖段里（`safety denied: HOOK`），以及节点和工作流报告的拦截计数里，所以主智能体知道这次调用被拒绝了。它不产生独立的唤醒。三档都是如此，守卫 fail-closed（`onFailure: "block"`）时也是如此。`task` 子智能体没有节点行，拒绝只体现在工具结果里。你自己拒绝的确认不记为安全拦截。

### 示例：dcg

[dcg](https://github.com/Dicklesworthstone/destructive_command_guard)（Destructive Command Guard）是一个讲这套协议的守卫。它只是示例，不是推荐，也不是依赖。下面的内容来自它自己的文档（写本文时是 v0.16.0）；依赖其中任何一条之前，请先读它当前的文档。

- 由你自己从它的项目安装，用 `command -v dcg` 取得绝对路径填进 `command`。GraphAgent 不安装、不下载任何东西。
- 它默认的规则包覆盖破坏性命令：递归删除、`git reset --hard`、`git clean -f`、`git push --force`。发布和推送默认分支不在其中，需要你自己开启对应的规则包（它的文档里有 `package_managers` 和 `strict_git` 等），请按需查它的规则包清单。
- 它判断的是命令文本。它不知道你的项目边界，也不拦读取。
- 在时限内无法判断时它回答 `ask`；输入里的 `permission_mode` 是 `dontAsk` 或 `bypassPermissions` 时，它改为直接拒绝。这就是 `allow` 档报告 `dontAsk` 的原因。它即使仍然回答 ask，SF-6 也会拒绝该调用。
- 它的拒绝信息里可以带一个 allow-once 放行码，文档里还列了其他给人用的放行办法。读到这条信息的智能体可以自己执行放行命令。项目自己也说，它假定的是出于善意但会犯错的智能体。不要把它当安全边界。
- 它的许可证是带附加条款的 MIT，附加条款限制特定的主体。安装前请读它仓库里的许可证，确认它允许你的使用方式。

## 不会消失的局限

- 三档、安全保险清单、守卫都不是沙箱。需要隔离时用 Docker 或虚拟机。
- `ask` 档把决定权交给你，但不保护你不做出错误的决定：被批准的命令以你的权限执行。
- `readonly` 收窄的是工具。shell 重定向仍然可以借一条被放行的只读命令写文件，你按名字放行的 MCP 工具会做它本来要做的事。
- 守卫看到的是命令文本。它看不穿的东西（脚本内容、它没有建模的写法），它也拦不住。
- fail-open 的守卫坏了会放行调用；fail-closed 的守卫坏了会拒绝所有 shell 命令，包括你自己的。
