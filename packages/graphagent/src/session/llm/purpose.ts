// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** What a model request is for. The native runtime skips timeout retries for `compaction`. */
export type RequestPurpose = "conversation" | "compaction" | "auxiliary" | "unknown"

export * as LLMPurpose from "./purpose"
