// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import type { ProjectTrustEntry } from "@graphagent/sdk"
import { importedEntryIds, snapshotTrust } from "../../src/context/trust-import"

function entry(id: string, fp: string): ProjectTrustEntry {
  return {
    id,
    category: "hook",
    fp,
    state: "pending",
    source: { file: "hooks.json" },
    when: "PreToolUse",
    command: `./scripts/${id}.sh`,
    risks: [],
  }
}

test("the snapshot diff reports entries created or rewritten by the import", () => {
  const before = snapshotTrust([entry("kept", "fp-1"), entry("rewritten", "fp-old"), entry("removed", "fp-x")])
  const after = [entry("kept", "fp-1"), entry("rewritten", "fp-new"), entry("added", "fp-2")]

  expect(importedEntryIds(before, after)).toEqual(["rewritten", "added"])
})

test("unchanged pending entries from before the import are not reported", () => {
  const pending = entry("pending-before", "fp-same")
  const before = snapshotTrust([pending])

  expect(importedEntryIds(before, [pending])).toEqual([])
})

test("removed entries are not reported because there is nothing to confirm", () => {
  const before = snapshotTrust([entry("removed", "fp-x")])

  expect(importedEntryIds(before, [])).toEqual([])
})

test("an empty pre-import snapshot reports every current entry", () => {
  const after = [entry("a", "fp-a"), entry("b", "fp-b")]

  expect(importedEntryIds(snapshotTrust([]), after)).toEqual(["a", "b"])
})
