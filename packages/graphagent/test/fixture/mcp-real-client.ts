// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// The real MCP SDK Client class, captured before any test file can call
// `mock.module("@modelcontextprotocol/client", ...)`. test/preload.ts imports
// this module first, so the constant below holds the SDK class even after
// sibling tests replace the package with reduced mocks.
//
// A cache-busted re-import no longer isolates the SDK: since 2.4.0 the package
// root re-exports Client from a shared chunk, and Bun patches that chunk's
// binding in place when a test mocks the package, so every importer (including
// a fresh `?bust=` copy of the root) sees the mock. The class object itself is
// never modified, so a reference taken before the mock stays real.
import { Client } from "@modelcontextprotocol/client"

export const RealClient: typeof Client = Client
