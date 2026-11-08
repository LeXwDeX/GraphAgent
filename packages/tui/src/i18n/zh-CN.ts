/**
 * Simplified Chinese message table. Every key added here must also exist in
 * `en.ts` with the same placeholder set; `test/i18n.test.ts` enforces both.
 */
export const zhCN = {
  "dagmode.footer.on": "◆ DAG",
  "dagmode.footer.off": "◇ DAG",
  "dagmode.footer.unavailable": "◆ DAG !",
  "dagmode.toggle.needSession": "先开始会话，或在 /config 设置新会话默认值",
  "help.dagmode.toggle": "切换本会话的 DAG 模式",
  "dagmode.receipt.on":
    "DAG 模式已开启（本会话，自下一次请求起生效）；token 消耗通常成倍增加；并发上限 {cap}（所有会话共享）、单工作流节点上限 {nodes}、token 预算 {budget}；关闭：/dag-mode off 或 {key}",
  "dagmode.receipt.on.noBudget": "当前未设 token 预算",
  "dagmode.receipt.on.unavailable": "注意：{reason}，主 agent 无法启动工作流",
  "dagmode.receipt.off": "DAG 模式已关闭；{n} 个运行中的工作流会继续到结束；之后主 agent 只在你明确要求时启动工作流",
  "dagmode.receipt.status":
    "模式 {state}；新会话默认 {default}；并发 {running}/{cap}；节点上限 {nodes}；token {used}/{budget}",
  "dagmode.receipt.budget": "本会话 DAG 预算已设为 {N} token；有因预算暂停的工作流时追加已恢复 {k} 个",
  "goal.title": "目标",
  "goal.status.active": "进行中",
  "goal.status.waiting": "等待中",
  "goal.status.done": "已达成",
  "goal.status.paused": "已暂停",
  "goal.turns": "{used}/{max} 轮",
  "prompt.submit.unconfirmed.toast": "命令提交结果未确认，本会话 shell 暂缓",
  "prompt.stop.requested": "已请求停止，提交结果未确认",
  "prompt.submit.paused": "本会话提交/模型保存暂缓；重启后不保留此保护",
  "prompt.submit.unconfirmed": "提交结果未确认，本会话提交/模型保存暂缓",
  "prompt.submit.restart": "重启后不保留此保护",
  "shell.tooSmall": "终端太小",
  "shell.topBar.context": "上下文 {percent}%",
  "shell.footer.switchAgent": "切换 agent",
  "shell.footer.commands": "命令",
  "shell.footer.drawer": "侧边栏",
  "shell.footer.expand": "展开输出",
  "shell.footer.help": "快捷键",
  "config.language.label": "语言 / Language",
  "language.option.zh-CN": "简体中文",
  "language.option.en": "English",
} as const

export type MessageKey = keyof typeof zhCN
