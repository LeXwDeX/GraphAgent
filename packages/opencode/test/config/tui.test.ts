import { expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { CurrentWorkingDirectory } from "@/config/tui-cwd"
import { TuiConfig } from "../../src/config/tui"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Config.defaultLayer, FSUtil.defaultLayer))
const winIt = process.platform === "win32" ? it.instance : it.instance.skip

const globalConfigFiles = ["graphagent.json", "graphagent.jsonc", "tui.json", "tui.jsonc"].map((file) =>
  path.join(Global.Path.config, file),
)

const cleanState = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  delete process.env.GRAPHAGENT_CONFIG
  delete process.env.GRAPHAGENT_TUI_CONFIG
  yield* Effect.forEach(globalConfigFiles, (file) => fs.remove(file, { force: true }).pipe(Effect.ignore), {
    discard: true,
  })
})

const withCleanState = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    cleanState,
    () => self,
    () => cleanState,
  )

const withEnv = <A, E, R>(name: string, value: string | undefined, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }),
  )

const withPlatform = <A, E, R>(platform: typeof process.platform, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")
      Object.defineProperty(process, "platform", {
        ...original,
        value: platform,
      })
      return original
    }),
    () => self,
    (original) =>
      Effect.sync(() => {
        if (original) Object.defineProperty(process, "platform", original)
      }),
  )

const getTuiConfig = (directory: string) =>
  TuiConfig.Service.use((svc) => svc.get()).pipe(
    Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)))),
  )

it.instance("loads tui config with the same precedence order as server config paths", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global" })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "project" })
      yield* fs.writeWithDirs(
        path.join(test.directory, ".agents", "tui.json"),
        JSON.stringify({ theme: "local", diff_style: "stacked" }, null, 2),
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("local")
      expect(config.diff_style).toBe("stacked")
    }),
  ),
)

it.instance("resolves attention config defaults and overrides", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance

      expect((yield* getTuiConfig(test.directory)).attention).toEqual({
        enabled: false,
        notifications: true,
        sound: true,
        volume: 0.4,
        sound_pack: "graphagent.default",
        sounds: {},
      })

      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        attention: {
          enabled: false,
          notifications: false,
          sound: false,
          volume: 0.7,
          sound_pack: "acme.soft",
          sounds: {
            default: path.join(test.directory, "default.mp3"),
            question: pathToFileURL(path.join(test.directory, "question.mp3")).href,
            error: "./error.mp3",
            subagent_done: "./subagent-done.mp3",
          },
        },
      })

      expect((yield* getTuiConfig(test.directory)).attention).toEqual({
        enabled: false,
        notifications: false,
        sound: false,
        volume: 0.7,
        sound_pack: "acme.soft",
        sounds: {
          default: path.join(test.directory, "default.mp3"),
          question: path.join(test.directory, "question.mp3"),
          error: path.join(test.directory, "error.mp3"),
          subagent_done: path.join(test.directory, "subagent-done.mp3"),
        },
      })
    }),
  ),
)

it.instance("does not migrate server configuration keys into tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const source = path.join(test.directory, "graphagent.json")
      yield* fs.writeJson(source, {
        theme: "server-theme",
        tui: { scroll_speed: 5 },
        keybinds: { app_exit: "ctrl+q" },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBeUndefined()
      expect(config.scroll_speed).toBeUndefined()
      expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(false)
      expect(yield* fs.existsSafe(`${source}.tui-migration.bak`)).toBe(false)
      expect(JSON.parse(yield* fs.readFileString(source))).toMatchObject({
        theme: "server-theme",
        tui: { scroll_speed: 5 },
      })
    }),
  ),
)

it.instance("keeps global tui.json authoritative over server configuration keys", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global" })
      yield* fs.writeJson(path.join(test.directory, "graphagent.json"), {
        theme: "server-theme",
        tui: { scroll_speed: 2 },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("global")
      expect(config.scroll_speed).toBeUndefined()
      expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(false)
    }),
  ),
)

it.instance("does not migrate an invalid server config", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeFileString(
        path.join(test.directory, "graphagent.jsonc"),
        `{
  "theme": "broken-theme",
  "tui": { "scroll_speed": 2 }
  "username": "still-broken"
}`,
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBeUndefined()
      expect(config.scroll_speed).toBeUndefined()
      expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(false)
      expect(yield* fs.existsSafe(path.join(test.directory, "graphagent.jsonc.tui-migration.bak"))).toBe(false)
      const source = yield* fs.readFileString(path.join(test.directory, "graphagent.jsonc"))
      expect(source).toContain('"theme": "broken-theme"')
      expect(source).toContain('"tui": { "scroll_speed": 2 }')
    }),
  ),
)

it.instance("does not merge server configuration keys when tui.json exists", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "graphagent.json"), { theme: "server-theme" })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { diff_style: "stacked" })

      const config = yield* getTuiConfig(test.directory)
      expect(config.diff_style).toBe("stacked")
      expect(config.theme).toBeUndefined()

      const server = JSON.parse(yield* fs.readFileString(path.join(test.directory, "graphagent.json")))
      expect(server.theme).toBe("server-theme")
      expect(yield* fs.existsSafe(path.join(test.directory, "graphagent.json.tui-migration.bak"))).toBe(false)
    }),
  ),
)

it.instance("flattens nested tui key inside tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        theme: "outer",
        tui: { scroll_speed: 3, diff_style: "stacked" },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.scroll_speed).toBe(3)
      expect(config.diff_style).toBe("stacked")
      expect(config.theme).toBe("outer")
    }),
  ),
)

it.instance("top-level keys in tui.json take precedence over nested tui key", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        diff_style: "auto",
        tui: { diff_style: "stacked", scroll_speed: 2 },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.diff_style).toBe("auto")
      expect(config.scroll_speed).toBe(2)
    }),
  ),
)

it.instance("project config takes precedence over GRAPHAGENT_TUI_CONFIG (matches GRAPHAGENT_CONFIG)", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const custom = path.join(test.directory, "custom-tui.json")
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "project", diff_style: "auto" })
      yield* fs.writeJson(custom, { theme: "custom", diff_style: "stacked" })

      yield* withEnv(
        "GRAPHAGENT_TUI_CONFIG",
        custom,
        Effect.gen(function* () {
          const config = yield* getTuiConfig(test.directory)
          expect(config.theme).toBe("project")
          expect(config.diff_style).toBe("auto")
        }),
      )
    }),
  ),
)

it.instance("merges keybind overrides across precedence layers", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { keybinds: { app_exit: "ctrl+q" } })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { keybinds: { theme_list: "ctrl+k" } })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("app.exit")?.[0]?.key).toBe("ctrl+q")
      expect(config.keybinds.get("theme.switch")?.[0]?.key).toBe("ctrl+k")
    }),
  ),
)

it.instance("ignores unknown keybind names without dropping valid overrides from the same file", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), {
        keybinds: {
          session_delete: "ctrl+d",
          not_a_real_keybind: "ctrl+q",
        },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("session.delete")?.[0]?.key).toBe("ctrl+d")
      expect(config.keybinds.get("not_a_real_keybind")).toEqual([])
    }),
  ),
)

it.instance("resolves keybind lookup from canonical keybinds", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        keybinds: {
          leader: { key: { name: "g", ctrl: true } },
          command_list: "alt+p",
          diff_open: "ctrl+j",
          which_key_toggle: "alt+k",
          editor_open: "ctrl+e",
          "prompt.autocomplete.next": "ctrl+j",
          "dialog.prompt.submit": "ctrl+s",
          "dialog.mcp.toggle": "ctrl+t",
          model_favorite_toggle: "ctrl+f",
        },
        leader_timeout: 1234,
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("leader")?.[0]?.key).toEqual({ name: "g", ctrl: true })
      expect(config.leader_timeout).toBe(1234)
      expect(config.keybinds.get("command.palette.show")?.[0]?.key).toBe("alt+p")
      expect(config.keybinds.get("diff.open")?.[0]?.key).toBe("ctrl+j")
      expect(config.keybinds.get("session.new")?.[0]?.key).toBe("<leader>n")
      expect(config.keybinds.get("which-key.toggle")?.[0]?.key).toBe("alt+k")
      expect(config.keybinds.get("which-key.layout.toggle")?.[0]?.key).toBe("ctrl+alt+shift+k")
      expect(config.keybinds.get("which-key.pending.toggle")?.[0]?.key).toBe("ctrl+alt+shift+p")
      expect(config.keybinds.get("which-key.group.next")?.[0]?.key).toBe("ctrl+alt+right,ctrl+alt+]")
      expect((config.keybinds.get("which-key.toggle")?.[0] as { desc?: unknown } | undefined)?.desc).toBe(
        "Toggle which-key panel",
      )
      expect(config.keybinds.get("prompt.editor")?.[0]?.key).toBe("ctrl+e")
      expect(config.keybinds.get("prompt.autocomplete.next")?.[0]?.key).toBe("ctrl+j")
      expect(config.keybinds.get("dialog.prompt.submit")?.[0]?.key).toBe("ctrl+s")
      expect(config.keybinds.get("dialog.mcp.toggle")?.[0]?.key).toBe("ctrl+t")
      expect(config.keybinds.get("model.dialog.favorite")?.[0]?.key).toBe("ctrl+f")
    }),
  ),
)

it.instance("keybinds accept OpenTUI binding specs", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        keybinds: {
          command_list: [{ key: "alt+p", preventDefault: false }],
          editor_open: { key: { name: "e", ctrl: true }, group: "Explicit" },
          "prompt.autocomplete.next": false,
        },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("command.palette.show")).toEqual([
        { key: "alt+p", cmd: "command.palette.show", preventDefault: false, desc: "List available commands" },
      ])
      expect(config.keybinds.get("prompt.editor")?.[0]).toMatchObject({
        key: { name: "e", ctrl: true },
        cmd: "prompt.editor",
        group: "Explicit",
      })
      expect(config.keybinds.get("prompt.autocomplete.next")).toEqual([])
    }),
  ),
)

winIt("defaults Ctrl+Z to input undo on Windows", () =>
  withCleanState(
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("terminal.suspend")).toEqual([])
      expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+z,ctrl+-,super+z")
    }),
  ),
)

winIt("keeps explicit input undo overrides on Windows", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { keybinds: { input_undo: "ctrl+y" } })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("terminal.suspend")).toEqual([])
      expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+y")
    }),
  ),
)

winIt("ignores terminal suspend bindings on Windows", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { keybinds: { terminal_suspend: "alt+z" } })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("terminal.suspend")).toEqual([])
      expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+z,ctrl+-,super+z")
    }),
  ),
)

it.instance("applies Windows keybind defaults", () =>
  withCleanState(
    withPlatform(
      "win32",
      Effect.gen(function* () {
        const test = yield* TestInstance
        const config = yield* getTuiConfig(test.directory)
        expect(config.keybinds.get("terminal.suspend")).toEqual([])
        expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+z,ctrl+-,super+z")
      }),
    ),
  ),
)

it.instance("ignores explicit keybind terminal suspend binding on Windows", () =>
  withCleanState(
    withPlatform(
      "win32",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(test.directory, "tui.json"), {
          keybinds: {
            terminal_suspend: "alt+z",
          },
        })

        const config = yield* getTuiConfig(test.directory)
        expect(config.keybinds.get("terminal.suspend")).toEqual([])
      }),
    ),
  ),
)

it.instance("keeps explicit configured keybind input undo on Windows", () =>
  withCleanState(
    withPlatform(
      "win32",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(test.directory, "tui.json"), {
          keybinds: {
            input_undo: "ctrl+y",
          },
        })

        const config = yield* getTuiConfig(test.directory)
        expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+y")
      }),
    ),
  ),
)

it.instance("GRAPHAGENT_TUI_CONFIG provides settings when no project config exists", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const custom = path.join(test.directory, "custom-tui.json")
      yield* fs.writeJson(custom, { theme: "from-env", diff_style: "stacked" })

      yield* withEnv(
        "GRAPHAGENT_TUI_CONFIG",
        custom,
        Effect.gen(function* () {
          const config = yield* getTuiConfig(test.directory)
          expect(config.theme).toBe("from-env")
          expect(config.diff_style).toBe("stacked")
        }),
      )
    }),
  ),
)

it.instance("does not derive tui path from GRAPHAGENT_CONFIG", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const customDir = path.join(test.directory, "custom")
      yield* fs.makeDirectory(customDir, { recursive: true })
      yield* fs.writeJson(path.join(customDir, "graphagent.json"), { model: "test/model" })
      yield* fs.writeJson(path.join(customDir, "tui.json"), { theme: "should-not-load" })

      yield* withEnv(
        "GRAPHAGENT_CONFIG",
        path.join(customDir, "graphagent.json"),
        Effect.gen(function* () {
          const config = yield* getTuiConfig(test.directory)
          expect(config.theme).toBeUndefined()
        }),
      )
    }),
  ),
)

it.instance("applies env and file substitutions in tui.json", () =>
  withCleanState(
    withEnv(
      "TUI_THEME_TEST",
      "env-theme",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeFileString(path.join(test.directory, "keybind.txt"), "ctrl+q")
        yield* fs.writeJson(path.join(test.directory, "tui.json"), {
          theme: "{env:TUI_THEME_TEST}",
          keybinds: { app_exit: "{file:keybind.txt}" },
        })

        const config = yield* getTuiConfig(test.directory)
        expect(config.theme).toBe("env-theme")
        expect(config.keybinds.get("app.exit")?.[0]?.key).toBe("ctrl+q")
      }),
    ),
  ),
)

it.instance("applies file substitutions when first identical token is in a commented line", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeFileString(path.join(test.directory, "theme.txt"), "resolved-theme")
      yield* fs.writeFileString(
        path.join(test.directory, "tui.jsonc"),
        `{
  // "theme": "{file:theme.txt}",
  "theme": "{file:theme.txt}"
}`,
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("resolved-theme")
    }),
  ),
)

it.instance("loads .agents/tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeWithDirs(
        path.join(test.directory, ".agents", "tui.json"),
        JSON.stringify({ diff_style: "stacked" }, null, 2),
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.diff_style).toBe("stacked")
    }),
  ),
)

it.instance("silently skips malformed tui.json - load failures degrade to {}", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeFileString(path.join(test.directory, "tui.json"), '{ "theme": "broken",')
      yield* fs.writeWithDirs(path.join(test.directory, ".agents", "tui.json"), JSON.stringify({ theme: "fallback" }))

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("fallback")
    }),
  ),
)

it.instance("silently skips non-ENOENT read failures (e.g. tui.json is a directory) - fallback layer still loads", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.makeDirectory(path.join(test.directory, "tui.json"), { recursive: true })
      yield* fs.writeWithDirs(path.join(test.directory, ".agents", "tui.json"), JSON.stringify({ theme: "fallback" }))

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("fallback")
    }),
  ),
)

it.instance("missing tui.json - silently treated as empty (ENOENT path)", () =>
  withCleanState(
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* getTuiConfig(test.directory)
      expect(config).toBeDefined()
      expect(config.theme).toBeUndefined()
    }),
  ),
)
