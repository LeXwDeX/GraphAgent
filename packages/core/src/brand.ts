// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for user-visible brand identifiers.
//
// This module is intentionally side-effect free and dependency free so that
// modules which must stay synchronous on first import (for example the TUI
// worker console) can import it without pulling in the service graph.

export const APP_NAME = "graphagent"
export const APP_TITLE = "GraphAgent"
export const HOMEPAGE_URL = "https://github.com/LeXwDeX/GraphAgent"
export const PROJECT_DIR = ".agents"
export const CONFIG_BASENAME = "graphagent"
export const ENV_PREFIX = "GRAPHAGENT_"
export const HEADER_PREFIX = "x-graphagent-"
export const METADATA_NAMESPACE = "graphagent"
export const MANAGED_PLIST_DOMAIN = "io.github.lexwdex.graphagent.managed"
