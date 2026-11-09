// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { PluginOptions } from "./options"
import type { ReferenceHooks } from "./reference"
import type { Reload } from "./registration"

export interface PluginContext {
  readonly options: PluginOptions
  readonly reference: ReferenceHooks & Reload
}
