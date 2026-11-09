// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Hash } from "../../util/hash"
import type { CanonicalReasoning } from "./canonical"

export type ReasoningReplacement = Readonly<{
  messageID: string
  partID: string
  before: string
  after: string
}>

export const adoptionProvenance = (source: CanonicalReasoning) => ({
  originalText: source.text,
  sourceFingerprint: Hash.sha256(source.text),
  version: 2 as const,
  ...(source.metadata === undefined ? {} : { originalMetadata: source.metadata }),
})
