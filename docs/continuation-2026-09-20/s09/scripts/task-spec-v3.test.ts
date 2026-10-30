import { describe, expect, test } from "bun:test"
import { materializeBodiesV3, V3_MAX_PROVIDER_REQUESTS, V3_TASKS, V3_TASK_IDS } from "./task-spec-v3"

const readFormattedBodyBytes = (body: string) =>
  Buffer.byteLength(
    body
      .split("\n")
      .map((line, index) => `${index + 1}: ${line}`)
      .join("\n"),
  )

describe("S09 task fixture v3", () => {
  test("keeps designated read bodies complete and provider schedules bounded", () => {
    expect(V3_TASK_IDS).toHaveLength(4)
    for (const id of V3_TASK_IDS) {
      const task = V3_TASKS[id]
      const bodies = materializeBodiesV3(id)
      const source = bodies.get(task.sourcePath)
      const witness = bodies.get(task.witnessPath)
      expect(source).toBeDefined()
      expect(witness).toBe(source)
      expect(Buffer.byteLength(source!)).toBeLessThan(50 * 1024)
      expect(readFormattedBodyBytes(source!)).toBeLessThan(50 * 1024)
      expect(task.expectedProviderRequests).toBeLessThanOrEqual(V3_MAX_PROVIDER_REQUESTS)
      expect(task.prompts.reduce((total, prompt) => total + prompt.groups.length + 1, 0)).toBe(
        task.expectedProviderRequests,
      )

      const roles = task.prompts.flatMap((prompt) => prompt.groups.flat()).flatMap((operation) => operation.role ?? [])
      expect(roles).toEqual(["source", "witness"])
    }
  })

  test("preserves the intended read-body pressure while redistributing oversized candidates", () => {
    const total = (id: (typeof V3_TASK_IDS)[number]) =>
      V3_TASKS[id].prompts.reduce(
        (sum, prompt) =>
          sum +
          prompt.groups
            .flat()
            .filter((operation) => operation.kind === "read")
            .reduce(
              (readSum, operation) => readSum + Buffer.byteLength(materializeBodiesV3(id).get(operation.path)!),
              0,
            ),
        0,
      )

    expect(total("t1-read-then-edit")).toBe(152_024)
    expect(total("t2-repeated-search")).toBe(154_092)
    expect(total("t3-aba")).toBe(152_048)
    expect(total("t4-return-earlier")).toBe(166_030)
  })

  test("makes the T1 answer attributable to the final filler read", () => {
    const prompt = V3_TASKS["t1-read-then-edit"].prompts[1]!.text
    expect(prompt).toContain("retries=7; <last word of filler/f02.txt>")
  })
})
