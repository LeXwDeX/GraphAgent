# TUI performance baseline

This directory holds the frame-budget benchmark and CI gate for the GraphAgent TUI (Issue #1025). It mounts the production `Session` and its production `Prompt` under the same provider order as `src/app.tsx`. The keymap is the real OpenTUI keymap plus `registerGraphagentKeymap`. It does not use a standalone `<textarea>` fixture.

## Scope

- `S`, `M`, and `L` sessions contain 25, 100, and 400 deterministic parts.
- Parts use a fixed mix of text, tool output, reasoning, and patch data.
- `M` also has eight background child sessions. Each background tick sends a bounded preview shaped like `PartPreview`: the tail is at most 4 KB and the total length is recorded separately.
- Scenarios cover P1-P20, including the P5′ and P8′ variants and P17b. P5′ is the interference variant and P8′ is the streaming-scroll variant. The gate-critical metrics are:
  - `P11`: viewport anchor drift (`driftPx`) after 200 single-pixel scrolls must stay ≤ 2 px.
  - `P13`: store writes per rendered frame must be ≤ 1 for both `message` and `part`.
  - `P14`: with `M` and eight background sessions producing events, input p95 may grow by at most 10% relative to the quiet run, and non-current sessions must perform zero writes to `store.message` / `store.part` (hard count). Timing starts at `prompt.set` plus `await renderOnce()`; background events are queued through `FrameClock` and dispatched in the same frame, so the frame cost includes event handling.
  - `P15`-`P19`: frame-count metrics. `P15` requires 0 frames while idle for 2 s. `P16` limits busy-spinner frames to `ceil(2 s / TICK_MS) + 2`. `P17` requires offscreen spinners (0 and 8) to stay under the busy limit and to produce the same count. `P17b` requires 0 frames when a panel replaces the composer. `P18` requires 0 frames while the window is unfocused. `P19` requires 0 render requests for idle mouse movement. `TICK_MS` is 90.
  - `P20`: session switching across three windows of 50 rounds each (streaming plus switching). Mounted view nodes in the third window may grow by at most 5% over the second. Mounted nodes are the primary criterion because JSC keeps swept heap blocks and dead cells after `Bun.gc(true)`: a 50-round window can report about 5 MB of heap growth while the reachable object graph is byte-identical. Heap growth therefore cannot distinguish a leak from allocator retention; heap numbers remain in the report as a coarse backstop with a 25% limit.

## Metric definition

Input and scroll latency starts immediately before the mock key or scroll operation and ends when `await renderOnce()` returns. It includes keymap dispatch, Solid updates, layout, and drawing to the test buffer. It does **not** include bytes written to a real terminal. Frame counts come from `CliRenderEvents.FRAME`; the renderer also exposes `getStats().frameCount` as a fallback. Idle and spinner time advances with `ManualClock`; scenarios do not use real sleeps.

`P5` and `P6` sample 50 open/filter/close rounds of the slash menu, up from ten. At ten samples p95 equals the maximum, so a single scheduler hiccup moves the metric; at 50 samples p95 is the 48th value.

`registerLayer` and keymap selector counters wrap the keymap instance in the harness. Store write counters count `message.*` and `message.part.*` events injected through the SDK event path. This keeps the benchmark independent of the session engine while preserving the production event route.

## Gate semantics

`test/perf/compare.ts` compares the current report with a committed baseline. Hard counters fail directly, with no tolerance:

- `P3` `registerLayer` = 0 and `P7` `registerLayer` ≤ 2.
- `P10` `mountedRows` ≤ viewport + 2 × `PART_OVERSCAN` + `TAIL_ALWAYS` (and `scrollChildren` ≤ that limit + 2).
- `P11` `driftPx` ≤ 2.
- `P13` `messageWritesPerFrame` and `partWritesPerFrame` ≤ 1.
- `P14` `nonCurrentMessageWrites` and `nonCurrentPartWrites` = 0.
- `P15`, `P17b`, `P18`, and `P19` `frames` = 0.
- `P16` and `P17` `frames` ≤ `ceil(2 s / TICK_MS) + 2`.
- `P20` `growth` ≤ 0.05 and `heapGrowth` ≤ 0.25.

Timing metrics (`*Ms`) may not exceed `TIMING_RATIO = 1.30`× their baseline value, except p99 metrics (names ending in `p99Ms`), which use `P99_TIMING_RATIO = 1.50`; both are normalized by the machine factor derived from `calibration.fixedLayoutMsMedian`, the median duration of mounting the harness and laying out its first frame through the render path. That factor no longer comes from `calibration.fixedLoopMs`, because a fixed JavaScript loop does not represent render-path machine differences: in the same hosted CI comparison `fixedLoopMs` moved only from 0.79 to 0.86 (1.09×) while `fixedLayoutMsMedian` moved from 23.29 to 35.24 (1.51×), against measured frame-time ratios of 1.4–1.7×. `fixedLoopMs` remains only as a fallback for older reports that lack `fixedLayoutMsMedian`. p99 is the second-worst of 200 keystrokes, so a single scheduler hiccup moves it, the same reason `maxMs` is treated separately. `maxMs` is still excluded from the ratio comparison: it is a single worst frame, and one scheduler hiccup can inflate it far beyond the ratio; `P5`, `P8`, and `P8′` `maxMs` are instead held to an absolute 100 ms ceiling. `MIN_COMPARE_MS = 1` still guards the ratio check: a normalized current value below 1 ms is skipped, because a sub-millisecond sample moves by tens of microseconds under background load and the comparison would measure the scheduler rather than the frame. The `maxMs` ceiling is unaffected. `TIMING_RATIO` may only be tightened; raising `TIMING_RATIO` still requires review, as does raising `P99_TIMING_RATIO`. Replaying the hosted CI bench reports under these rules reduced the failures from 9 to 0.

## Run

From `packages/tui`:

```sh
bun test/perf/run.ts
bun test/perf/run.ts --repeats=3 --out=/tmp/tui-current.json
bun test/perf/run.ts --enforce
bun test/perf/run.ts --update-baseline
bun test/perf/run.ts --update-baseline=<name>
bun test/perf/run.ts --baseline=<name> --enforce
bun test/perf/compare.ts test/perf/baseline.json /tmp/tui-current.json --enforce
```

A plain run measures the fixtures and prints JSON, taking the median across repetitions. The default is `repeats=5`; `PERF_REPEATS` and `--repeats=N` override it.

- `--out=<path>` writes the current report to that path.
- `--update-baseline` (no value) writes `test/perf/baseline.json`. `--update-baseline=<name>` writes `test/perf/baseline-<name>.json` for historical comparison.
- `--baseline=<name>` reads `baseline-<name>.json`; the default is `baseline.json`.
- `--enforce` compares the run with the baseline and exits with code 1 when any check fails. The standalone `compare.ts` command exits with code 1 only when `--enforce` is passed.

`baseline-f21cabe7f.json` is the historical reference from before the OpenTUI upgrade and must not be updated. The current gate uses `baseline.json`. Update a baseline only as part of a reviewed gate change.

The nightly PTY measurement is intentionally separate from the PR benchmark:

```sh
TUI_PTY_COMMAND=bun TUI_PTY_ARGS='run dev' bun test/perf/pty.ts
```

It reports the ratio against `TUI_PTY_BASELINE` when that file is supplied. The PTY script uses the Bun PTY driver and does not change `packages/graphagent/test/lib/pty.bun.ts`.

## CI

`.azure-pipelines/ci.yml` defines the `Bench (TUI)` job on an 8-core GitHub-hosted runner. It runs `bun run bench:tui -- --repeats=5 --enforce`, so both hard counters and the baseline comparison fail inside that job. The job is part of the `Unit Tests (linux)` aggregate gate.

## CPU profiles

Profiles are not committed. Capture one profile for each input path on the same machine:

```sh
bun --cpu-prof test/perf/run.ts --profile=char
bun --cpu-prof test/perf/run.ts --profile=slash
```

The `char` profile measures one ordinary character in the `L` session. The `slash` profile measures `/mod` and `Escape` in the same session. The benchmark JSON records the measured proxy latency; the profile itself remains local so it does not add a large binary artifact to the PR.
