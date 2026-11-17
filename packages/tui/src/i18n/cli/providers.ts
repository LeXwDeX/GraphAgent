// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** CLI messages for the `providers` domain. Keys use the `cli.<domain>.<name>` form. */
export const providersZhCN = {
  "cli.providers.describe": "管理 AI provider 与凭据",
  "cli.providers.done": "完成",
  "cli.providers.required": "必填",
  "cli.providers.failed": "失败",
  "cli.providers.selectProvider": "选择 provider",
  "cli.providers.apiKeyPrompt": "输入你的 API key",
  "cli.providers.list.describe": "列出 provider 与凭据",
  "cli.providers.list.credentials": "凭据",
  "cli.providers.list.credentialCount": "{count} 个凭据",
  "cli.providers.list.environment": "环境变量",
  "cli.providers.list.envCount.one": "{count} 个环境变量",
  "cli.providers.list.envCount.other": "{count} 个环境变量",
  "cli.providers.login.describe": "登录到某个 provider",
  "cli.providers.login.option.url": "{app} 认证 provider",
  "cli.providers.login.option.provider": "要登录的 provider ID 或名称（跳过 provider 选择）",
  "cli.providers.login.option.method": "登录方式标签（跳过登录方式选择）",
  "cli.providers.login.addCredential": "添加凭据",
  "cli.providers.login.metadataFailedPrefix": "从 {url} 加载认证 provider 元数据失败：",
  "cli.providers.login.running": "正在运行 `{command}`",
  "cli.providers.login.commandFailedPrefix": "运行认证 provider 命令失败：",
  "cli.providers.login.loggedInto": "已登录到 {url}",
  "cli.providers.login.hintOpenai": "ChatGPT Plus/Pro 或 API key",
  "cli.providers.login.hintBuiltIn": "内置",
  "cli.providers.login.other": "其他",
  "cli.providers.login.unknownProvider": '未知的 provider "{provider}"',
  "cli.providers.login.providerId": "输入 provider ID",
  "cli.providers.login.providerIdInvalid": "只能包含 a-z、0-9 和连字符",
  "cli.providers.login.customNotice":
    "这只会为 {provider} 保存凭据，你需要在 graphagent.json 中配置它，示例请查看文档。",
  "cli.providers.login.method": "登录方式",
  "cli.providers.login.unknownMethod": '未知的 {provider} 登录方式 "{method}"。可用方式：{available}',
  "cli.providers.login.goTo": "前往：{url}",
  "cli.providers.login.waiting": "等待授权…",
  "cli.providers.login.authorizeFailed": "授权失败",
  "cli.providers.login.authorizeFailedPrefix": "授权失败：",
  "cli.providers.login.pasteCode": "在此粘贴授权码：",
  "cli.providers.login.success": "登录成功",
  "cli.providers.login.bedrock":
    "Amazon Bedrock 认证优先级：\n" +
    "  1. Bearer token（AWS_BEARER_TOKEN_BEDROCK 或 /connect）\n" +
    "  2. AWS 凭据链（profile、access key、IAM 角色、EKS IRSA）\n\n" +
    "可通过 graphagent.json 的选项（profile、region、endpoint）或\n" +
    "AWS 环境变量（AWS_PROFILE、AWS_REGION、AWS_ACCESS_KEY_ID、AWS_WEB_IDENTITY_TOKEN_FILE）进行配置。",
  "cli.providers.login.vercel": "你可以在此创建 API key：https://vercel.link/ai-gateway-token",
  "cli.providers.login.cloudflare":
    "Cloudflare AI Gateway 可通过 CLOUDFLARE_GATEWAY_ID、CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN 环境变量进行配置。",
  "cli.providers.logout.describe": "登出已配置的 provider",
  "cli.providers.logout.option.provider": "要登出的 provider ID 或名称",
  "cli.providers.logout.removeCredential": "移除凭据",
  "cli.providers.logout.none": "未找到凭据",
  "cli.providers.logout.unknownProvider": '未知的已配置 provider "{provider}"',
  "cli.providers.logout.success": "登出成功",
} as const

export const providersEn: Record<keyof typeof providersZhCN, string> = {
  "cli.providers.describe": "manage AI providers and credentials",
  "cli.providers.done": "Done",
  "cli.providers.required": "Required",
  "cli.providers.failed": "Failed",
  "cli.providers.selectProvider": "Select provider",
  "cli.providers.apiKeyPrompt": "Enter your API key",
  "cli.providers.list.describe": "list providers and credentials",
  "cli.providers.list.credentials": "Credentials",
  "cli.providers.list.credentialCount": "{count} credentials",
  "cli.providers.list.environment": "Environment",
  "cli.providers.list.envCount.one": "{count} environment variable",
  "cli.providers.list.envCount.other": "{count} environment variables",
  "cli.providers.login.describe": "log in to a provider",
  "cli.providers.login.option.url": "{app} auth provider",
  "cli.providers.login.option.provider": "provider id or name to log in to (skips provider selection)",
  "cli.providers.login.option.method": "login method label (skips method selection)",
  "cli.providers.login.addCredential": "Add credential",
  "cli.providers.login.metadataFailedPrefix": "Failed to load auth provider metadata from {url}: ",
  "cli.providers.login.running": "Running `{command}`",
  "cli.providers.login.commandFailedPrefix": "Failed to run auth provider command: ",
  "cli.providers.login.loggedInto": "Logged into {url}",
  "cli.providers.login.hintOpenai": "ChatGPT Plus/Pro or API key",
  "cli.providers.login.hintBuiltIn": "built-in",
  "cli.providers.login.other": "Other",
  "cli.providers.login.unknownProvider": 'Unknown provider "{provider}"',
  "cli.providers.login.providerId": "Enter provider id",
  "cli.providers.login.providerIdInvalid": "a-z, 0-9 and hyphens only",
  "cli.providers.login.customNotice":
    "This only stores a credential for {provider} - you will need configure it in graphagent.json, check the docs for examples.",
  "cli.providers.login.method": "Login method",
  "cli.providers.login.unknownMethod": 'Unknown method "{method}" for {provider}. Available: {available}',
  "cli.providers.login.goTo": "Go to: {url}",
  "cli.providers.login.waiting": "Waiting for authorization...",
  "cli.providers.login.authorizeFailed": "Failed to authorize",
  "cli.providers.login.authorizeFailedPrefix": "Failed to authorize: ",
  "cli.providers.login.pasteCode": "Paste the authorization code here: ",
  "cli.providers.login.success": "Login successful",
  "cli.providers.login.bedrock":
    "Amazon Bedrock authentication priority:\n" +
    "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
    "  2. AWS credential chain (profile, access keys, IAM roles, EKS IRSA)\n\n" +
    "Configure via graphagent.json options (profile, region, endpoint) or\n" +
    "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_WEB_IDENTITY_TOKEN_FILE).",
  "cli.providers.login.vercel": "You can create an api key at https://vercel.link/ai-gateway-token",
  // The original "Read more" docs link is dropped on purpose: it pointed at another product's site.
  "cli.providers.login.cloudflare":
    "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables.",
  "cli.providers.logout.describe": "log out from a configured provider",
  "cli.providers.logout.option.provider": "provider id or name to log out from",
  "cli.providers.logout.removeCredential": "Remove credential",
  "cli.providers.logout.none": "No credentials found",
  "cli.providers.logout.unknownProvider": 'Unknown configured provider "{provider}"',
  "cli.providers.logout.success": "Logout successful",
}
