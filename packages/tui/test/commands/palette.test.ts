// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { registerBuiltinCommands } from "../../src/commands/context"
import {
  paletteCommandId,
  paletteRows,
  selectPaletteCommand,
  suggestedCommandIds,
  type PaletteOption,
  type PalettePrompt,
} from "../../src/commands/palette"
import { createCommandRegistry, serverCommandSpec, type CommandRegistry } from "../../src/commands/registry"
import { setLanguage } from "../../src/i18n"

beforeEach(() => {
  setLanguage("en")
})

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

function registryWithBuiltins() {
  const registry = createCommandRegistry({ log: () => {} })
  const dispose = registerBuiltinCommands(registry)
  return { registry, dispose }
}

function fakeClose() {
  const closed: number[] = []
  return {
    close() {
      closed.push(closed.length + 1)
    },
    closed,
  }
}

function fakePrompt() {
  const events: string[] = []
  const prompt: PalettePrompt = {
    current: {
      set(input) {
        events.push(`set:${input.input}`)
      },
      focus() {
        events.push("focus")
      },
    },
  }
  return { prompt, events }
}

function option(id: string, suggested: boolean): PaletteOption {
  return {
    id,
    title: id,
    category: "Session",
    suggested,
  }
}

describe("suggestions", () => {
  test("home suggests model selection and provider connection", () => {
    expect([...suggestedCommandIds({ scope: "home", hasSessions: false, connected: false })]).toEqual([
      "model.list",
      "provider.connect",
    ])
  })

  test("session suggests new session and recent sessions when available", () => {
    expect([...suggestedCommandIds({ scope: "session", hasSessions: true, connected: true })]).toEqual([
      "model.list",
      "session.list",
      "session.new",
    ])
  })

  test("subagent keeps session suggestions and drops the provider hint when connected", () => {
    const ids = suggestedCommandIds({ scope: "subagent", hasSessions: false, connected: true })
    expect([...ids]).toEqual(["model.list", "session.new"])
    expect(ids.has("agent.list")).toBe(false)
  })

  test("home never suggests creating a session when already home", () => {
    expect(suggestedCommandIds({ scope: "home", hasSessions: true, connected: true }).has("session.new")).toBe(false)
  })
})

describe("palette rows", () => {
  test("suggested commands are duplicated above the full list", () => {
    const rows = paletteRows([option("session.new", true), option("help.show", false)])
    expect(rows.map((row) => [row.id, row.category])).toEqual([
      ["suggested:session.new", "Suggested"],
      ["session.new", "Session"],
      ["help.show", "Session"],
    ])
  })

  test("suggested ids resolve back to the command they duplicate", () => {
    expect(paletteCommandId("suggested:session.new")).toBe("session.new")
    expect(paletteCommandId("help.show")).toBe("help.show")
  })

  test("no suggested matches leaves the base list untouched", () => {
    const options = [option("help.show", false), option("app.exit", false)]
    expect(paletteRows(options)).toEqual(options)
  })
})

describe("selection behavior", () => {
  test("/btw prefills the prompt and focuses instead of executing", () => {
    const { registry, dispose } = registryWithBuiltins()
    const { close, closed } = fakeClose()
    const { prompt, events } = fakePrompt()
    const runs: string[] = []
    registry.setHandler("session.btw", (ctx) => {
      runs.push(ctx.args)
    })

    selectPaletteCommand({
      registry,
      spec: registry.find("btw")!,
      close,
      prompt,
    })

    expect(closed).toHaveLength(1)
    expect(events).toEqual(["set:/btw ", "focus"])
    expect(runs).toEqual([])
    dispose()
  })

  test("/rename prefills the current session title", () => {
    const { registry, dispose } = registryWithBuiltins()
    const { close } = fakeClose()
    const { prompt, events } = fakePrompt()
    const runs: string[] = []
    registry.setHandler("session.rename", (ctx) => {
      runs.push(ctx.args)
    })

    selectPaletteCommand({
      registry,
      spec: registry.find("rename")!,
      close,
      prompt,
      renameTitle: "Existing title",
    })

    expect(events).toEqual(["set:/rename Existing title", "focus"])
    expect(runs).toEqual([])
    dispose()
  })

  test("/rename without a title leaves the argument blank", () => {
    const { registry, dispose } = registryWithBuiltins()
    const { prompt, events } = fakePrompt()
    selectPaletteCommand({
      registry,
      spec: registry.find("rename")!,
      close: fakeClose().close,
      prompt,
    })
    expect(events).toEqual(["set:/rename ", "focus"])
    dispose()
  })

  test("commands without arguments execute through the registry", () => {
    const { registry, dispose } = registryWithBuiltins()
    const { close, closed } = fakeClose()
    const { prompt, events } = fakePrompt()
    const runs: Array<{ id: string; args: string; origin: string }> = []
    registry.setHandler("session.new", (ctx) => {
      runs.push({ id: "session.new", ...ctx })
    })

    selectPaletteCommand({
      registry,
      spec: registry.find("new")!,
      close,
      prompt,
    })

    expect(closed).toHaveLength(1)
    expect(events).toEqual([])
    expect(runs).toEqual([{ id: "session.new", args: "", origin: "palette" }])
    dispose()
  })

  test("argument commands execute when no prompt is mounted", () => {
    const { registry, dispose } = registryWithBuiltins()
    const runs: string[] = []
    registry.setHandler("session.btw", (ctx) => {
      runs.push(ctx.args)
    })

    selectPaletteCommand({
      registry,
      spec: registry.find("btw")!,
      close: fakeClose().close,
      prompt: { current: undefined },
    })

    expect(runs).toEqual([""])
    dispose()
  })

  test("server commands run through their bound submission handler", () => {
    const { registry, dispose } = registryWithBuiltins()
    const runs: string[] = []
    // Server specs are registered by the prompt sync; the palette only sees
    // their metadata and runs the handler bound to that id.
    registry.register(
      serverCommandSpec({ name: "init" }, (ctx) => {
        runs.push(`${ctx.origin}:${ctx.args}`)
      })!,
    )

    selectPaletteCommand({
      registry,
      spec: registry.find("init")!,
      close: fakeClose().close,
      prompt: fakePrompt().prompt,
    })

    expect(runs).toEqual(["palette:"])
    dispose()
  })
})

function listIds(registry: CommandRegistry) {
  return registry.list("session").map((spec) => spec.id)
}

test("palette data comes from the registry instead of keymap commands", () => {
  const { registry, dispose } = registryWithBuiltins()
  const values = listIds(registry)
  expect(values).toContain("session.new")
  expect(values).toContain("help.show")
  expect(values).not.toContain("variant.list")
  expect(values).not.toContain("session.toggle.thinking")
  dispose()
})
