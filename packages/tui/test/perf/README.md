# TUI performance baseline

This directory holds the frame-budget benchmark and CI gate for the GraphAgent TUI (Issue #1025). It mounts the production `Session` and its production `Prompt` under the same provider order as `src/app.tsx`. The keymap is the real OpenTUI keymap plus `registerGraphagentKeymap`. It does not use a standalone `<textarea>` fixture.

## Scope

- `S`, `M`, `L`, and `XL` sessions contain 25, 100, 400, and 2200 deterministic parts. A session loads its last 100 messages, so the 400 parts of `L` are 400 messages of which the last 100 reach the transcript, about 190 rows. `XL` puts 22 parts into each of the 100 assistant messages a session loads, so every part reaches the transcript: about 2080 rows, above `WINDOW_MIN_ROWS` (2000). It is the one gated session whose transcript is windowed; `S`, `M`, and `L` stay below the threshold and mount every row (the threshold is not 30 any more, see Windowing threshold below).
- Parts use a fixed mix of text, tool output, reasoning, and patch data. In the interior of the loaded page (the session loads its last 100 messages), text parts also carry a fenced code block, a table, or a fenced diff snippet, so the scroll scenarios cross the code-highlight and table layout paths. Both ends of the page stay plain: the typing, streaming, background, and spinner scenarios work at the ends and should keep measuring input handling, and a viewport pinned to the bottom by an absolute offset needs settled row heights there.
- `M` also has eight background child sessions. Each background tick sends a bounded preview shaped like `PartPreview`: the tail is at most 4 KB and the total length is recorded separately.
- Scenarios cover P1-P20, including the P5′ and P8′ variants and P17b. `XL` runs the `windowed` scope: typing at scale (`P1`-`P4`), the slash sequence (`P5`-`P7`), the bound on mounted rows and the anchor (`P10`, `P11`), and the frame counts (`P15`-`P19`). It leaves out the scenarios that time a long scroll or a stream (`P5′`, `P8`, `P8′`, `P9`, `P12`-`P14`, `P20`): over 2000 rows they take 1300 scroll steps and 100 streamed frames, and a windowed step costs about 10 ms (a fully mounted one about 1 ms), close enough to the budgets that a loaded machine fails them. Those budgets are carried by the sessions the threshold keeps fully mounted. P5′ is the interference variant and P8′ is the streaming-scroll variant. A scenario checks that it did what it claims and throws otherwise, so a run on swallowed keys or a clamped scroll cannot produce numbers. The gate-critical metrics are:
  - `P5`-`P7`: 50 rounds of `/`, `m`, `o`, `d`, `ESC` per size. After the filter the frame must show the menu (the fixture's `/mode` command) and after `ESC` it must be gone. `P5` reports the open p95, the sequence p95, `maxMs` (the slowest key-to-frame time of the whole sequence, `ESC` included), and `frames` (the number of rendered frames). `P6` reports the filter and `ESC` p95. `P7` reports the most layers one round registered. `P5′` is the same sequence on `M` with one token of a reply being written at the tail (a `message.part.delta`) and a burst from the eight background sessions queued with every key.
  - `P8`: the cold scroll. Bottom to top one viewport per step, back down, then wheel-sized steps (3 rows) up from the bottom; positions come from the live content height. The scenario fails if the walk does not reach the top and the bottom. `P8′` keeps a reply growing at the pinned tail (one `message.part.delta` per step) while the viewport scrolls up 100 steps, and fails if the viewport stays pinned.
  - `P11`: viewport anchor drift (`driftPx`) after 200 single-pixel scrolls must stay ≤ 2 px.
  - `P12`/`P13`: a reply written at the tail of the last assistant message, the way the server writes one: a `message.part.updated` snapshot opens an empty text part, 100 `message.part.delta` events grow it (one per frame, each followed by a typed character), and a terminal `message.part.updated` closes it. `P12` is the input p95 over those frames. `P13` reports `deltaMessageWrites` and `deltaPartWrites`, the store writes of the delta frames alone, which must be 0 (a token goes to the stream buffer), and `messageWritesPerFrame` / `partWritesPerFrame` over the whole window with the terminal snapshot included, which must be ≤ 1. The scenario fails if the part does not hold every delta it was sent: a delta for a part the store does not have is dropped without a trace, and a dropped delta also reads as 0 writes. The viewport follows the tail, so the reply is on screen. `P5′`, `P8′` and `P20` stream the same way.
  - `P14`: with `M` and eight background sessions producing events, input p95 may grow by at most 10% relative to the quiet run (or by at most `P14_ABSOLUTE_INCREASE_MS` when p95 is below 1 ms), and non-current sessions must perform zero writes to `store.message` / `store.part` (hard count). Timing starts at `prompt.set` plus `await renderOnce()`; background events are queued through `FrameClock` and dispatched in the same frame, so the frame cost includes event handling.
  - `P15`-`P19`: frame-count metrics. `P15` requires 0 frames while idle for 2 s. `P16` limits busy-spinner frames to `ceil(2 s / TICK_MS) + 2`. `P17` requires offscreen spinners (0 and 8) to stay under the busy limit and to produce the same count. A spinner subscribes to the ticker only while it is on screen: a windowed transcript tells it which rows are in its viewport, and every spinner also reads its own position in the nearest scroll box, so the fully mounted sessions hold to the same rule (a culled node reports no size but keeps its position, which is what the check reads). `P17b` requires 0 frames when a panel replaces the composer. `P18` requires 0 frames while the window is unfocused. `P19` requires 0 render requests for idle mouse movement. `TICK_MS` is 90. Before these windows the scenarios wait for the async syntax highlight of every mounted code block, because a late highlight would add a frame the scenario did not cause. The wait has a deadline (`within` in `settle.ts`), so a parser that never answers fails the run instead of hanging the job.
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
- `P10` `mountedRows` ≤ viewport + 2 × `PART_OVERSCAN` + `TAIL_ALWAYS` (and `scrollChildren` ≤ that limit + 2) in a session above `WINDOW_MIN_ROWS`, which the scenario marks `windowed` (its `rows` reach the threshold). Below the threshold every row is mounted by design and the bound does not apply. A report that carries the flag but has no windowed session fails, so the bound cannot go vacuous. `mountedRows` counts the scroll content children that host content; the header spacer, the window controller and the placeholder boxes of unmounted rows are childless.
- `P11` `driftPx` ≤ 2.
- `P13` `deltaMessageWrites` and `deltaPartWrites` = 0; `messageWritesPerFrame` and `partWritesPerFrame` ≤ 1.
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

**Baseline-relative timing**: every other `*Ms` metric may not exceed `TIMING_RATIO = 1.30`× its baseline value, except p99 metrics (names ending in `p99Ms`), which use `P99_TIMING_RATIO = 1.50`. Both are normalized by `max(1, factor)`, where the machine factor derives from `calibration.fixedLayoutMsMedian`, the median duration of mounting `S`, `M`, and `L` and laying out their first frame through the render path (`XL` is left out, so the calibration does not measure transcript size). A runner slower than the baseline machine gets the headroom; a faster one is never held to a tighter limit, because the calibration is itself noisy (0.91 in a run that otherwise matched its baseline, which shrank every limit by 9%). That factor no longer comes from `calibration.fixedLoopMs`, because a fixed JavaScript loop does not represent render-path machine differences: in the same hosted CI comparison `fixedLoopMs` moved only from 0.79 to 0.86 (1.09×) while `fixedLayoutMsMedian` moved from 23.29 to 35.24 (1.51×), against measured frame-time ratios of 1.4–1.7×. `fixedLoopMs` remains only as a fallback for older reports that lack `fixedLayoutMsMedian`. `TIMING_RATIO` and `P99_TIMING_RATIO` may only be tightened.

- A baseline below `MIN_COMPARE_MS = 1` ms is a sub-millisecond sample: it moves by tens of microseconds under background load, and the ratio against it measures the scheduler. It used to be skipped, so only 14 of 42 timing metrics were compared and `P1` p95 could go from 0.49 to 40 ms unnoticed. It is now compared by absolute increase: the normalized current value may exceed the baseline by at most `SUB_MS_ALLOWANCE_MS = 2` ms (the limit is the larger of that and the ratio limit).
- p99 is the second-worst of 200 keystrokes, while the machine factor comes from a median layout duration; scheduler tail latency does not scale with that median, so p99 also gets an absolute allowance, `P99_NOISE_ALLOWANCE_MS = 5` normalized milliseconds. A p99 metric fails only when it exceeds both `1.5× baseline` and `baseline + 5 ms`, so its effective limit is the wider of the two. The same scenario's p99 moves by several milliseconds between hosted CI runs: builds 848 and 860 reported S P9 p99 of 7.03 → 13.90 (factor 1.249) and 7.03 → 14.02 (1.298), builds 854 and 860 reported M P1 of 1.66 → 3.39 (1.331) and 1.66 → 3.96 (1.298), and build 851 reported S P1 of 1.28 → 3.90 (1.450), while builds 841, 842, and 845 passed; the only failing metric was p99. This allowance covers that scheduler tail noise, while a real regression (for example, S P9 at 30 ms) still fails.
- A p95 (names ending in `p95Ms`, any case) with a baseline under `P95_ALLOWANCE_BELOW_MS = 3` ms gets the same kind of allowance, `P95_NOISE_ALLOWANCE_MS = 2` normalized milliseconds: it fails only when it exceeds both `1.3× baseline` and `baseline + 2 ms`. These are short, fast samples (a slash menu opening in 1.8 ms), and on a machine running other work they scatter by more than the ratio: in 11 enforced runs against a fresh baseline, 4 failed on S/M `P5` open p95 or S `P6` escape p95 alone, with S `P5` open going from a 1.83 ms baseline to 3.62 ms and M from 2.05 to 3.21 with nothing changed. Those pass; a real regression (1.83 ms to 8 ms) still fails, and the absolute ceilings still cap the budget itself. A baseline at or above 3 ms is compared by ratio alone. An allowance of 1.5 ms would still have failed the 3.62 ms sample (its limit is 3.33 ms).
- `maxMs` is one worst frame, and one scheduler hiccup can inflate it far beyond any ratio, so it is excluded from the ratio comparison and held to the absolute ceiling instead.
- The noise floors of `P2` and `P14` compare two samples from the same run, and the absolute ceilings do not read the baseline at all. They, like the ratio checks above, scale by the machine factor only when the runner is slower than the baseline machine (`max(1, factor)`): the calibration itself moves from 0.5× to 1.1× on one machine, and a faster machine has no reason to tighten them.

**Missing metrics fail the gate.** A rule that reads a metric the scenario never emitted used to pass silently; this is how the 100 ms ceiling on `P5` became dead code when the scenario emitted `maxFrame`. `compareReports` now returns every metric a rule needed from a scenario the report contains but the report lacks, and `--enforce` fails on a non-empty list. `scenarios.test.ts` runs the real scenarios on `S`, `M`, and `XL` and asserts the list is empty and that the keymap stayed quiet.

**Keymap errors fail the run.** The keymap reports a key it cannot resolve (`event-match-resolver-error`, `Invalid key name`) on stderr and carries on, so a run could end with exit code 0 on numbers taken from swallowed keys. `run.ts` watches `console.error`, `console.warn`, and raw stderr writes while the scenarios run and exits 1, without writing a report, if any such message appears. `keymap-errors.test.ts` covers the watcher and `scenarios.test.ts` reproduces the unflushed `ESC` it exists for.

**Baseline regeneration.** `baseline.json` was regenerated for #1025, because the experiments it recorded had changed. `P5`, `P5′`, and `P6` held round 0 only (`ESC` never closed the menu, so rounds 1-49 failed to parse) and `P5′` injected no keystrokes. `P8` clamped its first 100 steps to the bottom and `P8′` scrolled away from the streaming tail. `P9` ran on a fixture without code blocks, tables, or diffs. `P12` and `P13` wrote to a part that was not on screen and sent snapshots where the server sends deltas. The `P10` counter read rows from their lifecycle passes. The file was captured at `416f7c9de` with bun 1.4.4 (the previous one recorded 1.4.2), OpenTUI 0.8.3, and `--repeats=5`, on an Apple M4 Pro laptop (14 cores, macOS) that was running other work, with a layout calibration of 17.85 ms. A second capture at a different load moved the median timing by 1.08× and the layout calibration from 18.09 to 17.85 ms; only the p99 and `maxMs` tails moved, by up to 1.7×, which is what `P99_NOISE_ALLOWANCE_MS` and the absolute ceilings are for. A hosted runner's own calibration scales every timing and every ceiling through the machine factor.

While a baseline lags a scenario change, `PENDING_REBASELINE` in `compare.ts` lists the changed scenarios and the baseline-relative timing check is skipped for them; hard counters and absolute ceilings still apply, and the run prints the skipped scenarios. The skip is scoped to `PENDING_BASELINE_COMMIT`, the `commit` the baseline file was captured at, so regenerating the file ends it, and `compare.test.ts` then fails until the table is emptied. The table is empty now. The renamed `P5` `maxFrame` is now `frames`; it is informational and needs no alias.

`compare.test.ts` also feeds forged reports to the gate: a keystroke that re-registers layers (`P3` = 500), a 150 ms frame in `P5`, and every timing 1.5× its baseline all fail it, as does the standalone `compare.ts --enforce` process (exit code 1).

## Windowing threshold

`WINDOW_MIN_ROWS` (`src/routes/session/rows.ts`) is 2000. A transcript below it mounts every row; at or above it only the viewport, `PART_OVERSCAN` rows either side, and `TAIL_ALWAYS` rows at the end stay mounted. It was 30 until #1025 measured the alternative on OpenTUI 0.8.3, where the native scroll box already culls what is off screen. Interleaved runs of the scenarios on an Apple M4 Pro (14 cores), windowed / fully mounted, median of five per cell:

| rows | mount ms | heap MB | typing p95 ms | cold scroll p99 ms | hot scroll p99 ms |
| ---: | --- | --- | --- | --- | --- |
| 191 (`L`) | 70 / 96 | 13.9 / 23.3 | 0.31 / 0.32 | 6.8 / 0.84 | 6.6 / 0.14 |
| 1181 | 85 / 222 | 30.6 / 95.2 | 0.32 / 1.12 | 8.5 / 0.97 | 8.2 / 0.40 |
| 1901 | 102 / 299 | 43.6 / 145.9 | 0.31 / 2.10 | 11.2 / 1.70 | 10.4 / 0.87 |
| 3701 | 136 / 483 | 76.6 / 273.5 | 0.30 / 4.64 | 18.2 / 3.69 | 17.1 / 3.27 |

Below about 2000 rows windowing costs more than it saves. A scroll step is 5 to 47 times dearer, because the cost is Solid mounting and unmounting rows and recomputing the row table, not layout or paint. While the viewport scrolls up through rows that have never been measured, the content also moves by several lines (9 jumps of 2 to 8 lines in 450 one-line steps; none when fully mounted), because corrected row heights are not compensated. Typing, mount time, heap, and node count are flat only on the windowed side, and the fully mounted side stays within every budget up to 1900 rows (typing p95 2.1 ms, mount 300 ms, 146 MB). Above that its costs keep growing linearly, and that is where the threshold sits. The cost of a streamed frame (the row table is rebuilt from every part's text) grows with the row count either way, so it argues for neither choice.

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

One keystroke costs about 0.1 ms, which a 1 ms sampler does not resolve, and the profile also holds the process start (Babel transforms of the sources, fixture building, the mount). Repeat the operation until the steady state outweighs all of that:

```sh
bun --cpu-prof --cpu-prof-interval=250 --cpu-prof-dir=/tmp/tui-prof test/perf/run.ts --profile=char --rounds=300
bun --cpu-prof --cpu-prof-interval=250 --cpu-prof-dir=/tmp/tui-prof test/perf/run.ts --profile=slash --rounds=800
bun --cpu-prof ... test/perf/run.ts --profile=char --rounds=300 --size=XL
```

`--rounds=N` types N rounds of 50 characters (`char`, the composer is cleared after each round so that the input stays short) or runs N `/mod` + `Escape` rounds (`slash`), after one warm-up round, and prints percentiles of the measured keys. `--size=XL` selects the 2200-part session.

Read a profile by time window, not by call stack. `renderOnce` is asynchronous, so after an `await` the continuation no longer has the scenario function on its stack, and a stack filter drops most of the render work. Keep the samples between the first and the last one that runs under `typeText` or `slashRound`, then group the self time by source: the native scene frame (`sceneFrameStep` and the other `scene*` FFI wrappers, where the Zig layout and paint run), `@opentui/keymap`, `solid-js`, the application, and the `Intl.Segmenter` calls of `src/prompt/display.ts`. Keep the composer short while profiling typing: the cost of a keystroke grows with the text already in it, so 15 000 characters in one input profile the grapheme walk and not typing.
