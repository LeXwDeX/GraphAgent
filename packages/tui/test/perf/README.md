# TUI performance baseline

This directory measures the pre-rewrite TUI. It mounts the production `Session` and its production `Prompt` under the same provider order as `src/app.tsx`. The keymap is the real OpenTUI keymap plus `registerOpencodeKeymap`. It does not use a standalone `<textarea>` fixture.

## Scope

- `S`, `M`, and `L` sessions contain 25, 100, and 400 deterministic parts.
- Parts use a fixed mix of text, tool output, reasoning, and patch data.
- `M` also has eight child sessions. Each background tick sends a bounded preview shaped like `PartPreview`: the tail is at most 4 KB and the total length is recorded separately.
- Scenarios cover P1-P10, P12-P16, and P19. P5′ and P8′ are the two interference and streaming variants.

## Metric definition

Input and scroll latency starts immediately before the mock key or scroll operation and ends when `await renderOnce()` returns. It includes keymap dispatch, Solid updates, layout, and drawing to the test buffer. It does **not** include bytes written to a real terminal. Frame counts come from `CliRenderEvents.FRAME`; the renderer also exposes `getStats().frameCount` as a fallback. Idle and spinner time advances with `ManualClock`; scenarios do not use real sleeps.

`registerLayer` and keymap selector counters wrap the keymap instance in the harness. Store write counters count `message.*` and `message.part.*` events injected through the SDK event path. This keeps the benchmark independent of the session engine while preserving the production event route.

## Run

From `packages/tui`:

```sh
bun test/perf/run.ts --update-baseline=f21cabe7f
bun test/perf/run.ts
bun test/perf/compare.ts test/perf/baseline-f21cabe7f.json /tmp/tui-current.json
```

The baseline file is a comparison artifact for the code before the F1 interface rewrite. F2 must create a separate `baseline.json`; this file must not be updated after the rewrite. Five repetitions are used by default. Set `PERF_REPEATS` or pass `--repeats=N` when investigating locally.

The nightly PTY measurement is intentionally separate from the PR benchmark:

```sh
TUI_PTY_COMMAND=bun TUI_PTY_ARGS='run dev' bun test/perf/pty.ts
```

It reports the ratio against `TUI_PTY_BASELINE` when that file is supplied. The PTY script uses the Bun PTY driver and does not change `packages/opencode/test/lib/pty.bun.ts`.

## CPU profiles

Profiles are not committed. Capture one profile for each input path on the same machine:

```sh
bun --cpu-prof test/perf/run.ts --profile=char
bun --cpu-prof test/perf/run.ts --profile=slash
```

The `char` profile measures one ordinary character in the `L` session. The `slash` profile measures `/mod` and `Escape` in the same session. On the pre-rewrite tree, the profile is used to verify the F2 hypotheses: repeated keymap selector work and a full resident message tree. The benchmark JSON records the measured proxy latency; the profile itself remains local so it does not add a large binary artifact to the PR.

The local profiles used for this baseline sampled both sides of the hypothesis. `getOwnBinding`, `registerBinding`, `getBindingIdentifiers`, and `_resyncKey` appeared in the keymap path. `updateFromLayout`, `YogaNodeCalculateLayout`, `renderSelf`, and `render` appeared in the render path. The samples were short, so they do not prove that keymap work is the single dominant cost. The result is **partly consistent** with the F2 hypothesis: keymap recomputation is present, and the L fixture keeps the full message tree resident, but F2 should confirm the relative cost with its post-rewrite profile.
