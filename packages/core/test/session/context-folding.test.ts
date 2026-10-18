import { describe, expect, test } from "bun:test"
import {
  normalizeParameters,
  planContextFolding,
  type FoldCandidate,
  type FoldRef,
  type FoldStep,
  type ToolSourceKind,
  type ToolStatus,
} from "../../src/session/context-folding"

type CandidateOptions = Readonly<{
  toolName?: string
  input?: unknown
  text?: string
  complete?: boolean
  comparisonMetadata?: unknown
  resultKind?: "text" | "error" | "unknown"
  failureClass?: string
  taskEpoch?: number
  sourceKind?: ToolSourceKind
  registrationID?: string
  generation?: string
  status?: ToolStatus
  attachments?: "none" | "present" | "unknown"
  instructions?: "none" | "dynamic" | "unknown"
  providerExecuted?: false | true | "unknown"
  targetPath?: string
}>

const candidate = (id: string, options: CandidateOptions = {}): FoldCandidate => {
  const toolName = options.toolName ?? "read"
  const messageID = `message-${id}`
  const callID = `call-${id}`
  const result =
    options.resultKind === "unknown"
      ? ({ kind: "unknown" } as const)
      : options.resultKind === "error"
        ? ({
            kind: "error",
            text: options.text ?? "A",
            complete: options.complete ?? true,
            failureClass: options.failureClass ?? "tool-error",
            ...(Object.hasOwn(options, "comparisonMetadata") ? { comparisonMetadata: options.comparisonMetadata } : {}),
          } as const)
        : Object.hasOwn(options, "comparisonMetadata")
          ? ({
              kind: "text",
              text: options.text ?? "A",
              complete: options.complete ?? true,
              comparisonMetadata: options.comparisonMetadata,
            } as const)
          : ({ kind: "text", text: options.text ?? "A", complete: options.complete ?? true } as const)

  return {
    ref: { messageID, partID: `part-${id}`, callID },
    toolName,
    source: {
      sessionID: "session-1",
      assistantMessageID: messageID,
      callID,
      toolName,
      sourceKind: options.sourceKind ?? "host-builtin",
      registrationID: options.registrationID ?? `builtin-${toolName}`,
      registrationGeneration: options.generation ?? "generation-1",
    },
    status: options.status ?? "completed",
    input: options.input ?? { filePath: "/workspace/file.ts" },
    result,
    safety: {
      attachments: options.attachments ?? "none",
      instructions: options.instructions ?? "none",
      providerExecuted: options.providerExecuted ?? false,
    },
    targetPath: toolName === "read" ? (options.targetPath ?? "/workspace/file.ts") : options.targetPath,
    ...(options.taskEpoch === undefined ? {} : { taskEpoch: options.taskEpoch }),
  }
}

const step = (id: string, candidates: readonly FoldCandidate[] = [], estimatedTokens = 4_000): FoldStep => ({
  id,
  estimatedTokens,
  candidates,
})

const recentProtection = (prefix: string) => [
  step(`${prefix}-recent-1`),
  step(`${prefix}-recent-2`),
  step(`${prefix}-recent-3`),
  step(`${prefix}-recent-4`),
]

const refKey = (ref: FoldRef) => `${ref.messageID}/${ref.partID}/${ref.callID}`
const sourceKeys = (steps: readonly FoldStep[]) =>
  new Set(planContextFolding(steps).replacements.map((replacement) => refKey(replacement.source)))
// Without task-epoch information every source belongs to the current task, so `anchor` defaults to true.
const fold = (
  source: FoldRef,
  witness: FoldRef,
  extras: Readonly<{ resultKind?: "text" | "error"; anchor?: boolean }> = {},
) => ({
  source,
  witness,
  resultKind: extras.resultKind ?? "text",
  anchor: extras.anchor ?? true,
})

describe("context-folding planner", () => {
  test("U01 fixes the latest complete A as witness for A/A/A", () => {
    const steps = [
      step("a-1", [candidate("a-1")]),
      step("a-2", [candidate("a-2")]),
      step("a-3", [candidate("a-3")]),
      ...recentProtection("u01"),
    ]

    const plan = planContextFolding(steps)
    expect(plan.skipReason).toBeUndefined()
    expect(plan.replacements).toEqual([
      fold(candidate("a-1").ref, candidate("a-3").ref),
      fold(candidate("a-2").ref, candidate("a-3").ref),
    ])
    expect(plan.replacements.some((replacement) => refKey(replacement.source) === refKey(candidate("a-3").ref))).toBe(
      false,
    )
  })

  test("U02 and U03 preserve B and order while an earlier A references only the latest A", () => {
    const a1 = candidate("aba-a1", { text: "A" })
    const b = candidate("aba-b", { text: "B" })
    const a2 = candidate("aba-a2", { text: "A" })
    const plan = planContextFolding([
      step("aba-1", [a1]),
      step("aba-2", [b]),
      step("aba-3", [a2]),
      ...recentProtection("u03"),
    ])

    expect(plan.replacements).toEqual([fold(a1.ref, a2.ref)])
    expect(sourceKeys([step("a", [a1]), step("b", [b]), ...recentProtection("u02")])).toEqual(new Set())
  })

  test("U04 and U05 do not mix pagination, paths, or search filters", () => {
    const cases: readonly [FoldCandidate, FoldCandidate][] = [
      [
        candidate("page-1", { input: { filePath: "/a", offset: 0, limit: 100 }, targetPath: "/a" }),
        candidate("page-2", { input: { filePath: "/a", offset: 100, limit: 100 }, targetPath: "/a" }),
      ],
      [
        candidate("grep-1", {
          toolName: "grep",
          input: { pattern: "needle", path: "/one", include: "*.ts" },
        }),
        candidate("grep-2", {
          toolName: "grep",
          input: { pattern: "needle", path: "/two", include: "*.ts" },
        }),
      ],
      [
        candidate("filter-1", {
          toolName: "grep",
          input: { pattern: "needle", path: "/one", include: "*.ts" },
        }),
        candidate("filter-2", {
          toolName: "grep",
          input: { pattern: "needle", path: "/one", include: "*.go" },
        }),
      ],
    ]

    for (const [first, second] of cases) {
      const plan = planContextFolding([
        step(`first-${first.ref.callID}`, [first]),
        step(`second-${second.ref.callID}`, [second]),
        ...recentProtection(first.ref.callID),
      ])
      expect(plan.replacements).toEqual([])
    }
  })

  test("U06 sorts object keys recursively without changing array order", () => {
    const first = candidate("keys-1", {
      input: { filePath: "/workspace/file.ts", options: { offset: 0, tags: ["a", "b"] } },
    })
    const second = candidate("keys-2", {
      input: { options: { tags: ["a", "b"], offset: 0 }, filePath: "/workspace/file.ts" },
    })
    const plan = planContextFolding([step("keys-1", [first]), step("keys-2", [second]), ...recentProtection("u06")])

    expect(plan.replacements).toEqual([fold(first.ref, second.ref)])
  })

  test("U06 and U07 compare adapter-validated result metadata without adding defaults", () => {
    const first = candidate("metadata-1", {
      comparisonMetadata: { type: "text", mime: "text/plain", offset: 0, truncated: false, next: null },
    })
    const reordered = candidate("metadata-2", {
      comparisonMetadata: { next: null, truncated: false, offset: 0, mime: "text/plain", type: "text" },
    })
    const changed = candidate("metadata-3", {
      comparisonMetadata: { type: "text", mime: "text/plain", offset: 0, truncated: false, next: 100 },
    })
    const absent = candidate("metadata-absent")
    const explicitNull = candidate("metadata-null", { comparisonMetadata: null })

    expect(
      planContextFolding([
        step("metadata-1", [first]),
        step("metadata-2", [reordered]),
        ...recentProtection("metadata-equal"),
      ]).replacements,
    ).toEqual([fold(first.ref, reordered.ref)])
    expect(
      planContextFolding([
        step("metadata-2", [reordered]),
        step("metadata-3", [changed]),
        ...recentProtection("metadata-different"),
      ]).replacements,
    ).toEqual([])
    expect(
      planContextFolding([
        step("metadata-absent", [absent]),
        step("metadata-null", [explicitNull]),
        ...recentProtection("metadata-missing"),
      ]).replacements,
    ).toEqual([])
  })

  test("U07 preserves array order, missing/null, whitespace, and path differences", () => {
    const normalized = [
      normalizeParameters({ values: [1, 2] }),
      normalizeParameters({ values: [2, 1] }),
      normalizeParameters({}),
      normalizeParameters({ value: null }),
      normalizeParameters({ path: "/workspace/a" }),
      normalizeParameters({ path: "/workspace/./a" }),
    ]
    expect(normalized.every((value) => value.ok)).toBe(true)
    expect(new Set(normalized.map((value) => (value.ok ? value.value : "invalid"))).size).toBe(normalized.length)

    const compact = candidate("space-1", { text: "line\n" })
    const spaced = candidate("space-2", { text: "line \n" })
    expect(
      planContextFolding([step("space-1", [compact]), step("space-2", [spaced]), ...recentProtection("u07")])
        .replacements,
    ).toEqual([])
  })

  test("U08 does not mix tools, registrations, generations, sessions, or untrusted sources", () => {
    const read = candidate("source-read")
    const grep = candidate("source-grep", { toolName: "grep", input: { filePath: "/workspace/file.ts" } })
    const otherRegistration = candidate("source-registration", { registrationID: "another-read" })
    const otherGeneration = candidate("source-generation", { generation: "generation-2" })
    const custom = candidate("source-custom", { sourceKind: "custom" })
    const crossSessionBase = candidate("source-session")
    const crossSession: FoldCandidate = {
      ...crossSessionBase,
      source: { ...crossSessionBase.source, sessionID: "session-2" },
    }
    const plan = planContextFolding([
      step("source-read", [read]),
      step("source-grep", [grep]),
      step("source-registration", [otherRegistration]),
      step("source-generation", [otherGeneration]),
      step("source-custom", [custom]),
      step("source-session", [crossSession]),
      ...recentProtection("u08"),
    ])

    expect(plan.replacements).toEqual([])
    expect(plan.exclusions).toContainEqual({ ref: custom.ref, reason: "untrusted-source" })
  })

  test("U08 allows each whitelisted read, grep, and glob tool only within its own group", () => {
    const read1 = candidate("allowed-read-1")
    const read2 = candidate("allowed-read-2")
    const grep1 = candidate("allowed-grep-1", { toolName: "grep", input: { pattern: "needle", path: "/workspace" } })
    const grep2 = candidate("allowed-grep-2", { toolName: "grep", input: { path: "/workspace", pattern: "needle" } })
    const glob1 = candidate("allowed-glob-1", { toolName: "glob", input: { pattern: "**/*.ts", path: "/workspace" } })
    const glob2 = candidate("allowed-glob-2", { toolName: "glob", input: { path: "/workspace", pattern: "**/*.ts" } })
    const plan = planContextFolding([
      step("allowed-read-1", [read1]),
      step("allowed-read-2", [read2]),
      step("allowed-grep-1", [grep1]),
      step("allowed-grep-2", [grep2]),
      step("allowed-glob-1", [glob1]),
      step("allowed-glob-2", [glob2]),
      ...recentProtection("u08-allowed"),
    ])

    expect(plan.replacements).toEqual([
      fold(read1.ref, read2.ref),
      fold(grep1.ref, grep2.ref),
      fold(glob1.ref, glob2.ref),
    ])
  })

  test("U09 protects duplicates when every occurrence is recent", () => {
    const first = candidate("recent-a1")
    const second = candidate("recent-a2")
    const plan = planContextFolding([
      step("recent-1", [first]),
      step("recent-2", [second]),
      step("recent-3"),
      step("recent-4"),
    ])

    expect(plan.replacements).toEqual([])
    expect(plan.skipReason).toBe("all-sources-protected")
  })

  test("U10 permits a recent complete result to witness an older source", () => {
    const source = candidate("recent-witness-source")
    const witness = candidate("recent-witness-latest")
    const plan = planContextFolding([
      step("old", [source]),
      step("recent-1"),
      step("recent-2"),
      step("recent-3"),
      step("recent-4", [witness]),
    ])

    expect(plan.replacements).toEqual([fold(source.ref, witness.ref)])
  })

  test("U11 extends recent protection past four steps to 16000 tokens and keeps parallel siblings together", () => {
    const old = candidate("parallel-old")
    const protectedFirst = candidate("parallel-first")
    const protectedLatest = candidate("parallel-latest")
    const steps = [
      step("old", [old], 3_000),
      step("protected-siblings", [protectedFirst, protectedLatest], 3_000),
      step("recent-2", [], 3_000),
      step("recent-3", [], 3_000),
      step("recent-4", [], 3_000),
      step("recent-5", [], 3_000),
      step("recent-6", [], 3_000),
    ]
    const plan = planContextFolding(steps)

    expect(plan.protectedStepIDs).toEqual([
      "protected-siblings",
      "recent-2",
      "recent-3",
      "recent-4",
      "recent-5",
      "recent-6",
    ])
    expect(plan.replacements).toEqual([fold(old.ref, protectedLatest.ref)])
    expect(plan.replacements.some((replacement) => refKey(replacement.source) === refKey(protectedFirst.ref))).toBe(
      false,
    )
  })

  test("U12 protects instruction files and dynamically loaded instructions as both source and witness", () => {
    const protectedNames = ["AGENTS.md", "agents.override.MD", "CLAUDE.md", "context.md", "SKILL.MD"]
    for (const [index, name] of protectedNames.entries()) {
      const first = candidate(`instruction-${index}-1`, { targetPath: `/workspace/${name}` })
      const second = candidate(`instruction-${index}-2`, { targetPath: `/workspace/${name}` })
      const plan = planContextFolding([
        step(`instruction-${index}-1`, [first]),
        step(`instruction-${index}-2`, [second]),
        ...recentProtection(`u12-${index}`),
      ])
      expect(plan.replacements).toEqual([])
      expect(plan.exclusions).toContainEqual({ ref: first.ref, reason: "instruction-content" })
      expect(plan.exclusions).toContainEqual({ ref: second.ref, reason: "instruction-content" })
    }

    const dynamic = candidate("instruction-dynamic", { instructions: "dynamic" })
    expect(
      planContextFolding([
        step("instruction-dynamic-1", [dynamic]),
        step("instruction-dynamic-2", [candidate("instruction-dynamic-2", { instructions: "dynamic" })]),
        ...recentProtection("u12-dynamic"),
      ]).replacements,
    ).toEqual([])
  })

  test("U13 ignores non-success states, shell/write tools, and custom tools", () => {
    const guarded = [
      candidate("pending", { status: "pending" }),
      candidate("running", { status: "running" }),
      candidate("error", { status: "error" }),
      candidate("interrupted", { status: "interrupted" }),
      candidate("shell", { toolName: "bash", targetPath: undefined }),
      candidate("write", { toolName: "write", targetPath: undefined }),
      candidate("mcp", { sourceKind: "mcp" }),
    ]
    const plan = planContextFolding([
      ...guarded.map((item, index) => step(`guarded-${index}`, [item])),
      ...guarded.map((item, index) =>
        step(`guarded-copy-${index}`, [
          candidate(`guarded-copy-${index}`, {
            toolName: item.toolName,
            status: item.status,
            sourceKind: item.source.sourceKind,
            targetPath: item.targetPath,
          }),
        ]),
      ),
      ...recentProtection("u13"),
    ])

    expect(plan.replacements).toEqual([])
    // An error-status candidate that carries no complete error payload is rejected by the error gate.
    expect(plan.exclusions.filter((item) => item.reason === "unsafe-error-payload")).toHaveLength(2)
    expect(plan.exclusions.filter((item) => item.reason === "unsuccessful")).toHaveLength(6)
    expect(plan.exclusions.filter((item) => item.reason === "unsupported-tool").length).toBeGreaterThanOrEqual(2)
    expect(plan.exclusions.some((item) => item.reason === "untrusted-source")).toBe(true)
  })

  test("U14 protects attachments, unknown structures, truncated bodies, and provider execution", () => {
    const guarded = [
      candidate("attachment", { attachments: "present" }),
      candidate("attachment-unknown", { attachments: "unknown" }),
      candidate("unknown-result", { resultKind: "unknown" }),
      candidate("truncated", { complete: false }),
      candidate("provider", { providerExecuted: true }),
      candidate("provider-unknown", { providerExecuted: "unknown" }),
    ]
    const plan = planContextFolding([
      ...guarded.map((item, index) => step(`unknown-${index}`, [item])),
      ...recentProtection("u14"),
    ])

    expect(plan.replacements).toEqual([])
    expect(new Set(plan.exclusions.map((item) => item.reason))).toEqual(
      new Set(["attachments", "unknown-content", "incomplete-content", "provider-executed"]),
    )
  })

  test("U18 rechecks complete identity after an injected fingerprint collision", () => {
    const a = candidate("collision-a", { text: "A" })
    const b = candidate("collision-b", { text: "B" })
    const plan = planContextFolding([step("collision-a", [a]), step("collision-b", [b]), ...recentProtection("u18")], {
      fingerprint: () => "forced-collision",
    })

    expect(plan.replacements).toEqual([])
    expect(plan.skipReason).toBe("no-eligible-duplicates")
  })

  test("U18 fails closed when fingerprinting is unavailable", () => {
    const plan = planContextFolding(
      [step("fingerprint-1", [candidate("fingerprint-1")]), step("fingerprint-2", [candidate("fingerprint-2")])],
      {
        fingerprint: () => {
          throw new Error("unavailable")
        },
      },
    )

    expect(plan).toMatchObject({ replacements: [], skipReason: "fingerprint-failed" })
  })

  test("U20 fails closed for exceptional parameter values", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const throwingAccessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("must not be invoked")
      },
    })
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("unavailable")
        },
      },
    )
    const sparse = Array(2)
    sparse[1] = "value"
    const exotic = Object.create({ inherited: true })
    exotic.value = "value"
    const invalid: readonly unknown[] = [
      cycle,
      throwingAccessor,
      throwingProxy,
      sparse,
      exotic,
      { value: undefined },
      { value: 1n },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
    ]

    for (const [index, input] of invalid.entries()) {
      const first = candidate(`invalid-${index}-1`, { input })
      const second = candidate(`invalid-${index}-2`, { input })
      expect(() =>
        planContextFolding([
          step(`invalid-${index}-1`, [first]),
          step(`invalid-${index}-2`, [second]),
          ...recentProtection(`u20-${index}`),
        ]),
      ).not.toThrow()
      const plan = planContextFolding([
        step(`invalid-${index}-1`, [first]),
        step(`invalid-${index}-2`, [second]),
        ...recentProtection(`u20-${index}`),
      ])
      expect(plan.replacements).toEqual([])
      expect(plan.exclusions).toContainEqual({ ref: first.ref, reason: "normalization-failed" })
    }
  })

  test("U20 fails closed for exceptional comparison metadata", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const throwingAccessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("must not be invoked")
      },
    })

    for (const [index, comparisonMetadata] of [cycle, throwingAccessor, undefined].entries()) {
      const first = candidate(`invalid-metadata-${index}-1`, { comparisonMetadata })
      const second = candidate(`invalid-metadata-${index}-2`, { comparisonMetadata })
      const plan = planContextFolding([
        step(`invalid-metadata-${index}-1`, [first]),
        step(`invalid-metadata-${index}-2`, [second]),
        ...recentProtection(`invalid-metadata-${index}`),
      ])
      expect(plan.replacements).toEqual([])
      expect(plan.exclusions).toContainEqual({ ref: first.ref, reason: "normalization-failed" })
    }
  })

  test("U20 treats unknown step measurement and ambiguous references as whole-plan failures", () => {
    const measured = candidate("invalid-measurement")
    const unknownTokens = planContextFolding([
      step("unknown-tokens", [measured], Number.NaN),
      step("unknown-tokens-copy", [candidate("invalid-measurement-copy")]),
    ])
    expect(unknownTokens).toMatchObject({ replacements: [], skipReason: "unknown-step-tokens" })
    expect(unknownTokens.protectedStepIDs).toEqual(["unknown-tokens", "unknown-tokens-copy"])

    const duplicateRef = candidate("duplicate-ref")
    const ambiguous = planContextFolding([
      step("duplicate-1", [duplicateRef]),
      step("duplicate-2", [duplicateRef]),
      ...recentProtection("duplicate"),
    ])
    expect(ambiguous).toMatchObject({ replacements: [], skipReason: "invalid-structure" })
  })

  test("E01 keeps text and error results in separate identity classes", () => {
    const text = candidate("class-text", { text: "same-visible-bytes" })
    const error = candidate("class-error", { resultKind: "error", status: "error", text: "same-visible-bytes" })
    const plan = planContextFolding([
      step("class-text", [text]),
      step("class-error", [error]),
      ...recentProtection("e01"),
    ])

    expect(plan.replacements).toEqual([])
  })

  test("E02 folds identical error payloads only within the same failure class", () => {
    const first = candidate("error-1", { resultKind: "error", status: "error", text: "boom" })
    const second = candidate("error-2", { resultKind: "error", status: "error", text: "boom" })
    expect(
      planContextFolding([step("error-1", [first]), step("error-2", [second]), ...recentProtection("e02-positive")])
        .replacements,
    ).toEqual([fold(first.ref, second.ref, { resultKind: "error" })])

    const otherClass = candidate("error-class", {
      resultKind: "error",
      status: "error",
      text: "boom",
      failureClass: "timeout",
    })
    expect(
      planContextFolding([
        step("error-1", [first]),
        step("error-class", [otherClass]),
        ...recentProtection("e02-negative"),
      ]).replacements,
    ).toEqual([])
  })

  test("E03 rejects an error result without a complete class-tagged payload", () => {
    const incomplete = candidate("error-incomplete", { resultKind: "error", status: "error", complete: false })
    const missingClass = candidate("error-missing-class", { resultKind: "error", status: "error", failureClass: "" })
    const textPayload = candidate("error-text-payload", { status: "error" })
    const plan = planContextFolding([
      step("error-incomplete", [incomplete]),
      step("error-missing-class", [missingClass]),
      step("error-text-payload", [textPayload]),
      ...recentProtection("e03"),
    ])

    expect(plan.replacements).toEqual([])
    for (const item of [incomplete, missingClass, textPayload])
      expect(plan.exclusions).toContainEqual({ ref: item.ref, reason: "unsafe-error-payload" })
  })

  test("E04 anchors duplicate sources from the current task and defers older epochs", () => {
    const old = candidate("epoch-old", { taskEpoch: 1 })
    const current = candidate("epoch-current", { taskEpoch: 2 })
    const witness = candidate("epoch-witness", { taskEpoch: 2 })
    const plan = planContextFolding([
      step("epoch-old-step", [old]),
      step("epoch-current-step", [current]),
      step("epoch-witness-step", [witness]),
      ...recentProtection("e04"),
    ])

    expect(plan.replacements).toEqual([
      fold(old.ref, witness.ref, { anchor: false }),
      fold(current.ref, witness.ref, { anchor: true }),
    ])
  })

  test("E05 rejects a malformed task epoch instead of guessing a boundary", () => {
    for (const taskEpoch of [-1, 1.5, Number.NaN]) {
      const plan = planContextFolding([
        step("epoch-invalid", [candidate("epoch-invalid", { taskEpoch })]),
        step("epoch-invalid-copy", [candidate("epoch-invalid-copy", { taskEpoch })]),
        ...recentProtection(`e05-${taskEpoch}`),
      ])
      expect(plan).toMatchObject({ replacements: [], skipReason: "invalid-structure" })
    }
  })

  test("U21 is deterministic and does not mutate frozen input", () => {
    const deepFreeze = (value: unknown, seen = new Set<object>()): void => {
      if (!value || typeof value !== "object" || seen.has(value)) return
      seen.add(value)
      for (const child of Object.values(value)) deepFreeze(child, seen)
      Object.freeze(value)
    }

    const steps = [
      step("deterministic-1", [candidate("deterministic-1")]),
      step("deterministic-2", [candidate("deterministic-2")]),
      ...recentProtection("u21"),
    ]
    const before = JSON.stringify(steps)
    deepFreeze(steps)

    const first = planContextFolding(steps)
    const second = planContextFolding(steps)
    expect(second).toEqual(first)
    expect(JSON.stringify(steps)).toBe(before)
  })

  test("property: every source has a later full witness, witnesses are not sources, and protected steps stay intact", () => {
    let state = 0x5f3759df
    const random = () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return state >>> 0
    }
    let observedReplacements = 0

    for (let run = 0; run < 200; run++) {
      const steps: FoldStep[] = []
      for (let index = 0; index < 12; index++) {
        const group = random() % 4
        const version = random() % 5 === 0 ? "B" : "A"
        const input =
          random() % 4 === 0
            ? { filePath: `/workspace/${group}.ts`, offset: 1 }
            : { offset: 0, filePath: `/workspace/${group}.ts` }
        steps.push(
          step(
            `property-${run}-${index}`,
            [
              candidate(`property-${run}-${index}`, {
                input,
                text: `${group}-${version}`,
                targetPath: `/workspace/${group}.ts`,
              }),
            ],
            1_000 + (random() % 5_000),
          ),
        )
      }

      const plan = planContextFolding(steps, { fingerprint: () => "forced-property-collision" })
      const flattened = steps.flatMap((item, stepIndex) =>
        item.candidates.map((item, candidateIndex) => ({ item, stepIndex, candidateIndex })),
      )
      const byRef = new Map(flattened.map((item, index) => [refKey(item.item.ref), { ...item, index }]))
      const sources = new Set(plan.replacements.map((replacement) => refKey(replacement.source)))
      observedReplacements += plan.replacements.length

      for (const replacement of plan.replacements) {
        const source = byRef.get(refKey(replacement.source))!
        const witness = byRef.get(refKey(replacement.witness))!
        expect(source.index).toBeLessThan(witness.index)
        expect(sources.has(refKey(replacement.witness))).toBe(false)
        expect(plan.protectedStepIDs).not.toContain(steps[source.stepIndex].id)
        expect(source.item.toolName).toBe(witness.item.toolName)
        expect(source.item.source.registrationID).toBe(witness.item.source.registrationID)
        expect(source.item.source.registrationGeneration).toBe(witness.item.source.registrationGeneration)
        expect(normalizeParameters(source.item.input)).toEqual(normalizeParameters(witness.item.input))
        expect(source.item.result).toEqual(witness.item.result)
      }

      for (const protectedStepID of plan.protectedStepIDs) {
        const protectedStep = steps.find((item) => item.id === protectedStepID)!
        for (const item of protectedStep.candidates) expect(sources.has(refKey(item.ref))).toBe(false)
      }
    }

    expect(observedReplacements).toBeGreaterThan(0)
  })
})
