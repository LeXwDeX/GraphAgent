// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export type WorkLimits = Readonly<{
  maxInputBytes: number
  maxOutputCharacters: number
  maxNodes: number
  maxContainerEntries: number
  maxDepth: number
}>

export type WorkBudget = {
  readonly limits: WorkLimits
  inputBytes: number
  outputCharacters: number
  nodes: number
  containerEntries: number
  exceeded: boolean
}

export const createWorkBudget = (limits: WorkLimits): WorkBudget => ({
  limits,
  inputBytes: 0,
  outputCharacters: 0,
  nodes: 0,
  containerEntries: 0,
  exceeded: false,
})

const consume = (
  budget: WorkBudget,
  key: "inputBytes" | "outputCharacters" | "nodes" | "containerEntries",
  amount: number,
) => {
  if (budget.exceeded || !Number.isSafeInteger(amount) || amount < 0) {
    budget.exceeded = true
    return false
  }

  const limitKey =
    key === "inputBytes"
      ? "maxInputBytes"
      : key === "outputCharacters"
        ? "maxOutputCharacters"
        : key === "nodes"
          ? "maxNodes"
          : "maxContainerEntries"
  const next = budget[key] + amount
  if (!Number.isSafeInteger(next) || next > budget.limits[limitKey]) {
    budget.exceeded = true
    return false
  }
  budget[key] = next
  return true
}

export const consumeNode = (budget: WorkBudget, depth: number) => {
  if (!Number.isSafeInteger(depth) || depth > budget.limits.maxDepth) {
    budget.exceeded = true
    return false
  }
  return consume(budget, "nodes", 1)
}

export const consumeContainerEntries = (budget: WorkBudget, count: number) => consume(budget, "containerEntries", count)

export const consumeOutputCharacters = (budget: WorkBudget, count: number) => consume(budget, "outputCharacters", count)

/** Counts UTF-8 bytes without allocating an encoded copy of the string. */
export const consumeString = (budget: WorkBudget, value: string) => {
  if (budget.exceeded || value.length > budget.limits.maxInputBytes - budget.inputBytes) {
    budget.exceeded = true
    return false
  }

  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3

    if (bytes > budget.limits.maxInputBytes - budget.inputBytes) {
      budget.exceeded = true
      return false
    }
  }

  return consume(budget, "inputBytes", bytes)
}
