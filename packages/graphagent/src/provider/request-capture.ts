// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * GRAPHAGENT_DEBUG_REQUESTS=1: every request of the AI SDK path is written to
 * `<data>/debug-requests/<session>/<NNNN>.json` (#1461), so a bad answer can be traced to what the engine actually
 * sent instead of to a proxy capture. The body is kept as sent; header values and URL secrets are redacted before
 * anything reaches the disk. Writing is best effort: a failure is a warning and the request still goes out.
 *
 * Retention is `cleanup`, which is never on a request's path: the Provider runs it once per process in the background,
 * and `graphagent debug request` runs it before it looks.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@graphagent/core/global"
import { isRecord } from "@/util/record"
import * as Log from "@/util/log"

const log = Log.create({ service: "provider.request-capture" })

export const DIR = path.join(Global.Path.data, "debug-requests")

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const UNATTRIBUTED = "_unattributed"
const SESSION_NAME = /^[A-Za-z0-9_-]{1,128}$/
const STEP_FILE = /^(\d{4,})\.json$/
/** Names whose values are credentials: header names and URL query parameters. */
const SECRET_NAME = /auth|cookie|key|token|secret|credential|signature|password/
/** Free step numbers are found by listing the directory; writers of one session retry on a collision or a pruned directory. */
const MAX_ATTEMPTS = 64

/** The arguments of the `fetch` call being captured. Only a string or URL input and a string body are recorded. */
export interface FetchCall {
  input: unknown
  init?: { method?: string; headers?: HeadersInit; body?: unknown }
}

export interface Captured {
  sessionID: string
  step: number
  time: string
  method: string
  url: string
  headers: Record<string, string>
  /** The parsed body when it is a JSON object or array, otherwise the text as sent. */
  body: unknown
}

const stepName = (step: number) => `${String(step).padStart(4, "0")}.json`

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function redactHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()].map(([name, value]) => [name, SECRET_NAME.test(name) ? "[REDACTED]" : value]),
  )
}

/**
 * The URL with its user name, password and credential-named query values replaced by `REDACTED` (no brackets, so
 * percent-encoding leaves it alone). A URL with nothing to hide is returned exactly as sent.
 */
function redactUrl(input: string | URL): string {
  const raw = typeof input === "string" ? input : input.href
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return "[unparseable url]"
  }
  let changed = false
  if (url.username) {
    url.username = "REDACTED"
    changed = true
  }
  if (url.password) {
    url.password = "REDACTED"
    changed = true
  }
  const params = new URLSearchParams()
  let hidden = false
  for (const [name, value] of url.searchParams) {
    const secret = SECRET_NAME.test(name.toLowerCase())
    params.append(name, secret ? "REDACTED" : value)
    hidden ||= secret
  }
  if (hidden) {
    url.search = params.toString()
    changed = true
  }
  return changed ? url.href : raw
}

function parseBody(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null ? parsed : text
  } catch {
    return text
  }
}

/** The step numbers in a session directory, ascending. Anything else in the directory is not a step. */
async function steps(sessionDir: string): Promise<number[]> {
  const names = await fs.readdir(sessionDir).catch(() => [] as string[])
  return names
    .flatMap((name) => {
      const match = STEP_FILE.exec(name)
      return match ? [Number(match[1])] : []
    })
    .toSorted((a, b) => a - b)
}

/**
 * The files of a session directory when the newest of them (the directory itself while it has none) is older than
 * `cutoff`; undefined when the session is not idle or cannot be read.
 */
async function idleFiles(sessionDir: string, cutoff: number): Promise<string[] | undefined> {
  try {
    const names = await fs.readdir(sessionDir)
    const seen = await Promise.all(
      names.map((name) =>
        fs.stat(path.join(sessionDir, name)).then(
          (info) => (info.isFile() ? { name, mtime: info.mtimeMs } : undefined),
          () => undefined,
        ),
      ),
    )
    const files = seen.filter((file) => file !== undefined)
    const newest =
      files.length > 0
        ? files.reduce((latest, file) => Math.max(latest, file.mtime), 0)
        : (await fs.stat(sessionDir)).mtimeMs
    return newest < cutoff ? files.map((file) => file.name) : undefined
  } catch {
    return undefined
  }
}

/**
 * Removes the session directories whose newest file is over 7 days older than `now`. Only directories named like a
 * session are touched, and every error is ignored: this is housekeeping for a debug aid.
 *
 * It deletes the files it saw to be old, one by one, and then the directory itself without recursion. A request written
 * after the age check is not in that list and keeps the directory from being empty, so the pruning can run beside
 * writers, of this process or of another, and never takes a fresh request with it.
 */
export async function cleanup(now: number, dir = DIR): Promise<void> {
  const cutoff = now - RETENTION_MS
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_NAME.test(entry.name)) continue
    const sessionDir = path.join(dir, entry.name)
    const idle = await idleFiles(sessionDir, cutoff)
    if (!idle) continue
    for (const name of idle) await fs.unlink(path.join(sessionDir, name)).catch(() => undefined)
    await fs.rmdir(sessionDir).catch(() => undefined)
  }
}

async function exists(target: string) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/** Creates the session directory, and the capture directory above it, 0700 when they are not there yet. */
async function ensureSessionDir(dir: string, sessionDir: string) {
  if (await exists(sessionDir)) return
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 })
}

/** Writes the next step file (0600, never over an existing one) and returns its number. */
async function writeNext(dir: string, sessionDir: string, render: (step: number) => string): Promise<number> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const step = ((await steps(sessionDir)).at(-1) ?? 0) + 1
    try {
      await fs.writeFile(path.join(sessionDir, stepName(step)), render(step), { flag: "wx", mode: 0o600 })
      return step
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined
      // EEXIST: another writer took this number. ENOENT: the pruning removed the session directory just now.
      if (code === "ENOENT") await ensureSessionDir(dir, sessionDir)
      else if (code !== "EEXIST") throw error
    }
  }
  throw new Error(`no free step number in ${sessionDir}`)
}

/**
 * Writes one request. It never throws and never changes `call`; a call whose input is not a string or URL, or whose
 * body is not a string, is skipped. The session comes from the `x-session-id` header that every engine request carries.
 */
export async function record(call: FetchCall, dir = DIR): Promise<void> {
  try {
    const { input, init } = call
    if ((typeof input !== "string" && !(input instanceof URL)) || typeof init?.body !== "string") return
    const headers = new Headers(init.headers)
    const session = headers.get("x-session-id") ?? ""
    const sessionID = SESSION_NAME.test(session) ? session : UNATTRIBUTED
    const sessionDir = path.join(dir, sessionID)
    await ensureSessionDir(dir, sessionDir)
    const time = new Date().toISOString()
    const method = (init.method ?? "GET").toUpperCase()
    const url = redactUrl(input)
    const redacted = redactHeaders(headers)
    const body = parseBody(init.body)
    await writeNext(dir, sessionDir, (step) =>
      JSON.stringify({ sessionID, step, time, method, url, headers: redacted, body }),
    )
  } catch (error) {
    log.warn("request capture failed", { error: errorText(error) })
  }
}

/** The captured steps of a session, ascending. A session id that is not a plain name has none. */
export async function list(sessionID: string, dir = DIR): Promise<number[]> {
  if (!SESSION_NAME.test(sessionID)) return []
  return steps(path.join(dir, sessionID))
}

function isCaptured(value: unknown): value is Captured {
  return (
    isRecord(value) &&
    typeof value.sessionID === "string" &&
    typeof value.step === "number" &&
    typeof value.time === "string" &&
    typeof value.method === "string" &&
    typeof value.url === "string" &&
    isRecord(value.headers) &&
    "body" in value
  )
}

/** One captured request, or undefined when it is missing or its file cannot be read. */
export async function read(sessionID: string, step: number, dir = DIR): Promise<Captured | undefined> {
  if (!SESSION_NAME.test(sessionID) || !Number.isInteger(step)) return undefined
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, sessionID, stepName(step)), "utf8"))
    return isCaptured(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export * as RequestCapture from "./request-capture"
