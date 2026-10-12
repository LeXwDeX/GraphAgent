# Anthropic GA structured-output patch

Issue: [#767](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues/767)

`@ai-sdk/anthropic@3.0.125` already sends JSON schemas as `output_config.format`.
Its function-tool preparation still adds `structured-outputs-2025-11-13`
automatically, even for ordinary tools without a JSON response schema.
[Anthropic's GA API](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
does not require that beta. Upgrading alone was not a demonstrated fix.

The version-pinned patch removes only that automatic insertion from the source
and all four public/internal ESM/CJS bundles. It does not filter headers.
Explicit beta values in provider headers, request headers, or provider options
still pass through. Other automatic betas, strict tools, GA schema output, and
the existing JSON-tool fallback are unchanged.

Regression coverage: `packages/opencode/test/provider/anthropic-ga-wire.test.ts`.
The tests use fake fetches and synthetic credentials, not upstream accounts.
They cover all four bundles in streaming and non-streaming modes.

This patch does not add model or endpoint support. AWS documents structured
output for listed models on
[InvokeModel and Converse](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html).
The Bedrock Mantle Anthropic Messages endpoint does not support
`output_config.format`. Thinking prefix/signature failures are outside this fix.

When upgrading the SDK, check whether upstream has removed the insertion.
Keep the wire regressions when retiring or updating this patch.
