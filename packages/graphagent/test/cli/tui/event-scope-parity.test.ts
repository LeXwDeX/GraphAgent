// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { EventManifest } from "@graphagent/schema/event-manifest"
// `@graphagent/tui` does not export its event gate, and parity needs the module itself, not a copy.
import { eventScope as clientScope } from "../../../../tui/src/context/event-gate"
import { eventScope as workerScope, type EventScope } from "../../../src/cli/tui/event-pump"

/**
 * #886 5.1 and #1013 5.6 share one event classification table. The worker
 * (`event-pump.ts`) filters with it and the TUI (`event-gate.ts`) defends with
 * its own copy. Neither copy may drift: a type the worker forwards as global but
 * the client gates as session-full, or the reverse, either loses events or
 * writes state for sessions that should not have it.
 */
const workerSource = path.resolve(import.meta.dir, "../../../src/cli/tui/event-pump.ts")
const clientSource = path.resolve(import.meta.dir, "../../../../tui/src/context/event-gate.ts")
const tables = ["SESSION_FULL_TYPES", "SESSION_SUMMARY_TYPES"] as const

/** The string literals of a `const NAME = new Set([...])` table, sorted. */
function table(file: string, name: string) {
  const body = readFileSync(file, "utf8").match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))?.[1]
  if (body === undefined) throw new Error(`${name} table not found in ${path.basename(file)}`)
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]).toSorted()
}

const manifest = [...EventManifest.Latest.keys()].toSorted()

describe("worker and client event scope tables", () => {
  test("classify every public event type the same way", () => {
    expect(manifest.length).toBeGreaterThan(0)
    const disagreements = manifest
      .filter((type) => workerScope(type) !== clientScope(type))
      .map((type) => `${type}: worker ${workerScope(type)}, client ${clientScope(type)}`)
    expect(disagreements).toEqual([])
  })

  test("list the same session-full and session-summary types", () => {
    for (const name of tables) {
      const worker = table(workerSource, name)
      expect(worker.length, name).toBeGreaterThan(0)
      expect(table(clientSource, name), name).toEqual(worker)
    }
  })

  test("list only types that exist in the event manifest, each in one table", () => {
    for (const [side, file] of [
      ["worker", workerSource],
      ["client", clientSource],
    ] as const) {
      const listed = tables.flatMap((name) => table(file, name))
      expect(
        listed.filter((type) => !EventManifest.Latest.has(type)),
        `${side} lists a type the manifest does not define`,
      ).toEqual([])
      expect(
        listed.filter((type, index) => listed.indexOf(type) !== index),
        `${side} lists a type in both tables`,
      ).toEqual([])
    }
  })

  test("treat an unlisted type as global on both sides", () => {
    expect(workerScope("some.future.event")).toBe("global")
    expect(clientScope("some.future.event")).toBe("global")
  })
})

describe("worker and client event scope tables against the shared specification", () => {
  const specified: ReadonlyArray<readonly [EventScope, readonly string[]]> = [
    ["global", ["server.instance.disposed", "lsp.updated", "vcs.branch.updated"]],
    [
      "session-summary",
      [
        "session.created",
        "session.updated",
        "session.deleted",
        "session.status",
        "session.error",
        "permission.asked",
        "permission.replied",
        "question.asked",
        "question.replied",
        "question.rejected",
        "question.timed_out",
        "goal.updated",
        "goal.cleared",
        "dag.workflow.summary.updated",
      ],
    ],
    [
      "session-full",
      [
        "message.updated",
        "message.removed",
        "message.part.updated",
        "message.part.removed",
        "message.part.delta",
        "message.part.preview",
        "todo.updated",
        "session.diff",
        "session.hook.status",
        "session.hook.terminal",
        "session.hook.message",
        "dag.workflow.nodes.updated",
      ],
    ],
  ]

  test("place every specified type in its scope on both sides", () => {
    for (const [scope, types] of specified) {
      for (const type of types) {
        expect(workerScope(type), `worker ${type}`).toBe(scope)
        expect(clientScope(type), `client ${type}`).toBe(scope)
      }
    }
  })

  test("keep the specified global families global", () => {
    for (const family of ["mcp.", "project.", "workspace.", "installation.", "tui."]) {
      const members = manifest.filter((type) => type.startsWith(family))
      expect(members.length, family).toBeGreaterThan(0)
      for (const type of members) {
        expect(workerScope(type), `worker ${type}`).toBe("global")
        expect(clientScope(type), `client ${type}`).toBe("global")
      }
    }
  })

  test("keep session.hook.* session-full and the dag.* summaries out of the full set", () => {
    const hooks = manifest.filter((type) => type.startsWith("session.hook."))
    expect(hooks.length).toBeGreaterThan(0)
    for (const type of hooks) {
      expect(workerScope(type), `worker ${type}`).toBe("session-full")
      expect(clientScope(type), `client ${type}`).toBe("session-full")
    }
    const dag = manifest.filter((type) => type.startsWith("dag."))
    expect(dag).toContain("dag.workflow.nodes.updated")
    expect(dag).toContain("dag.workflow.summary.updated")
    for (const type of dag) {
      const scope: EventScope = type === "dag.workflow.nodes.updated" ? "session-full" : "session-summary"
      expect(workerScope(type), `worker ${type}`).toBe(scope)
      expect(clientScope(type), `client ${type}`).toBe(scope)
    }
  })
})
