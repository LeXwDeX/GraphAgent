# OpenAI Responses WebSocket

For the built-in `openai` provider, enabled by default on `local`, `dev`, and `beta`. On `latest` and `prod`, set `OPENCODE_EXPERIMENTAL_WEBSOCKETS=true` or explicitly configure the provider option below. An explicit boolean overrides those defaults for `openai`.

## Provider Configuration

Custom providers using `@ai-sdk/openai` default to HTTP. Add `experimentalWebSockets: true` to the existing provider's `options` to select the same WebSocket transport, retry budget, and HTTP/SSE fallback. Keep the provider ID, API key reference, base URL, and model configuration unchanged:

```jsonc
{
  "provider": {
    "local-proxy-openai": {
      "npm": "@ai-sdk/openai",
      "options": {
        "baseURL": "{env:LOCAL_PROXY_URL}",
        "apiKey": "{env:LOCAL_PROXY_API_KEY}",
        "experimentalWebSockets": true,
      },
    },
  },
}
```

Set the option to `false` to use HTTP. When a plugin supplies a custom `fetch` for the provider, that fetch keeps priority and the provider stays on HTTP, because the WebSocket handshake cannot pass through a fetch function. It applies to the existing AI SDK's streamed Responses requests, not Chat Completions. The experimental native LLM runtime is unchanged. This option does not alter error handling: upstream API errors are still returned to the caller, rather than always replaying the request over HTTP.

## Flow

1. A streamed `POST /responses` request arrives.
2. If it has no `session-id` or `x-session-affinity` header, use HTTP.
3. Title requests use HTTP.
4. If that session's socket is busy or already in fallback mode, use HTTP.
5. Otherwise, reuse its open socket or open a new one.
6. Send `response.create` and return WebSocket events as SSE.

## Lifetime

- Connect timeout: 15 seconds.
- Idle timeout: 5 minutes.
- After a completed response, keep the socket for reuse.
- Reuse a socket for up to 55 minutes, then replace it on the next request.

## Retries

- Retry WebSocket stream/setup failures up to 5 times, then use HTTP for that session until session deletion or instance disposal.
- `websocket_connection_limit_reached` consumes the same retry budget and HTTP fallback.
- If a WebSocket fails after its first event, fail it as retryable rather than replaying partial output in transport.
- Abort or cancel closes the socket.

## Next Steps

- `previous_response_id` continuation.
- Optional second WebSocket for concurrent requests in one session. Currently these use HTTP.
