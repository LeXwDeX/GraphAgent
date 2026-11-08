import type { MessageKey } from "./zh-CN"

/**
 * English message table. Every key must also exist in `zh-CN.ts` with the same
 * placeholder set; `test/i18n.test.ts` enforces both.
 */
export const en: Record<MessageKey, string> = {
  "dagmode.footer.on": "◆ DAG",
  "dagmode.footer.off": "◇ DAG",
  "dagmode.footer.unavailable": "◆ DAG !",
  "dagmode.toggle.needSession": "Start a session first, or set the new-session default in /config",
  "help.dagmode.toggle": "Toggle DAG mode for this session",
  "dagmode.receipt.on":
    "DAG mode is on for this session, starting with the next request. Token usage usually multiplies; concurrency cap {cap} (shared by all sessions), per-workflow node cap {nodes}, token budget {budget}. Turn it off with /dag-mode off or {key}.",
  "dagmode.receipt.on.noBudget": "No token budget is configured.",
  "dagmode.receipt.on.unavailable": "Note: {reason}. The main agent cannot start workflows.",
  "dagmode.receipt.off":
    "DAG mode is off. {n} running workflow(s) will finish; after that the main agent starts workflows only when you ask.",
  "dagmode.receipt.status":
    "Mode {state}; new-session default {default}; concurrency {running}/{cap}; node cap {nodes}; tokens {used}/{budget}",
  "dagmode.receipt.budget":
    "DAG budget for this session is now {N} tokens; restored {k} workflow(s) that were paused by the budget.",
  "goal.title": "Goal",
  "goal.status.active": "Active",
  "goal.status.waiting": "Waiting",
  "goal.status.done": "Done",
  "goal.status.paused": "Paused",
  "goal.turns": "{used}/{max} turns",
  "prompt.submit.unconfirmed.toast": "Command submission is unconfirmed; shell is paused for this session",
  "prompt.stop.requested": "Stop requested; submission is unconfirmed",
  "prompt.submit.paused": "Submission and model save are paused for this session; this protection ends on restart",
  "prompt.submit.unconfirmed": "Submission is unconfirmed; submission and model save are paused for this session",
  "prompt.submit.restart": "This protection ends on restart",
  "shell.tooSmall": "Terminal too small",
  "shell.topBar.context": "context {percent}%",
  "shell.footer.switchAgent": "switch agent",
  "shell.footer.commands": "commands",
  "shell.footer.drawer": "drawer",
  "shell.footer.expand": "expand output",
  "shell.footer.help": "shortcuts",
  "config.language.label": "Language",
  "language.option.zh-CN": "简体中文",
  "language.option.en": "English",
}
