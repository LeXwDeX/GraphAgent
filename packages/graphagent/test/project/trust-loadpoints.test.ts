// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- instance contexts are narrowed from their producing APIs

import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { PROJECT_DIR } from "@graphagent/core/brand"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { EffectFlock } from "@graphagent/core/util/effect-flock"
import { FSUtil } from "@graphagent/core/fs-util"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { scopedHooksWithTrust } from "@/hook/engine/methods"
import { Git } from "@/git"
import type { InstanceContext } from "@/project/instance-context"
import { ProjectTrust } from "@/project/trust"
import { shellVerdict, type ShellVerdict } from "@/project/trust/command-shell"
import type { GateEntry, GateResult } from "@/project/trust/service"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect, pollWithTimeout } from "../lib/effect"

const it = testEffect(Layer.empty)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMMAND_FILE = `---
description: deploy
---
Run !\`git status --short\` then !\`bun run build\`.
`

const SKILL_FILE = `---
name: release
description: release helper
---
Release !\`git tag -l\`.
`

const context = (root: string, trustProject = false): InstanceContext => ({
  directory: root,
  worktree: root,
  root,
  project: { id: "global" } as never,
  ...(trustProject ? { trustProject } as const : {}),
})

/** Write one project tree under a fresh tmpdir; cleaned up with the test scope. */
const withRoot = <A, E, R>(files: Record<string, string>, body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "trust-loadpoints-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(root, { recursive: true, force: true })))
    for (const [file, text] of Object.entries(files)) {
      const target = path.join(root, ...file.split("/"))
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, text)
      })
    }
    return yield* body(root)
  })

const recordingGate = (allowed: boolean[], seen: GateEntry[][]) => (entries: readonly GateEntry[]) =>
  Effect.sync((): GateResult => {
    seen.push(entries.slice())
    return { allowed: entries.map((_, index) => allowed[index] ?? false), skipped: [] }
  })

const uncheckedGate = (seen: GateEntry[][]) => (entries: readonly GateEntry[]) =>
  Effect.sync(() => {
    seen.push(entries.slice())
  }).pipe(Effect.flatMap(() => Effect.die(new Error("gate must not run"))))

const verdict = (input: { root: string; command: string; template: string }, gate: Parameters<typeof shellVerdict>[1]) =>
  shellVerdict(input, gate).pipe(Effect.map((result: ShellVerdict) => result))

// ---------------------------------------------------------------------------
// shellVerdict: command templates
// ---------------------------------------------------------------------------

describe("shellVerdict", () => {
  it.effect("allows matching trusted command-file segments", () =>
    withRoot({ ".agents/commands/deploy.md": COMMAND_FILE }, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const result = yield* verdict(
          { root, command: "deploy", template: "Run !`git status --short` then !`bun run build`." },
          recordingGate([true, true], seen),
        )
        expect(result).toEqual({ type: "allow" })
        expect(seen).toHaveLength(1)
        expect(seen[0].map((item) => item.file)).toEqual(["commands/deploy.md", "commands/deploy.md"])
        expect(seen[0].map((item) => item.scope)).toEqual(["project", "project"])
        expect(seen[0].map((item) => item.entry?.display.text)).toEqual([
          "git status --short",
          "bun run build",
        ])
        expect(seen[0].map((item) => item.entry?.label)).toEqual(["deploy", "deploy"])
      }),
    ),
  )

  it.effect("refuses when any declared segment is not trusted", () =>
    withRoot({ ".agents/commands/deploy.md": COMMAND_FILE }, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const result = yield* verdict(
          { root, command: "deploy", template: "Run !`git status --short` then !`bun run build`." },
          recordingGate([true, false], seen),
        )
        expect(result).toEqual({
          type: "refuse",
          reason: "its project shell segments are not trusted.",
        })
      }),
    ),
  )

  it.effect("refuses an expanded template that does not match the declaration", () =>
    withRoot({ ".agents/commands/deploy.md": COMMAND_FILE }, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const result = yield* verdict(
          { root, command: "deploy", template: "Run !`rm -rf /tmp/x` then !`bun run build`." },
          recordingGate([true, true], seen),
        )
        // The mismatch is rejected before the trust list is consulted.
        expect(result).toEqual({
          type: "refuse",
          reason: "the expanded shell segments do not match the project declaration.",
        })
        expect(seen).toHaveLength(0)
      }),
    ),
  )

  it.effect("refuses $ARGUMENTS expansion that changes the declared segment", () =>
    withRoot(
      {
        ".agents/commands/deploy.md": `---
description: deploy
---
Deploy !\`echo $ARGUMENTS\`.
`,
      },
      (root) =>
        Effect.gen(function* () {
          const seen: GateEntry[][] = []
          const result = yield* verdict(
            { root, command: "deploy", template: "Deploy !`echo production`." },
            recordingGate([true], seen),
          )
          expect(result.type).toBe("refuse")
          expect(seen).toHaveLength(0)
        }),
    ),
  )

  it.effect("allows a command with no project declaration", () =>
    withRoot({}, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const result = yield* verdict({ root, command: "builtin", template: "Run !`uname`." }, recordingGate([], seen))
        expect(result).toEqual({ type: "allow" })
        expect(seen).toHaveLength(0)
      }),
    ),
  )

  it.effect("reads inline command shells from project settings.json", () =>
    withRoot(
      {
        ".agents/settings.json": JSON.stringify({
          command: { ship: { template: "Ship !`bun run ship`." } },
        }),
      },
      (root) =>
        Effect.gen(function* () {
          const seen: GateEntry[][] = []
          const result = yield* verdict(
            { root, command: "ship", template: "Ship !`bun run ship`." },
            recordingGate([true], seen),
          )
          expect(result).toEqual({ type: "allow" })
          expect(seen[0][0]?.file).toBe("settings.json")
          expect(seen[0][0]?.scope).toBe("project")
          expect(seen[0][0]?.entry?.category).toBe("command-shell")
          expect(seen[0][0]?.entry?.label).toBe("ship")
        }),
    ),
  )

  it.effect("reads inline command shells from settings.local.json as local scope", () =>
    withRoot(
      {
        ".agents/settings.local.json": JSON.stringify({
          command: { ship: { template: "Ship !`bun run ship`." } },
        }),
      },
      (root) =>
        Effect.gen(function* () {
          const seen: GateEntry[][] = []
          yield* verdict({ root, command: "ship", template: "Ship !`bun run ship`." }, recordingGate([true], seen))
          expect(seen[0][0]?.file).toBe("settings.local.json")
          expect(seen[0][0]?.scope).toBe("local")
        }),
    ),
  )

  it.effect("reads a project skill body as a command declaration", () =>
    withRoot({ ".agents/skills/release/SKILL.md": SKILL_FILE }, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const result = yield* verdict(
          { root, command: "release", template: "Release !`git tag -l`." },
          recordingGate([true], seen),
        )
        expect(result).toEqual({ type: "allow" })
        expect(seen[0][0]?.file).toBe("skills/release/SKILL.md")
        expect(seen[0][0]?.entry?.label).toBe("release")
        expect(seen[0][0]?.entry?.display.text).toBe("git tag -l")
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// scopedHooksWithTrust: skill/agent frontmatter hooks
// ---------------------------------------------------------------------------

const SCOPED_HOOKS = {
  PreToolUse: [
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: "./allowed.sh" },
        { type: "command", command: "./refused.sh" },
      ],
    },
  ],
}

describe("scopedHooksWithTrust", () => {
  const skillOrigin = (root: string) => `skill:${path.join(root, PROJECT_DIR, "skills", "guard", "SKILL.md")}`

  it.effect("passes the input through without a trust service", () =>
    withRoot({ ".agents/skills/guard/SKILL.md": SKILL_FILE }, (root) =>
      Effect.gen(function* () {
        const input = { kind: "skill" as const, origin: skillOrigin(root), hooks: SCOPED_HOOKS, source: "project" as const }
        const result = yield* scopedHooksWithTrust(input, undefined, context(root))
        expect(result).toBe(input)
      }),
    ),
  )

  it.effect("passes user and builtin sources through untouched", () =>
    withRoot({ ".agents/skills/guard/SKILL.md": SKILL_FILE }, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        for (const source of ["user", "builtin"] as const) {
          const input = { kind: "skill" as const, origin: skillOrigin(root), hooks: SCOPED_HOOKS, source }
          const result = yield* scopedHooksWithTrust(input, { gate: recordingGate([false], seen) }, context(root))
          expect(result).toBe(input)
        }
        expect(seen).toHaveLength(0)
      }),
    ),
  )

  it.effect("passes everything through when the run opted into --trust-project", () =>
    withRoot({ ".agents/skills/guard/SKILL.md": SKILL_FILE }, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const input = { kind: "skill" as const, origin: skillOrigin(root), hooks: SCOPED_HOOKS, source: "project" as const }
        const result = yield* scopedHooksWithTrust(input, { gate: uncheckedGate(seen) }, context(root, true))
        expect(result).toBe(input)
        expect(seen).toHaveLength(0)
      }),
    ),
  )

  it.effect("refuses every hook when all entries are untrusted", () =>
    withRoot({ ".agents/skills/guard/SKILL.md": SKILL_FILE }, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const input = { kind: "skill" as const, origin: skillOrigin(root), hooks: SCOPED_HOOKS, source: "project" as const }
        const result = yield* scopedHooksWithTrust(input, { gate: recordingGate([false, false], seen) }, context(root))
        expect(result).toBeUndefined()
        expect(seen[0].map((item) => item.file)).toEqual(["skills/guard/SKILL.md", "skills/guard/SKILL.md"])
        expect(seen[0].map((item) => item.entry?.category)).toEqual(["skill-hook", "skill-hook"])
      }),
    ),
  )

  it.effect("keeps only trusted hooks from a partially trusted declaration", () =>
    withRoot({ ".agents/skills/guard/SKILL.md": SKILL_FILE }, (root) =>
      Effect.gen(function* () {
        const input = { kind: "skill" as const, origin: skillOrigin(root), hooks: SCOPED_HOOKS, source: "project" as const }
        const result = yield* scopedHooksWithTrust(input, { gate: recordingGate([true, false], []) }, context(root))
        expect(result).not.toBe(input)
        expect(result?.hooks).toEqual({
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./allowed.sh" }] }],
        })
      }),
    ),
  )

  it.effect("labels an agent origin with agent-hook entries", () =>
    withRoot({}, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const origin = `agent:${path.join(root, PROJECT_DIR, "agents", "review.md")}`
        const input = { kind: "agent" as const, origin, hooks: SCOPED_HOOKS, source: "project" as const }
        const result = yield* scopedHooksWithTrust(input, { gate: recordingGate([true, false], seen) }, context(root))
        expect(result?.hooks).toEqual({
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./allowed.sh" }] }],
        })
        expect(seen[0][0]?.file).toBe("agents/review.md")
        expect(seen[0][0]?.entry?.category).toBe("agent-hook")
      }),
    ),
  )

  // `.agents/settings.json`'s `skills.paths` (and `skills.urls`) can name any
  // directory, inside the repo or outside it. `skill/index.ts#skillHookSource`
  // still labels anything outside the user roots `source: "project"`, but the
  // trust panel only ever enumerates `<root>/.agents`. An origin that escapes
  // it therefore has no entry a recorded decision could ever match: it must
  // fail closed, not fall through unchecked. See GraphAgent#1040.
  it.effect("fails closed for a project origin the trust panel never enumerates", () =>
    withRoot({}, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const input = {
          kind: "skill" as const,
          origin: "skill:/opt/other/SKILL.md",
          hooks: SCOPED_HOOKS,
          source: "project" as const,
        }
        const result = yield* scopedHooksWithTrust(input, { gate: recordingGate([false], seen) }, context(root))
        expect(result).toBeUndefined()
        expect(seen).toEqual([[{ scope: "project", file: "/opt/other/SKILL.md", entry: undefined }]])
      }),
    ),
  )

  it.effect("fails closed for a skills.paths directory inside the repo but outside .agents", () =>
    withRoot({}, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const target = path.join(root, "vendor", "skills", "guard", "SKILL.md")
        const input = {
          kind: "skill" as const,
          origin: `skill:${target}`,
          hooks: SCOPED_HOOKS,
          source: "project" as const,
        }
        const result = yield* scopedHooksWithTrust(input, { gate: recordingGate([false], seen) }, context(root))
        expect(result).toBeUndefined()
        expect(seen).toEqual([[{ scope: "project", file: target, entry: undefined }]])
      }),
    ),
  )

  it.effect("fails closed for a skills.paths directory outside the repository root", () =>
    withRoot({}, (root) =>
      withRoot({}, (outside) =>
        Effect.gen(function* () {
          const seen: GateEntry[][] = []
          const target = path.join(outside, "SKILL.md")
          const input = {
            kind: "skill" as const,
            origin: `skill:${target}`,
            hooks: SCOPED_HOOKS,
            source: "project" as const,
          }
          const result = yield* scopedHooksWithTrust(input, { gate: recordingGate([false], seen) }, context(root))
          expect(result).toBeUndefined()
          expect(seen).toEqual([[{ scope: "project", file: target, entry: undefined }]])
        }),
      ),
    ),
  )

  it.effect("fails closed for a skills.paths entry resolved above the project root", () =>
    withRoot({}, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const target = path.resolve(path.join(root, "..", "SKILL.md"))
        const input = {
          kind: "skill" as const,
          origin: `skill:${target}`,
          hooks: SCOPED_HOOKS,
          source: "project" as const,
        }
        const result = yield* scopedHooksWithTrust(input, { gate: recordingGate([false], seen) }, context(root))
        expect(result).toBeUndefined()
        expect(seen).toEqual([[{ scope: "project", file: target, entry: undefined }]])
      }),
    ),
  )

  it.effect("registers an unenumerated origin's hooks once the gate allows it", () =>
    withRoot({}, (root) =>
      Effect.gen(function* () {
        const input = {
          kind: "skill" as const,
          origin: "skill:/opt/other/SKILL.md",
          hooks: SCOPED_HOOKS,
          source: "project" as const,
        }
        // scopedHooksWithTrust must honor whatever the gate decides rather than
        // hardcoding a refusal itself; production `ProjectTrust.gate` always
        // refuses a missing `entry`, but that is the gate's call, not this one.
        const result = yield* scopedHooksWithTrust(input, { gate: recordingGate([true], []) }, context(root))
        expect(result).toBe(input)
      }),
    ),
  )

  it.effect("skips the gate for an unenumerated origin with no hooks to protect", () =>
    withRoot({}, (root) =>
      Effect.gen(function* () {
        const seen: GateEntry[][] = []
        const input = {
          kind: "skill" as const,
          origin: "skill:/opt/other/SKILL.md",
          hooks: {},
          source: "project" as const,
        }
        const result = yield* scopedHooksWithTrust(input, { gate: uncheckedGate(seen) }, context(root))
        expect(result).toBe(input)
        expect(seen).toHaveLength(0)
      }),
    ),
  )

  it.effect("fails closed against the real trust service, with no decision able to trust it", () =>
    withRoot({}, (root) =>
      Effect.gen(function* () {
        const stateDirectory = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "trust-state-")))
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(stateDirectory, { recursive: true, force: true })))
        const services = yield* Layer.build(
          ProjectTrust.makeLayer({ stateDirectory }).pipe(
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(Git.defaultLayer),
            Layer.provide(EventV2Bridge.defaultLayer),
          ),
        )
        const trust = Context.get(services, ProjectTrust.Service)
        const withInstance = <A, E>(effect: Effect.Effect<A, E>) =>
          effect.pipe(Effect.provideService(InstanceRef, context(root)))

        const target = path.join(root, "vendor", "skills", "guard", "SKILL.md")
        const input = {
          kind: "skill" as const,
          origin: `skill:${target}`,
          hooks: SCOPED_HOOKS,
          source: "project" as const,
        }
        const result = yield* withInstance(scopedHooksWithTrust(input, trust, context(root)))
        expect(result).toBeUndefined()

        // No entry the panel enumerates ever carries this synthetic id, so a
        // decision naming it cannot retroactively trust the declaration.
        yield* withInstance(trust.decide([{ id: `${target}|<not-enumerated>`, state: "trusted" }]))
        const stillRefused = yield* withInstance(scopedHooksWithTrust(input, trust, context(root)))
        expect(stillRefused).toBeUndefined()
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Config load point: gated settings and event-driven reload
// ---------------------------------------------------------------------------

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const configWithTrust = (stateDirectory: string) =>
  Config.layer.pipe(
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(AuthTest.empty),
    Layer.provideMerge(infra),
    Layer.provide(NpmTest.noop),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, unexpectedHttp)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(ProjectTrust.makeLayer({ stateDirectory })),
    Layer.provide(Git.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provideMerge(FSUtil.defaultLayer),
  )

const PROJECT_SETTINGS = JSON.stringify({
  formatter: {
    custom: { command: ["bun", "run", ".agents/fmt.ts"], extensions: [".fx"] },
    prettier: { environment: { NODE_OPTIONS: "--require ./.agents/hook.js" } },
  },
  lsp: { custom: { command: ["node", ".agents/lsp.js"], extensions: [".fx"] } },
})

const objectEntry = (value: unknown, key: string): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const entry = (value as Record<string, unknown>)[key]
  if (typeof entry !== "object" || entry === null) return undefined
  return entry as Record<string, unknown>
}

describe("Config trust load point", () => {
  it.effect("hides untrusted project formatter and LSP commands, then reloads on trust", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "trust-config-")))
      const stateDirectory = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "trust-state-")))
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await fs.rm(root, { recursive: true, force: true })
          await fs.rm(stateDirectory, { recursive: true, force: true })
        }),
      )
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(root, ".agents"), { recursive: true })
        await fs.writeFile(path.join(root, ".agents", "settings.json"), PROJECT_SETTINGS)
      })
      // The test body runs inside a scope, so the built layer lives for the
      // whole test and its trust watcher can observe the decision event.
      const services = yield* Layer.build(configWithTrust(stateDirectory))
      const config = Context.get(services, Config.Service)
      const trust = Context.get(services, ProjectTrust.Service)
      const withInstance = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provideService(InstanceRef, context(root)))

      const before = yield* withInstance(config.get())
      const formatter = objectEntry(before.formatter, "custom")
      expect(formatter?.command).toBeUndefined()
      expect(formatter?.extensions).toEqual([".fx"])
      expect(objectEntry(before.lsp, "custom")).toBeUndefined()
      // An environment-only override of a built-in formatter is gated too.
      expect(objectEntry(before.formatter, "prettier")?.environment).toBeUndefined()

      const entries = yield* withInstance(trust.list())
      expect(entries.map((entry) => entry.state)).toEqual(["pending", "pending", "pending"])
      yield* withInstance(
        trust.decide(entries.map((entry) => ({ id: entry.id, state: "trusted" as const }))),
      )

      const trusted = yield* withInstance(
        pollWithTimeout(
          config.get().pipe(Effect.map((cfg) => (objectEntry(cfg.lsp, "custom") !== undefined ? cfg : undefined))),
          "trust decision did not reload the project settings",
        ),
      )
      const trustedFormatter = objectEntry(trusted.formatter, "custom")
      const trustedLsp = objectEntry(trusted.lsp, "custom")
      expect(trustedFormatter?.command).toEqual(["bun", "run", ".agents/fmt.ts"])
      expect(trustedLsp?.command).toEqual(["node", ".agents/lsp.js"])
      expect(objectEntry(trusted.formatter, "prettier")?.environment).toEqual({
        NODE_OPTIONS: "--require ./.agents/hook.js",
      })
    }),
  )
})