// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hash } from "@opencode-ai/core/util/hash"
import { MessageID, PartID } from "@/session/schema"

/** A durable workflow event sequence identifies one completion across graph revisions. */
export function reportIdentity(workflow: {
  sessionId: string
  id: string
  seq: number
  completedAt: number | null
  timeUpdated: number
}) {
  const digest = Hash.sha256(JSON.stringify([workflow.sessionId, workflow.id, workflow.seq]))
  const time = workflow.completedAt ?? workflow.timeUpdated
  const stamp = time.toString(16).padStart(12, "0")
  const anchorStamp = Math.max(0, time - 1).toString(16).padStart(12, "0")
  return {
    messageID: MessageID.make(`msg_${stamp}1${digest.slice(0, 13)}`),
    sourceID: PartID.make(`prt_${stamp}0${digest.slice(14, 27)}`),
    answerID: PartID.make(`prt_${stamp}1${digest.slice(28, 41)}`),
    anchorID: MessageID.make(`msg_${anchorStamp}0${digest.slice(42, 55)}`),
  }
}
