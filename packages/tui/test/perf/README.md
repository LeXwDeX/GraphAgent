# TUI performance baseline

This directory holds the frame-budget benchmark and CI gate for the GraphAgent TUI (Issue #1025). It mounts the production `Session` and its production `Prompt` under the same provider order as `src/app.tsx`. The keymap is the real OpenTUI keymap plus `registerGraphagentKeymap`. It does not use a standalone `<textarea>` fixture.

## Scope

- `S`, `M`, and `L` sessions contain 25, 100, and 400 deterministic parts.
- Parts use a fixed mix of text, tool output, reasoning, and patch data. In the interior of the loaded page (the session loads its last 100 messages), text parts also carry a fenced code block, a table, or a fenced diff snippet, so the scroll scenarios cross the code-highlight and table layout paths. Both ends of the page stay plain: the typing, streaming, background, and spinner scenarios work at the ends and should keep measuring input handling, and a viewport pinned to the bottom by an absolute offset needs settled row heights there.
- `M` also has eight background child sessions. Each background tick sends a bounded preview shaped like `PartPreview`: the tail is at most 4 KB and the total length is recorded separately.
- Scenarios cover P1-P20, including the P5′ and P8′ variants and P17b. P5′ is the interference variant and P8′ is the streaming-scroll variant. A scenario checks that it did what it claims and throws otherwise, so a run on swallowed keys or a clamped scroll cannot produce numbers. The gate-critical metrics are:
  - `P5`-`P7`: 50 rounds of `/`, `m`, `o`, `d`, `ESC` per size. After the filter the frame must show the menu (the fixture's `/mode` command) and after `ESC` it must be gone. `P5` reports the open p95, the sequence p95, `maxMs` (the slowest key-to-frame time of the whole sequence, `ESC` included), and `frames` (the number of rendered frames). `P6` reports the filter and `ESC` p95. `P7` reports the most layers one round registered. `P5′` is the same sequence on `M` with a streaming update for the main session and a burst from the eight background sessions queued with every key.
  - `P8`: the cold scroll. Bottom to top one viewport per step, back down, then wheel-sized steps (3 rows) up from the bottom; positions come from the live content height. The scenario fails if the walk does not reach the top and the bottom. `P8′` keeps output arriving at the pinned tail while the viewport scrolls up 100 steps, and fails if the viewport stays pinned.
  - `P11`: viewport anchor drift (`driftPx`) after 200 single-pixel scrolls must stay ≤ 2 px.
  - `P13`: store writes per rendered frame must be ≤ 1 for both `message` and `part`.
  - `P14`: with `M` and eight background sessions producing events, input p95 may grow by at most 10% relative to the quiet run (or by at most `P14_ABSOLUTE_INCREASE_MS` when p95 is below 1 ms), and non-current sessions must perform zero writes to `store.message` / `store.part` (hard count). Timing starts at `prompt.set` plus `await renderOnce()`; background events are queued through `FrameClock` and dispatched in the same frame, so the frame cost includes event handling.
  - `P15`-`P19`: frame-count metrics. `P15` requires 0 frames while idle for 2 s. `P16` limits busy-spinner frames to `ceil(2 s / TICK_MS) + 2`. `P17` requires offscreen spinners (0 and 8) to stay under the busy limit and to produce the same count. `P17b` requires 0 frames when a panel replaces the composer. `P18` requires 0 frames while the window is unfocused. `P19` requires 0 render requests for idle mouse movement. `TICK_MS` is 90. Before these windows the scenarios wait for the async syntax highlight of every mounted code block, because a late highlight would add a frame the scenario did not cause. The wait has a deadline (`within` in `settle.ts`), so a parser that never answers fails the run instead of hanging the job.
  - `P20`: session switching across three windows of 50 rounds each (streaming plus switching). Mounted view nodes in the third window may grow by at most 5% over the second. Mounted nodes are the primary criterion because JSC keeps swept heap blocks and dead cells after `Bun.gc(true)`: a 50-round window can report about 5 MB of heap growth while the reachable object graph is byte-identical. Heap growth therefore cannot distinguish a leak from allocator retention; heap numbers remain in the report as a coarse backstop with a 25% limit.

## Metric definition

Input and scroll latency starts immediately before the mock key or scroll operation and ends when `await renderOnce()` returns. It includes keymap dispatch, Solid updates, layout, and drawing to the test buffer. It does **not** include bytes written to a real terminal. Frame counts come from `CliRenderEvents.FRAME`; the renderer also exposes `getStats().frameCount` as a fallback. Idle and spinner time advances with `ManualClock`; scenarios do not use real sleeps.

`P5` and `P6` sample 50 open/filter/close rounds of the slash menu, up from ten. At ten samples p95 equals the maximum, so a single scheduler hiccup moves the metric; at 50 samples p95 is the 48th value.

A lone `ESC` waits in the stdin parser for a 20 ms timer that tells it apart from an escape sequence, and a `ManualClock` never fires that timer on its own. The scenarios therefore advance the clock by 100 ms after every `ESC`, inside the measured window. Without it the menu stays open and the next `/` arrives merged with the `ESC` as Alt+/, which the keymap rejects as an empty key name.

The layer counter (`registerLayer` in the reports) counts both `keymap.registerLayer` and the layer service's `replaceLayer`, with a layer to install. Solid's `useBindings` owns a layer slot and swaps its content through `replaceLayer`, which the keymap does not expose, so a counter that wraps only the public method reads zero while an accessor re-registers its layer on every key. `counters.test.tsx` holds the negative controls: an accessor that reads a per-key signal must be counted once per key, the same signal read inside `enabled` must not be, and a blinded counter fails the controls. The selector counter wraps `getCommandBindings` and `getCommandEntries`, the queries a `useKeymapSelector` makes. Store write counters observe the sync store through `test/fixture/store-write-probe.ts`: a write is counted once per changed `message[sessionID]` or `part[messageID]` key and per flush, so a streamed delta that reached `store.part` is counted and a delivered event that changes nothing is not. Events still enter through the production SDK event path, and `test/perf/harness.test.ts` checks the counters against known writes.

## Gate semantics

`test/perf/compare.ts` checks the current report against fixed rules and against a committed baseline. Hard counters and absolute ceilings never read the baseline; baseline-relative timing does.

**Hard counters** fail directly, with no tolerance:

- `P2` `p95Scale` ≤ 1.5 (p95 of a keystroke in a larger session over the small one). The ratio of two sub-millisecond samples swings several-fold on noise alone, so it fails only when the larger session is also more than `P2_NOISE_FLOOR_MS = 2` ms slower in absolute terms.
- `P3` `registerLayer` = 0 and `P7` `registerLayer` ≤ 2 (the most layers one `/` round registered: open once, close once).
- `P4` `selectorEvaluations` = 0 per keystroke, and equal for `S` and `L`.
- `P10` `mountedRows` ≤ viewport + 2 × `PART_OVERSCAN` + `TAIL_ALWAYS` (and `scrollChildren` ≤ that limit + 2).
- `P11` `driftPx` ≤ 2.
- `P13` `messageWritesPerFrame` and `partWritesPerFrame` ≤ 1.
- `P14` `nonCurrentMessageWrites` and `nonCurrentPartWrites` = 0; `relativeIncrease` ≤ 0.10 when the p95 is at least `MIN_COMPARE_MS`, otherwise `increaseMs` (the p95 with background load minus the quiet p95) ≤ `P14_ABSOLUTE_INCREASE_MS = 0.5`.
- `P15`, `P17b`, `P18`, and `P19` `frames` = 0.
- `P16` and `P17` `frames` ≤ `ceil(2 s / TICK_MS) + 2`.
- `P20` `growth` ≤ 0.05 and `heapGrowth` ≤ 0.25.

**Absolute ceilings** (`ABSOLUTE_CAPS`, milliseconds) are the budgets of Issue #1025 7.4, stated for the reference machine the calibration describes. They do not depend on the baseline's values. On a runner slower than the baseline machine each ceiling is multiplied by the machine factor (`max(1, factor)`), the same headroom the `P2` and `P14` noise floors get; a faster machine is never held to a tighter ceiling. The first hosted run of #1257 (layout calibration 35.48 ms against 23.29 ms, factor 1.52) reported P9 p99 18.64 ms (M) and 16.81 ms (L), about 12.2 and 11.0 ms normalized, below the baseline's 13.4 and 12.8 ms; an unscaled 16 ms ceiling read that runner as a regression. They may only be tightened; loosening one needs the maintainer.

| Scenario         | Metric                         | Ceiling |
| ---------------- | ------------------------------ | ------- |
| P1               | p95 / p99                      | 16 / 33 |
| P5, P5′          | open p95                       | 33      |
| P5, P5′, P8, P8′ | `maxMs` (slowest single frame) | 100     |
| P6               | filter p95, `ESC` p95          | 16      |
| P8, P8′          | p99                            | 33      |
| P9               | p99                            | 16      |
| P12              | p95                            | 33      |

**Baseline-relative timing**: every other `*Ms` metric may not exceed `TIMING_RATIO = 1.30`× its baseline value, except p99 metrics (names ending in `p99Ms`), which use `P99_TIMING_RATIO = 1.50`. Both are normalized by the machine factor derived from `calibration.fixedLayoutMsMedian`, the median duration of mounting the harness and laying out its first frame through the render path. That factor no longer comes from `calibration.fixedLoopMs`, because a fixed JavaScript loop does not represent render-path machine differences: in the same hosted CI comparison `fixedLoopMs` moved only from 0.79 to 0.86 (1.09×) while `fixedLayoutMsMedian` moved from 23.29 to 35.24 (1.51×), against measured frame-time ratios of 1.4–1.7×. `fixedLoopMs` remains only as a fallback for older reports that lack `fixedLayoutMsMedian`. `TIMING_RATIO` and `P99_TIMING_RATIO` may only be tightened.

- A baseline below `MIN_COMPARE_MS = 1` ms is a sub-millisecond sample: it moves by tens of microseconds under background load, and the ratio against it measures the scheduler. It used to be skipped, so only 14 of 42 timing metrics were compared and `P1` p95 could go from 0.49 to 40 ms unnoticed. It is now compared by absolute increase: the normalized current value may exceed the baseline by at most `SUB_MS_ALLOWANCE_MS = 2` ms (the limit is the larger of that and the ratio limit).
- p99 is the second-worst of 200 keystrokes, while the machine factor comes from a median layout duration; scheduler tail latency does not scale with that median, so p99 also gets an absolute allowance, `P99_NOISE_ALLOWANCE_MS = 5` normalized milliseconds. A p99 metric fails only when it exceeds both `1.5× baseline` and `baseline + 5 ms`, so its effective limit is the wider of the two. The same scenario's p99 moves by several milliseconds between hosted CI runs: builds 848 and 860 reported S P9 p99 of 7.03 → 13.90 (factor 1.249) and 7.03 → 14.02 (1.298), builds 854 and 860 reported M P1 of 1.66 → 3.39 (1.331) and 1.66 → 3.96 (1.298), and build 851 reported S P1 of 1.28 → 3.90 (1.450), while builds 841, 842, and 845 passed; the only failing metric was p99. This allowance covers that scheduler tail noise, while a real regression (for example, S P9 at 30 ms) still fails.
- `maxMs` is one worst frame, and one scheduler hiccup can inflate it far beyond any ratio, so it is excluded from the ratio comparison and held to the absolute ceiling instead.
- The noise floors of `P2` and `P14` compare two samples from the same run. They are divided by the machine factor only when the runner is slower than the baseline machine (`max(1, factor)`): the calibration itself moves from 0.5× to 1.1× on one machine, and a faster machine has no reason to tighten them.

**Missing metrics fail the gate.** A rule that reads a metric the scenario never emitted used to pass silently; this is how the 100 ms ceiling on `P5` became dead code when the scenario emitted `maxFrame`. `compareReports` now returns every metric a rule needed from a scenario the report contains but the report lacks, and `--enforce` fails on a non-empty list. `scenarios.test.ts` runs the real scenarios on `S` and `M` and asserts the list is empty and that the keymap stayed quiet.

**Keymap errors fail the run.** The keymap reports a key it cannot resolve (`event-match-resolver-error`, `Invalid key name`) on stderr and carries on, so a run could end with exit code 0 on numbers taken from swallowed keys. `run.ts` watches `console.error`, `console.warn`, and raw stderr writes while the scenarios run and exits 1, without writing a report, if any such message appears. `keymap-errors.test.ts` covers the watcher and `scenarios.test.ts` reproduces the unflushed `ESC` it exists for.

**Pending baseline regeneration.** `baseline.json` was captured before the scenario changes above, so for `P5`, `P5′`, `P6`, `P8`, `P8′`, and `P9` its numbers describe a different experiment (round 0 only, a scroll clamped to the bottom, a fixture without code blocks). `PENDING_REBASELINE` in `compare.ts` lists them and the baseline-relative timing check is skipped for them; hard counters and absolute ceilings still apply, and the run prints the skipped scenarios. The skip is scoped to `PENDING_BASELINE_COMMIT`, the commit `baseline.json` was captured at. Regenerating `baseline.json` (`--update-baseline`) ends it, and `compare.test.ts` then fails until `PENDING_REBASELINE` is emptied. The renamed `P5` `maxFrame` is now `frames`; it is informational and needs no alias.

`compare.test.ts` also feeds forged reports to the gate: a keystroke that re-registers layers (`P3` = 500), a 150 ms frame in `P5`, and every timing 1.5× its baseline all fail it, as does the standalone `compare.ts --enforce` process (exit code 1).

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
- `--enforce` compares the run with the baseline and exits with code 1 when any check fails or a gate metric is missing from the report. The standalone `compare.ts` command exits with code 1 only when `--enforce` is passed.
- A run during which the keymap reports an error exits with code 1 whether or not `--enforce` is passed, and writes no report or baseline.

`baseline-f21cabe7f.json` is the historical reference from before the OpenTUI upgrade and must not be updated. The current gate uses `baseline.json`. Update a baseline only as part of a reviewed gate change.

The nightly PTY measurement is intentionally separate from the PR benchmark:

```sh
TUI_PTY_COMMAND=bun TUI_PTY_ARGS='run dev' bun test/perf/pty.ts
```

It reports the ratio against `TUI_PTY_BASELINE` when that file is supplied. The PTY script uses the Bun PTY driver and does not change `packages/graphagent/test/lib/pty.bun.ts`.

## Related tests

The former standalone `interaction-render` and `reasoning-render` micro-benchmarks are gone. They measured a bare `<textarea>` and `<markdown>`, not the production `Session` and `Prompt`, and CI never ran them. The one check only they had, that a 7,500-line added-file diff mounts at most 512 source lines and still reaches both ends, is covered by `test/cli/tui/patch-diff.test.tsx`; the reasoning renderer by `test/cli/cmd/tui/reasoning-render.test.tsx`.

## CI

`.azure-pipelines/ci.yml` defines the `Bench (TUI)` job on an 8-core GitHub-hosted runner. It runs `bun run bench:tui -- --repeats=5 --enforce`, so both hard counters and the baseline comparison fail inside that job. The job is part of the `Unit Tests (linux)` aggregate gate.

## CPU profiles

Profiles are not committed. Capture one profile for each input path on the same machine:

```sh
bun --cpu-prof test/perf/run.ts --profile=char
bun --cpu-prof test/perf/run.ts --profile=slash
```

The `char` profile measures one ordinary character in the `L` session. The `slash` profile measures `/mod` and `Escape` in the same session. The benchmark JSON records the measured proxy latency; the profile itself remains local so it does not add a large binary artifact to the PR.
