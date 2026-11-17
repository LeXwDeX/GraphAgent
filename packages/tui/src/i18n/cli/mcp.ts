// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI messages for the `mcp` domain. Keys use the `cli.<domain>.<name>` form.
 *
 * `mcp debug` prints developer diagnostics that stay English by design, so only
 * its command and positional help text live here.
 */
export const mcpZhCN = {
  // Command and option help
  "cli.mcp.describe": "管理 MCP（Model Context Protocol）服务器",
  "cli.mcp.list.describe": "列出 MCP 服务器及其状态",
  "cli.mcp.auth.describe": "对启用 OAuth 的 MCP 服务器进行认证",
  "cli.mcp.authList.describe": "列出支持 OAuth 的 MCP 服务器及其认证状态",
  "cli.mcp.logout.describe": "移除 MCP 服务器的 OAuth 凭据",
  "cli.mcp.add.describe": "添加 MCP 服务器",
  "cli.mcp.debug.describe": "调试 MCP 服务器的 OAuth 连接",
  "cli.mcp.option.name": "MCP 服务器名称",
  "cli.mcp.option.url": "远程 MCP 服务器的 URL",
  "cli.mcp.option.env": "本地 MCP 服务器的环境变量（KEY=VALUE）",
  "cli.mcp.option.header": "远程 MCP 服务器的 HTTP 头（KEY=VALUE）",
  "cli.mcp.option.global": "写入用户级 mcp.json，而不是项目层",

  // Shared
  "cli.mcp.done": "完成",
  "cli.mcp.authStatus.authenticated": "已认证",
  "cli.mcp.authStatus.expired": "已过期",
  "cli.mcp.authStatus.notAuthenticated": "未认证",

  // mcp list
  "cli.mcp.list.intro": "MCP 服务器",
  "cli.mcp.list.empty": "未配置 MCP 服务器",
  "cli.mcp.list.addHint": "使用 graphagent mcp add 添加服务器",
  "cli.mcp.list.count": "{count} 个服务器",
  "cli.mcp.status.notInitialized": "未初始化",
  "cli.mcp.status.connected": "已连接",
  "cli.mcp.status.disabled": "已禁用",
  "cli.mcp.status.needsAuth": "需要认证",
  "cli.mcp.status.needsClientRegistration": "需要客户端注册",
  "cli.mcp.status.failed": "失败",

  // mcp auth
  "cli.mcp.auth.intro": "MCP OAuth 认证",
  "cli.mcp.auth.noServers": "未配置支持 OAuth 的 MCP 服务器",
  "cli.mcp.auth.remoteHint": "远程 MCP 服务器默认支持 OAuth。请在 .agents/mcp.json 中添加远程服务器：",
  "cli.mcp.auth.select": "选择要认证的 MCP 服务器",
  "cli.mcp.auth.notFound": "未找到 MCP 服务器：{name}",
  "cli.mcp.auth.notOauthCapable": "MCP 服务器 {name} 不是支持 OAuth 的远程服务器",
  "cli.mcp.auth.reauthConfirm": "{name} 已有有效凭据。要重新认证吗？",
  "cli.mcp.auth.cancelled": "已取消",
  "cli.mcp.auth.expiredReauth": "{name} 的凭据已过期，正在重新认证…",
  "cli.mcp.auth.starting": "正在启动 OAuth 流程…",
  "cli.mcp.auth.authorizeInBrowser": "请在浏览器中授权：",
  "cli.mcp.auth.waiting": "等待授权…",
  "cli.mcp.auth.success": "认证成功！",
  "cli.mcp.auth.failed": "认证失败",
  "cli.mcp.auth.registerClientHint": "请在 MCP 服务器配置中添加预注册的客户端：",
  "cli.mcp.auth.unexpectedStatus": "意外状态：{status}",

  // mcp auth list
  "cli.mcp.authList.intro": "MCP OAuth 状态",
  "cli.mcp.authList.count": "{count} 个支持 OAuth 的服务器",

  // mcp logout
  "cli.mcp.logout.intro": "MCP OAuth 登出",
  "cli.mcp.logout.none": "没有已保存的 MCP OAuth 凭据",
  "cli.mcp.logout.select": "选择要登出的 MCP 服务器",
  "cli.mcp.logout.hint.tokensAndClient": "token + 客户端",
  "cli.mcp.logout.hint.tokens": "token",
  "cli.mcp.logout.hint.client": "客户端注册",
  "cli.mcp.logout.notFound": "未找到 {name} 的凭据",
  "cli.mcp.logout.removed": "已移除 {name} 的 OAuth 凭据",

  // mcp add
  "cli.mcp.add.nameRequired": "非交互式配置 MCP 时必须提供服务器名称",
  "cli.mcp.add.urlOrCommand": "请提供 --url <url>，或在 -- 之后提供命令",
  "cli.mcp.add.invalidUrlValue": "URL 无效：{url}",
  "cli.mcp.add.envLocalOnly": "--env 仅适用于本地 MCP 服务器",
  "cli.mcp.add.headerRemoteOnly": "--header 仅适用于远程 MCP 服务器",
  "cli.mcp.add.invalidEnv": "环境变量无效：{entry}。应为 KEY=VALUE 格式",
  "cli.mcp.add.invalidHeader": "HTTP 头无效：{entry}。应为 KEY=VALUE 格式",
  "cli.mcp.add.added": 'MCP 服务器 "{name}" 已添加到 {path}',
  "cli.mcp.add.intro": "添加 MCP 服务器",
  "cli.mcp.add.locationPrompt": "位置",
  "cli.mcp.add.location.project": "当前项目",
  "cli.mcp.add.location.global": "全局",
  "cli.mcp.add.namePrompt": "输入 MCP 服务器名称",
  "cli.mcp.add.required": "必填",
  "cli.mcp.add.typePrompt": "选择 MCP 服务器类型",
  "cli.mcp.add.type.local": "本地",
  "cli.mcp.add.type.localHint": "运行本地命令",
  "cli.mcp.add.type.remote": "远程",
  "cli.mcp.add.type.remoteHint": "连接到远程 URL",
  "cli.mcp.add.commandPrompt": "输入要运行的命令",
  "cli.mcp.add.example": "例如：{example}",
  "cli.mcp.add.urlPrompt": "输入 MCP 服务器 URL",
  "cli.mcp.add.urlInvalid": "URL 无效",
  "cli.mcp.add.oauthPrompt": "此服务器需要 OAuth 认证吗？",
  "cli.mcp.add.hasClientIdPrompt": "你有预注册的客户端 ID 吗？",
  "cli.mcp.add.clientIdPrompt": "输入客户端 ID",
  "cli.mcp.add.hasSecretPrompt": "你有客户端密钥吗？",
  "cli.mcp.add.secretPrompt": "输入客户端密钥",
  "cli.mcp.add.success": "MCP 服务器添加成功",
} as const

export const mcpEn: Record<keyof typeof mcpZhCN, string> = {
  // Command and option help
  "cli.mcp.describe": "manage MCP (Model Context Protocol) servers",
  "cli.mcp.list.describe": "list MCP servers and their status",
  "cli.mcp.auth.describe": "authenticate with an OAuth-enabled MCP server",
  "cli.mcp.authList.describe": "list OAuth-capable MCP servers and their auth status",
  "cli.mcp.logout.describe": "remove OAuth credentials for an MCP server",
  "cli.mcp.add.describe": "add an MCP server",
  "cli.mcp.debug.describe": "debug OAuth connection for an MCP server",
  "cli.mcp.option.name": "name of the MCP server",
  "cli.mcp.option.url": "URL for a remote MCP server",
  "cli.mcp.option.env": "environment variable for a local MCP server (KEY=VALUE)",
  "cli.mcp.option.header": "HTTP header for a remote MCP server (KEY=VALUE)",
  "cli.mcp.option.global": "write to the user-level mcp.json instead of the project layer",

  // Shared
  "cli.mcp.done": "Done",
  "cli.mcp.authStatus.authenticated": "authenticated",
  "cli.mcp.authStatus.expired": "expired",
  "cli.mcp.authStatus.notAuthenticated": "not authenticated",

  // mcp list
  "cli.mcp.list.intro": "MCP Servers",
  "cli.mcp.list.empty": "No MCP servers configured",
  "cli.mcp.list.addHint": "Add servers with: graphagent mcp add",
  "cli.mcp.list.count": "{count} server(s)",
  "cli.mcp.status.notInitialized": "not initialized",
  "cli.mcp.status.connected": "connected",
  "cli.mcp.status.disabled": "disabled",
  "cli.mcp.status.needsAuth": "needs authentication",
  "cli.mcp.status.needsClientRegistration": "needs client registration",
  "cli.mcp.status.failed": "failed",

  // mcp auth
  "cli.mcp.auth.intro": "MCP OAuth Authentication",
  "cli.mcp.auth.noServers": "No OAuth-capable MCP servers configured",
  "cli.mcp.auth.remoteHint": "Remote MCP servers support OAuth by default. Add a remote server in .agents/mcp.json:",
  "cli.mcp.auth.select": "Select MCP server to authenticate",
  "cli.mcp.auth.notFound": "MCP server not found: {name}",
  "cli.mcp.auth.notOauthCapable": "MCP server {name} is not an OAuth-capable remote server",
  "cli.mcp.auth.reauthConfirm": "{name} already has valid credentials. Re-authenticate?",
  "cli.mcp.auth.cancelled": "Cancelled",
  "cli.mcp.auth.expiredReauth": "{name} has expired credentials. Re-authenticating...",
  "cli.mcp.auth.starting": "Starting OAuth flow...",
  "cli.mcp.auth.authorizeInBrowser": "Authorize in your browser:",
  "cli.mcp.auth.waiting": "Waiting for authorization...",
  "cli.mcp.auth.success": "Authentication successful!",
  "cli.mcp.auth.failed": "Authentication failed",
  "cli.mcp.auth.registerClientHint": "Add a pre-registered client to your MCP server config:",
  "cli.mcp.auth.unexpectedStatus": "Unexpected status: {status}",

  // mcp auth list
  "cli.mcp.authList.intro": "MCP OAuth Status",
  "cli.mcp.authList.count": "{count} OAuth-capable server(s)",

  // mcp logout
  "cli.mcp.logout.intro": "MCP OAuth Logout",
  "cli.mcp.logout.none": "No MCP OAuth credentials stored",
  "cli.mcp.logout.select": "Select MCP server to logout",
  "cli.mcp.logout.hint.tokensAndClient": "tokens + client",
  "cli.mcp.logout.hint.tokens": "tokens",
  "cli.mcp.logout.hint.client": "client registration",
  "cli.mcp.logout.notFound": "No credentials found for: {name}",
  "cli.mcp.logout.removed": "Removed OAuth credentials for {name}",

  // mcp add
  "cli.mcp.add.nameRequired": "A server name is required for non-interactive MCP configuration",
  "cli.mcp.add.urlOrCommand": "Provide either --url <url> or a command after --",
  "cli.mcp.add.invalidUrlValue": "Invalid URL: {url}",
  "cli.mcp.add.envLocalOnly": "--env is only valid for local MCP servers",
  "cli.mcp.add.headerRemoteOnly": "--header is only valid for remote MCP servers",
  "cli.mcp.add.invalidEnv": "Invalid environment variable: {entry}. Expected KEY=VALUE",
  "cli.mcp.add.invalidHeader": "Invalid HTTP header: {entry}. Expected KEY=VALUE",
  "cli.mcp.add.added": 'MCP server "{name}" added to {path}',
  "cli.mcp.add.intro": "Add MCP server",
  "cli.mcp.add.locationPrompt": "Location",
  "cli.mcp.add.location.project": "Current project",
  "cli.mcp.add.location.global": "Global",
  "cli.mcp.add.namePrompt": "Enter MCP server name",
  "cli.mcp.add.required": "Required",
  "cli.mcp.add.typePrompt": "Select MCP server type",
  "cli.mcp.add.type.local": "Local",
  "cli.mcp.add.type.localHint": "Run a local command",
  "cli.mcp.add.type.remote": "Remote",
  "cli.mcp.add.type.remoteHint": "Connect to a remote URL",
  "cli.mcp.add.commandPrompt": "Enter command to run",
  "cli.mcp.add.example": "e.g., {example}",
  "cli.mcp.add.urlPrompt": "Enter MCP server URL",
  "cli.mcp.add.urlInvalid": "Invalid URL",
  "cli.mcp.add.oauthPrompt": "Does this server require OAuth authentication?",
  "cli.mcp.add.hasClientIdPrompt": "Do you have a pre-registered client ID?",
  "cli.mcp.add.clientIdPrompt": "Enter client ID",
  "cli.mcp.add.hasSecretPrompt": "Do you have a client secret?",
  "cli.mcp.add.secretPrompt": "Enter client secret",
  "cli.mcp.add.success": "MCP server added successfully",
}
