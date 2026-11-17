// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI messages for the `session` domain and its siblings that work on stored
 * sessions: `models`, `db`, `export`, `import` and `pr`. Keys use the
 * `cli.<domain>.<name>` form.
 *
 * `import` prints `Imported session: <id>` in English only: `pr` parses that
 * line out of the child process output, so it is not part of these tables.
 */
export const sessionZhCN = {
  "cli.session.describe": "管理会话",
  "cli.session.delete.describe": "删除会话",
  "cli.session.delete.arg.sessionID": "要删除的会话 ID",
  "cli.session.delete.done": "已删除会话 {sessionID}",
  "cli.session.notFound": "未找到会话：{sessionID}",
  "cli.session.list.describe": "列出会话",
  "cli.session.list.option.maxCount": "仅显示最近的 N 个会话",
  "cli.session.list.option.format": "输出格式",
  "cli.session.list.header.id": "会话 ID",
  "cli.session.list.header.title": "标题",
  "cli.session.list.header.updated": "更新时间",

  "cli.models.describe": "列出所有可用模型",
  "cli.models.arg.provider": "用于筛选模型的 provider ID",
  "cli.models.option.verbose": "输出更详细的模型信息（包含费用等元数据）",
  "cli.models.option.refresh": "从 models.dev 刷新模型缓存",
  "cli.models.refreshed": "模型缓存已刷新",
  "cli.models.providerNotFound": "未找到 provider：{provider}",

  "cli.db.describe": "数据库工具",
  "cli.db.query.describe": "打开交互式 sqlite3 shell 或执行查询",
  "cli.db.query.arg.query": "要执行的 SQL 查询",
  "cli.db.query.option.format": "输出格式",
  "cli.db.path.describe": "打印数据库路径",
  "cli.db.vacuum.describe": "将数据库文件转换为 full auto_vacuum（FULL -> VACUUM -> 截断 WAL）",
  "cli.db.vacuum.option.db": "SQLite 数据库文件路径（用 `graphagent db path` 打印默认路径）",
  "cli.db.vacuum.failed": "对 {db} 执行 vacuum 失败：请先关闭正在使用该文件的 graphagent 进程，然后重试（{message}）",

  "cli.export.describe": "将会话数据导出为 JSON",
  "cli.export.arg.sessionID": "要导出的会话 ID",
  "cli.export.option.sanitize": "对敏感的对话记录和文件数据脱敏",
  "cli.export.exporting": "正在导出会话：{session}",
  "cli.export.latest": "最新",
  "cli.export.intro": "导出会话",
  "cli.export.noSessions": "未找到会话",
  "cli.export.done": "完成",
  "cli.export.select": "选择要导出的会话",
  "cli.export.outro": "正在导出会话...",
  "cli.export.notFound": "未找到会话：{sessionID}",

  "cli.import.describe": "从 JSON 文件导入会话数据",
  "cli.import.arg.file": "JSON 文件路径",
  "cli.import.fileNotFound": "未找到文件：{file}",
  "cli.import.permissionDenied": "读取文件失败：权限被拒绝",
  "cli.import.readFailed": "读取文件失败：{message}",
  "cli.import.invalidJson": "{file} 中的 JSON 无效：{detail}",

  "cli.pr.describe": "拉取并检出 GitHub PR 分支，然后运行 graphagent",
  "cli.pr.arg.number": "要检出的 PR 编号",
  "cli.pr.noInstance": "无法加载实例上下文",
  "cli.pr.noGitRepo": "未找到 git 仓库。请在 git 仓库中运行此命令。",
  "cli.pr.fetching": "正在拉取并检出 PR #{number}...",
  "cli.pr.checkoutFailed": "检出 PR #{number} 失败。请确认已安装 gh CLI 并完成认证。",
  "cli.pr.addedRemote": "已添加 fork 远程仓库：{remote}",
  "cli.pr.foundSession": "发现 GraphAgent 会话：{url}",
  "cli.pr.importing": "正在导入会话...",
  "cli.pr.imported": "会话已导入：{sessionId}",
  "cli.pr.checkedOut": "已成功检出 PR #{number}，分支为 '{branch}'",
  "cli.pr.starting": "正在启动 graphagent...",
  "cli.pr.exited": "graphagent 已退出，退出码 {code}",
} as const

export const sessionEn: Record<keyof typeof sessionZhCN, string> = {
  "cli.session.describe": "manage sessions",
  "cli.session.delete.describe": "delete a session",
  "cli.session.delete.arg.sessionID": "session ID to delete",
  "cli.session.delete.done": "Session {sessionID} deleted",
  "cli.session.notFound": "Session not found: {sessionID}",
  "cli.session.list.describe": "list sessions",
  "cli.session.list.option.maxCount": "limit to N most recent sessions",
  "cli.session.list.option.format": "output format",
  "cli.session.list.header.id": "Session ID",
  "cli.session.list.header.title": "Title",
  "cli.session.list.header.updated": "Updated",

  "cli.models.describe": "list all available models",
  "cli.models.arg.provider": "provider ID to filter models by",
  "cli.models.option.verbose": "use more verbose model output (includes metadata like costs)",
  "cli.models.option.refresh": "refresh the models cache from models.dev",
  "cli.models.refreshed": "Models cache refreshed",
  "cli.models.providerNotFound": "Provider not found: {provider}",

  "cli.db.describe": "database tools",
  "cli.db.query.describe": "open an interactive sqlite3 shell or run a query",
  "cli.db.query.arg.query": "SQL query to execute",
  "cli.db.query.option.format": "Output format",
  "cli.db.path.describe": "print the database path",
  "cli.db.vacuum.describe": "convert a database file to full auto_vacuum (FULL -> VACUUM -> truncate WAL)",
  "cli.db.vacuum.option.db": "path to the SQLite database file (print the default with `graphagent db path`)",
  "cli.db.vacuum.failed":
    "vacuum failed for {db} — close running graphagent processes that use this file and retry ({message})",

  "cli.export.describe": "export session data as JSON",
  "cli.export.arg.sessionID": "session id to export",
  "cli.export.option.sanitize": "redact sensitive transcript and file data",
  "cli.export.exporting": "Exporting session: {session}",
  "cli.export.latest": "latest",
  "cli.export.intro": "Export session",
  "cli.export.noSessions": "No sessions found",
  "cli.export.done": "Done",
  "cli.export.select": "Select session to export",
  "cli.export.outro": "Exporting session...",
  "cli.export.notFound": "Session not found: {sessionID}",

  "cli.import.describe": "import session data from JSON file",
  "cli.import.arg.file": "path to JSON file",
  "cli.import.fileNotFound": "File not found: {file}",
  "cli.import.permissionDenied": "Failed to read file: Permission denied",
  "cli.import.readFailed": "Failed to read file: {message}",
  "cli.import.invalidJson": "Invalid JSON in {file}: {detail}",

  "cli.pr.describe": "fetch and checkout a GitHub PR branch, then run graphagent",
  "cli.pr.arg.number": "PR number to checkout",
  "cli.pr.noInstance": "Could not load instance context",
  "cli.pr.noGitRepo": "Could not find git repository. Please run this command from a git repository.",
  "cli.pr.fetching": "Fetching and checking out PR #{number}...",
  "cli.pr.checkoutFailed": "Failed to checkout PR #{number}. Make sure you have gh CLI installed and authenticated.",
  "cli.pr.addedRemote": "Added fork remote: {remote}",
  "cli.pr.foundSession": "Found GraphAgent session: {url}",
  "cli.pr.importing": "Importing session...",
  "cli.pr.imported": "Session imported: {sessionId}",
  "cli.pr.checkedOut": "Successfully checked out PR #{number} as branch '{branch}'",
  "cli.pr.starting": "Starting graphagent...",
  "cli.pr.exited": "graphagent exited with code {code}",
}
