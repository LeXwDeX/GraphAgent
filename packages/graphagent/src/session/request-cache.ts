// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { ByteSize, FileSystem, Option } from "effect"
import { createHash } from "node:crypto"

/**
 * Byte-budgeted insertion-order cache used by the per-request definition caches
 * (Issue #1022, PR5).
 *
 * Tools, instruction files and system fragments reuse the same primitive: a
 * Map whose insertion order is the LRU order, a byte counter, and a hard limit.
 * An entry larger than the whole budget is never stored. Eviction always keeps
 * the entry that was just written.
 */

export interface CacheEntry<T> {
  readonly value: T
  readonly bytes: number
}

export interface CacheState<T> {
  readonly entries: Map<string, CacheEntry<T>>
  bytes: number
  /** `<= 0` disables eviction; the caller still owns the lifecycle. */
  readonly limit: number
}

export function make<T>(limit: number): CacheState<T> {
  return { entries: new Map(), bytes: 0, limit }
}

function enforce<T>(state: CacheState<T>, keep: string) {
  if (state.limit <= 0) return
  for (const [key, entry] of state.entries) {
    if (state.bytes <= state.limit) return
    if (key === keep) continue
    state.entries.delete(key)
    state.bytes -= entry.bytes
  }
}

/** Move-to-tail read; `undefined` also covers a stored `undefined` value. */
export function get<T>(state: CacheState<T>, key: string): T | undefined {
  const entry = state.entries.get(key)
  if (entry === undefined) return undefined
  state.entries.delete(key)
  state.entries.set(key, entry)
  return entry.value
}

export function has<T>(state: CacheState<T>, key: string): boolean {
  return state.entries.has(key)
}

export function set<T>(state: CacheState<T>, key: string, value: T, bytes: number): void {
  if (state.limit > 0 && bytes > state.limit) return
  const previous = state.entries.get(key)
  if (previous) {
    state.bytes -= previous.bytes
    state.entries.delete(key)
  }
  state.entries.set(key, { value, bytes })
  state.bytes += bytes
  enforce(state, key)
}

export function forget<T>(state: CacheState<T>, predicate: (key: string, value: T) => boolean): void {
  for (const [key, entry] of state.entries) {
    if (!predicate(key, entry.value)) continue
    state.entries.delete(key)
    state.bytes -= entry.bytes
  }
}

export function clear<T>(state: CacheState<T>): void {
  state.entries.clear()
  state.bytes = 0
}

export function size<T>(state: CacheState<T>) {
  return { entries: state.entries.size, bytes: state.bytes }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue((value as Record<string, unknown>)[key])
    return sorted
  }
  return value
}

/** Stable JSON for cache keys derived from configuration-shaped values. */
export function canonicalJson(value: unknown) {
  return JSON.stringify(sortValue(value))
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

/**
 * File identity used by the instruction cache. Effect's `File.Info` has no
 * ctime, so the signature is inode, size, mtime and mode. A same-size rewrite
 * within the filesystem's mtime granularity is the known residual window.
 */
export function statSignature(info: FileSystem.File.Info): string {
  const ino = Option.getOrElse(info.ino, () => 0n)
  const mtime = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
  return `${ino}:${ByteSize.toBigInt(info.size).toString()}:${mtime}:${info.mode}`
}

export * as RequestCache from "./request-cache"
