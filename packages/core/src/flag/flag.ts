import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["GRAPHAGENT_DISABLE_COPY_ON_SELECT"]
const fff = process.env["GRAPHAGENT_DISABLE_FFF"]

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  GRAPHAGENT_AUTO_HEAP_SNAPSHOT: truthy("GRAPHAGENT_AUTO_HEAP_SNAPSHOT"),
  GRAPHAGENT_GIT_BASH_PATH: process.env["GRAPHAGENT_GIT_BASH_PATH"],
  GRAPHAGENT_CONFIG: process.env["GRAPHAGENT_CONFIG"],
  GRAPHAGENT_CONFIG_CONTENT: process.env["GRAPHAGENT_CONFIG_CONTENT"],
  GRAPHAGENT_DISABLE_PRUNE: truthy("GRAPHAGENT_DISABLE_PRUNE"),
  GRAPHAGENT_DISABLE_TERMINAL_TITLE: truthy("GRAPHAGENT_DISABLE_TERMINAL_TITLE"),
  GRAPHAGENT_SHOW_TTFD: truthy("GRAPHAGENT_SHOW_TTFD"),
  GRAPHAGENT_DISABLE_AUTOCOMPACT: truthy("GRAPHAGENT_DISABLE_AUTOCOMPACT"),
  GRAPHAGENT_DISABLE_MODELS_FETCH: truthy("GRAPHAGENT_DISABLE_MODELS_FETCH"),
  GRAPHAGENT_DISABLE_MOUSE: truthy("GRAPHAGENT_DISABLE_MOUSE"),
  GRAPHAGENT_FAKE_VCS: process.env["GRAPHAGENT_FAKE_VCS"],
  GRAPHAGENT_SERVER_PASSWORD: process.env["GRAPHAGENT_SERVER_PASSWORD"],
  GRAPHAGENT_SERVER_USERNAME: process.env["GRAPHAGENT_SERVER_USERNAME"],
  GRAPHAGENT_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("GRAPHAGENT_DISABLE_FFF"),

  // Experimental
  GRAPHAGENT_FILEWATCHER: Config.Boolean("GRAPHAGENT_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  GRAPHAGENT_DISABLE_FILEWATCHER: Config.Boolean("GRAPHAGENT_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  GRAPHAGENT_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("GRAPHAGENT_DISABLE_COPY_ON_SELECT"),
  GRAPHAGENT_MODELS_URL: process.env["GRAPHAGENT_MODELS_URL"],
  GRAPHAGENT_MODELS_PATH: process.env["GRAPHAGENT_MODELS_PATH"],
  GRAPHAGENT_DB: process.env["GRAPHAGENT_DB"],

  GRAPHAGENT_WORKSPACE_ID: process.env["GRAPHAGENT_WORKSPACE_ID"],
  GRAPHAGENT_WORKSPACES: truthy("GRAPHAGENT_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get GRAPHAGENT_DISABLE_PROJECT_CONFIG() {
    return truthy("GRAPHAGENT_DISABLE_PROJECT_CONFIG")
  },
  get GRAPHAGENT_DISABLE_REASONING_DISTILLATION() {
    return truthy("GRAPHAGENT_DISABLE_REASONING_DISTILLATION")
  },
  /** Organizer response-start and stream idle timeout in milliseconds (#643). Defaults to 120s so a long prompt
   * has time to prefill; progressing streams may run longer. Invalid or non-positive values fall back to the default. */
  get GRAPHAGENT_REASONING_DISTILLATION_AUX_TIMEOUT_MS() {
    const parsed = Number(process.env["GRAPHAGENT_REASONING_DISTILLATION_AUX_TIMEOUT_MS"])
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 120_000
  },
  get GRAPHAGENT_TUI_CONFIG() {
    return process.env["GRAPHAGENT_TUI_CONFIG"]
  },
  get GRAPHAGENT_CONFIG_DIR() {
    return process.env["GRAPHAGENT_CONFIG_DIR"]
  },
  get GRAPHAGENT_PERMISSION() {
    return process.env["GRAPHAGENT_PERMISSION"]
  },
  get GRAPHAGENT_CLIENT() {
    return process.env["GRAPHAGENT_CLIENT"] ?? "cli"
  },
}
