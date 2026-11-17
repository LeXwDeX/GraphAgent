import { createClient } from "@graphagent/sdk"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { t } from "@graphagent/tui/i18n"

const decodeSessionID = Schema.decodeUnknownSync(SessionID)

export async function validateSession(input: {
  url: string
  sessionID?: string
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
}) {
  if (!input.sessionID) return

  let sessionID: SessionID
  try {
    sessionID = decodeSessionID(input.sessionID)
  } catch (error) {
    throw new Error(
      t("cli.tui.error.invalidSessionID", {
        reason: error instanceof Error ? error.message : t("cli.tui.error.unknown"),
      }),
      { cause: error },
    )
  }

  await createClient({
    baseUrl: input.url,
    directory: input.directory,
    fetch: input.fetch,
    headers: input.headers,
  }).session.get({ sessionID }, { throwOnError: true })
}
