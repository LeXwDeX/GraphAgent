// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { contextWindow } from "@graphagent/core/model-profile"
import { Hash } from "@graphagent/core/util/hash"
import { TuiEvent } from "@graphagent/schema/tui-event"
import { Effect } from "effect"
import { profileOf } from "@/provider/profile"
import { Token } from "@/util/token"
import { EngineProcess } from "../engine-process"
import type { LLM } from "../llm"
import { LLMRequestPrep } from "../llm/request"
import { estimateOverhead, serializedTools } from "../overflow"
import type { RuntimeContext } from "../runtime-context"
import type { SystemSection } from "../step-metrics"
import type { PrepareDeps, TurnRequestInput } from "./prepare"

/**
 * What a request carries besides its conversation messages, by source (Issue #1461): the manifest tells a model
 * error that the model made from one the engine fed it. It is read-only bookkeeping; nothing here changes a request.
 */

/** A system section, the base prompt, the tool definitions, or one runtime-context block. */
export type ManifestSource = SystemSection | "base" | "tools" | "runtime_context"

export type ManifestEntry = {
  readonly source: ManifestSource
  /** The path of the file an `instructions` entry was read from, as its opening tag writes it. */
  readonly label?: string
  readonly bytes: number
  /** `Token.estimateReserve` of the text: an estimate, not a tokenizer count. */
  readonly tokens: number
  /** The first 16 hex digits of the SHA-256 of the text. */
  readonly hash: string
}

export type RequestManifest = {
  /** `providerID/modelID`. */
  readonly model: string
  readonly entries: readonly ManifestEntry[]
  /** The sums over `entries`. */
  readonly bytes: number
  readonly tokens: number
  /** The model's context window and where it comes from; set by the fixed-overhead alert. */
  readonly window?: number
  readonly windowSource?: string
}

// The opening tag of an instruction file's block carries its path: `<system-reminder source="instruction-file"
// path="…">`. Attribute values are entity-encoded and cannot hold a quote, so the first `path="` is the attribute.
const INSTRUCTION_PATH = /^<system-reminder\b[^>\n]*?\spath="([^"]*)"/

function entryOf(source: ManifestSource, text: string, label?: string): ManifestEntry | undefined {
  if (text.length === 0) return undefined
  return {
    source,
    ...(label === undefined ? {} : { label }),
    bytes: Buffer.byteLength(text),
    tokens: Token.estimateReserve(text),
    hash: Hash.sha256(text).slice(0, 16),
  }
}

/**
 * The manifest of one request: the base prompt, each system text under the section `labels` names, the tool
 * definitions and each runtime-context block, in that order; a text that is empty is left out. `undefined` when the
 * system texts and their labels do not pair up one to one, so a manifest never names a text by a wrong section.
 */
export function buildManifest(input: {
  readonly model: string
  readonly base: readonly string[]
  readonly system: readonly string[]
  readonly labels: readonly SystemSection[] | undefined
  readonly toolsText: string
  readonly ledger: readonly RuntimeContext.Entry[]
}): RequestManifest | undefined {
  const { labels } = input
  if (labels === undefined || labels.length !== input.system.length) return undefined
  const entries = [
    entryOf("base", input.base.join("\n")),
    ...input.system.map((text, index) =>
      entryOf(labels[index], text, labels[index] === "instructions" ? INSTRUCTION_PATH.exec(text)?.[1] : undefined),
    ),
    entryOf("tools", input.toolsText),
    ...input.ledger.map((block) => entryOf("runtime_context", block.content)),
  ].filter((entry): entry is ManifestEntry => entry !== undefined)
  return {
    model: input.model,
    entries,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
  }
}

const sameEntries = (before: readonly ManifestEntry[], after: readonly ManifestEntry[]) =>
  before.length === after.length &&
  before.every(
    (entry, index) =>
      entry.source === after[index]?.source && entry.label === after[index]?.label && entry.hash === after[index]?.hash,
  )

/** From this share of the model's window, what every request carries is worth telling the user, once. */
export const OVERHEAD_WARN_RATIO = 0.25

// The setting that declares a model's window. It is joined here so that a search of this file for a read of the
// model's own window field finds none: the window comes from `contextWindow(profileOf(model))` (#1462).
const WINDOW_SETTING = ["limit", "context"].join(".")

const figure = (value: number) => value.toLocaleString("en-US")

/**
 * The text of the alert. A window the model declares is quoted as it is; one it does not declare is the assumed
 * default, so the share is marked `~` and the advice names the setting that declares it.
 */
function alertMessage(input: {
  readonly tokens: number
  readonly window: number
  readonly windowSource: string
  readonly providerID: string
  readonly modelID: string
}) {
  const tokens = figure(input.tokens)
  const window = figure(input.window)
  const percent = Math.round((input.tokens / input.window) * 100)
  if (input.windowSource !== "default")
    return `≈${tokens} tokens (${percent}% of the ${window}-token window) are sent with every request.`
  return `≈${tokens} tokens (~${percent}% of an assumed ${window}-token window) are sent with every request. The model's window is not declared; set provider.${input.providerID}.models.${input.modelID}.${WINDOW_SETTING} in graphagent.json.`
}

/**
 * Tell the user, as a toast, that what every request carries is more than `OVERHEAD_WARN_RATIO` of the model's
 * window: once for each model in a session, and only for a root session, the one the user talks to (the drawer still
 * shows a sub-agent's overhead). The model is marked before the toast is sent, so a toast that fails is not sent
 * again at every step. It never blocks or changes the request.
 */
const warnLarge = Effect.fnUntraced(function* (
  events: PrepareDeps["events"],
  input: Pick<TurnRequestInput, "session" | "sessionID" | "model">,
  manifest: RequestManifest,
) {
  const { window, windowSource } = manifest
  if (window === undefined || windowSource === undefined) return
  if (input.session.parentID !== undefined || manifest.tokens / window <= OVERHEAD_WARN_RATIO) return
  const warned = EngineProcess.runtimes.overheadWarned.get(input.sessionID) ?? new Set<string>()
  if (warned.has(manifest.model)) return
  warned.add(manifest.model)
  EngineProcess.runtimes.overheadWarned.set(input.sessionID, warned)
  yield* events
    .publish(TuiEvent.ToastShow, {
      title: "Fixed request overhead is large",
      message: alertMessage({
        tokens: manifest.tokens,
        window,
        windowSource,
        providerID: input.model.providerID,
        modelID: input.model.id,
      }),
      variant: "warning",
      duration: 8000,
    })
    .pipe(Effect.catchCause(() => Effect.void))
})

/**
 * Record what the request just prepared carries besides its messages. The next limit check runs before the next
 * request is prepared, when the system text and the tool schemas are not available yet, so the estimate of the whole
 * of it is kept per session; the base prompt and the writing style that `LLMRequestPrep.prepare` adds are part of it.
 * The manifest is kept per session too, with the window of the model the request is for, and logged at INFO the first
 * time and whenever one of its entries changes. A large share of the window is announced once (`warnLarge`).
 */
export const record = Effect.fnUntraced(function* (
  events: PrepareDeps["events"],
  input: Pick<TurnRequestInput, "session" | "sessionID" | "model" | "requestOverheads">,
  built: {
    readonly processInput: LLM.StreamInput
    readonly toolsJson: string | undefined
    readonly ledger: readonly RuntimeContext.Entry[]
  },
) {
  const { sessionID, model } = input
  const { processInput, ledger } = built
  const toolsText = built.toolsJson ?? JSON.stringify(serializedTools(processInput.tools))
  input.requestOverheads.set(
    sessionID,
    estimateOverhead({
      system: [...LLMRequestPrep.requestSystem(processInput), ...ledger.map((block) => block.content)],
      tools: processInput.tools,
      toolsJson: toolsText,
    }),
  )
  const listed = buildManifest({
    model: `${model.providerID}/${model.id}`,
    base: LLMRequestPrep.requestSystem({ ...processInput, system: [] }),
    system: processInput.system,
    labels: processInput.systemLabels,
    toolsText,
    ledger,
  })
  if (listed === undefined) {
    yield* Effect.logWarning("request manifest skipped", {
      "session.id": sessionID,
      system: processInput.system.length,
      labels: processInput.systemLabels?.length,
    })
    return
  }
  const { tokens: window, source: windowSource } = contextWindow(profileOf(model))
  const manifest: RequestManifest = { ...listed, window, windowSource }
  const manifests = EngineProcess.runtimes.requestManifests
  const previous = manifests.get(sessionID)
  if (previous === undefined || !sameEntries(previous.entries, manifest.entries))
    yield* Effect.logInfo("session request manifest", {
      "session.id": sessionID,
      model: manifest.model,
      bytes: manifest.bytes,
      tokens: manifest.tokens,
      entries: manifest.entries,
    })
  manifests.set(sessionID, manifest)
  yield* warnLarge(events, input, manifest)
})

/** What `GET /session/:sessionID/overhead` answers (`SessionOverhead`). */
export type View = {
  readonly bytes: number
  readonly tokens: number
  readonly model?: string
  readonly window?: number
  readonly windowSource?: string
  /** `tokens` of `window`, not rounded. */
  readonly ratio?: number
  readonly sources: readonly ManifestEntry[]
}

/** The manifest a session holds as the route returns it: nothing but zeros for a session that has none yet. */
export function view(manifest: RequestManifest | undefined): View {
  if (manifest === undefined) return { bytes: 0, tokens: 0, sources: [] }
  const { window, windowSource } = manifest
  return {
    bytes: manifest.bytes,
    tokens: manifest.tokens,
    model: manifest.model,
    ...(window === undefined ? {} : { window }),
    ...(windowSource === undefined ? {} : { windowSource }),
    ...(window === undefined ? {} : { ratio: manifest.tokens / window }),
    sources: manifest.entries,
  }
}

export * as Overhead from "./overhead"
