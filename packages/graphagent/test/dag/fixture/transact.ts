// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Layer } from "effect"
import { DagLease } from "@graphagent/core/dag/lease"
import { DagTransact } from "@graphagent/core/dag/transact"
import type { Database } from "@graphagent/core/database/database"

/**
 * The real `DagTransact` over the test's own database (Issue #1029, ADR-0008
 * decision 3; 4b-E made it a required dependency of `Dag.layer`).
 *
 * Every harness that assembles `Dag.layer` provides it, instead of a stand-in that runs the
 * body outside a transaction: a command's guard and publish then share one `BEGIN IMMEDIATE`
 * transaction in the test, as in production. The stand-in would hide the very thing the
 * layer exists for. Pass the same `database` layer the harness hands to its store and its
 * event bus, so the transaction and the command's statements use one connection; the lease
 * reads of the fence follow it too.
 *
 * A transaction body takes database work only (`DagTransact`): a test must not park a
 * command's body on a latch, a deferred or a sleep, because the write reservation it holds
 * would block every other statement of the same connection until it resumes. Hold before
 * the command, or after it.
 */
export const transactLayer = <E, R>(database: Layer.Layer<Database.Service, E, R>) =>
  DagTransact.layer.pipe(Layer.provide(Layer.merge(database, DagLease.layer.pipe(Layer.provide(database)))))
