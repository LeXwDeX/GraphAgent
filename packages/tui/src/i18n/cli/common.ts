// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI messages shared by the entry point, `UI` helpers and `FormatError`.
 * Keys use the `cli.<domain>.<name>` form.
 */
export const commonZhCN = {
  "cli.common.help": "显示帮助",
  "cli.common.version": "显示版本号",
  "cli.common.completion": "生成 shell 补全脚本",
  "cli.common.option.printLogs": "把日志输出到 stderr",
  "cli.common.option.logLevel": "日志级别",
  "cli.common.unexpectedError": "意外错误",
  "cli.common.yes": "是",
  "cli.common.no": "否",
  "cli.common.errorPrefix": "错误：",
  "cli.common.loggedTo": "详情已写入日志：{path}",
  "cli.common.untrustedSkipped.one": "已跳过 {count} 项未受信任的项目配置。运行 /trust 查看。",
  "cli.common.untrustedSkipped.other": "已跳过 {count} 项未受信任的项目配置。运行 /trust 查看。",
  "cli.error.mcpFailed": 'MCP 服务器 "{name}" 启动失败。注意：GraphAgent 尚不支持 MCP 认证。',
  "cli.error.modelNotFound": "未找到模型：{model}",
  "cli.error.modelSuggestions": "你是不是要找：{suggestions}",
  "cli.error.modelTryList": "试试：`graphagent models` 列出可用模型",
  "cli.error.modelCheckConfig": "或检查配置文件（graphagent.json）中的 provider/model 名称",
  "cli.error.providerInit": '初始化 provider "{provider}" 失败。请检查凭据与配置。',
  "cli.error.configJson": "{path} 处的配置文件不是有效的 JSON(C)",
  "cli.error.configDirectoryTypo":
    '{path} 中的目录 "{dir}" 无效。请把它重命名为 "{suggestion}" 或删除。这是常见的拼写错误。',
  "cli.error.remoteConfigLogin": "加载远程配置失败：服务器返回了登录页而不是 JSON。",
  "cli.error.remoteConfigLoginFrom": "从 {remote} 加载远程配置失败：服务器返回了登录页而不是 JSON。",
  "cli.error.remoteConfigExpired": "认证缺失或已过期（该端点可能位于 SSO 或身份感知代理之后）。",
  "cli.error.remoteConfigRelogin": "运行 `graphagent auth login {url}` 重新认证。",
  "cli.error.configInvalid": "配置无效",
  "cli.error.configInvalidAt": "{path} 处的配置无效",
  "cli.error.databaseBaselineMismatch":
    "数据库 {path} 的基线 {found} 与当前版本 {expected} 不一致（v2.0.0 发布前基线会原地变更）",
  "cli.error.databaseBaselineDelete": "删除该文件后重新启动即可；这是开发库，不含发布数据。",
  "cli.error.databaseBaselineDbPath": "不确定是哪个文件时，运行 `graphagent db path` 查看。",
  "cli.error.databaseBaselineOverride": "想保留这份数据：设 GRAPHAGENT_DB=/绝对/路径.db 指定另一个库。",
  "cli.error.databaseNotADatabase":
    "{path} 已有 {tables} 张表但没有 session 表，不是 GraphAgent 的数据库；请换一个路径（GRAPHAGENT_DB）。",
} as const

export const commonEn: Record<keyof typeof commonZhCN, string> = {
  "cli.common.help": "show help",
  "cli.common.version": "show version number",
  "cli.common.completion": "generate shell completion script",
  "cli.common.option.printLogs": "print logs to stderr",
  "cli.common.option.logLevel": "log level",
  "cli.common.unexpectedError": "Unexpected error",
  "cli.common.yes": "Yes",
  "cli.common.no": "No",
  "cli.common.errorPrefix": "Error: ",
  "cli.common.loggedTo": "Details written to the log: {path}",
  "cli.common.untrustedSkipped.one": "Skipped {count} untrusted project entry. Run /trust to review them.",
  "cli.common.untrustedSkipped.other": "Skipped {count} untrusted project entries. Run /trust to review them.",
  "cli.error.mcpFailed": 'MCP server "{name}" failed. Note, GraphAgent does not support MCP authentication yet.',
  "cli.error.modelNotFound": "Model not found: {model}",
  "cli.error.modelSuggestions": "Did you mean: {suggestions}",
  "cli.error.modelTryList": "Try: `graphagent models` to list available models",
  "cli.error.modelCheckConfig": "Or check your config (graphagent.json) provider/model names",
  "cli.error.providerInit": 'Failed to initialize provider "{provider}". Check credentials and configuration.',
  "cli.error.configJson": "Config file at {path} is not valid JSON(C)",
  "cli.error.configDirectoryTypo":
    'Directory "{dir}" in {path} is not valid. Rename the directory to "{suggestion}" or remove it. This is a common typo.',
  "cli.error.remoteConfigLogin": "Failed to load remote config: the server returned a login page instead of JSON.",
  "cli.error.remoteConfigLoginFrom":
    "Failed to load remote config from {remote}: the server returned a login page instead of JSON.",
  "cli.error.remoteConfigExpired":
    "Authentication is missing or has expired (the endpoint is likely behind an SSO or identity-aware proxy).",
  "cli.error.remoteConfigRelogin": "Run `graphagent auth login {url}` to re-authenticate.",
  "cli.error.configInvalid": "Configuration is invalid",
  "cli.error.configInvalidAt": "Configuration is invalid at {path}",
  "cli.error.databaseBaselineMismatch":
    "Database {path} has baseline {found}, but this build writes {expected} (the baseline moves in place until v2.0.0)",
  "cli.error.databaseBaselineDelete":
    "Delete that file and start again; it is a development database and holds no release data.",
  "cli.error.databaseBaselineDbPath": "Not sure which file? Run `graphagent db path`.",
  "cli.error.databaseBaselineOverride":
    "To keep this data, set GRAPHAGENT_DB=/absolute/path.db to point at another database.",
  "cli.error.databaseNotADatabase":
    "{path} already holds {tables} tables but no session table, so it is not a GraphAgent database; point GRAPHAGENT_DB somewhere else.",
}
