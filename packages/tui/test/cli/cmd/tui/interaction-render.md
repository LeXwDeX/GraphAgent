# TUI interaction rendering benchmark

Run from `packages/tui`:

```sh
bun test/cli/cmd/tui/interaction-render.bench.tsx baseline
bun test/cli/cmd/tui/interaction-render.bench.tsx bounded
```

The baseline uses OpenTUI's original whole-patch `<diff>` renderer. The bounded mode uses the production `PatchDiff`
component. Both modes use the same parsers, syntax style, fixtures and 30-row terminal at 80 and 160 columns. Run them
sequentially without concurrent builds or tests. Each mode emits JSON lines and exits unsuccessfully if its checks fail.

The budget, fixed before implementation, is p95 input-to-frame and scroll-to-frame latency at or below **100 ms**, with
at most **512 mounted source lines** for the bounded 7,500-line added-file fixture. Every one of 40 input samples must
appear in the captured frame; the bounded fixture must reach both its first and final line.

Each sample sends a key through OpenTUI's mock input into a focused textarea, renders a frame, scrolls to another
position and renders again. Ordinary streaming Markdown and a 100-message transcript are comparison fixtures using
identical code in both modes. The zero-delay timer measures event-loop delay during this interaction sequence.
Mount time includes initial layout and asynchronous syntax highlighting; it is one measurement per fixture.

## Reference measurement

2026-10-15: Apple M4 Pro, 14 CPU cores, 64 GiB RAM, macOS 27.0.1 arm64, Bun 1.4.2, OpenTUI 0.5.12. Values below are
**baseline → bounded**, in milliseconds except mounted lines. Latency percentiles use 40 samples per fixture.

| Fixture / columns  | Mount           | Input p50 / p95           | Scroll p95  | Timer p95   | Mounted source lines |
| ------------------ | --------------- | ------------------------- | ----------- | ----------- | -------------------- |
| Added diff / 80    | 324.64 → 208.11 | 0.34 / 0.72 → 0.39 / 2.69 | 0.40 → 4.91 | 1.62 → 7.17 | 7,500 → 512          |
| Added diff / 160   | 309.98 → 185.21 | 0.36 / 0.94 → 0.24 / 0.66 | 0.55 → 4.01 | 1.71 → 5.54 | 7,500 → 512          |
| Markdown / 80      | 57.61 → 67.92   | 0.67 / 1.05 → 0.60 / 2.45 | 0.26 → 0.20 | 2.17 → 2.75 | —                    |
| Markdown / 160     | 57.18 → 65.93   | 0.38 / 1.06 → 0.44 / 0.98 | 0.15 → 0.20 | 2.50 → 1.72 | —                    |
| 100 messages / 80  | 77.44 → 93.41   | 0.81 / 1.95 → 0.56 / 2.21 | 0.46 → 0.65 | 2.62 → 3.19 | —                    |
| 100 messages / 160 | 61.03 → 69.11   | 0.44 / 0.93 → 0.48 / 2.32 | 0.42 → 0.43 | 1.60 → 3.00 | —                    |

Both modes displayed all 40 input samples in every fixture. Both diff widths reached lines 1 and 7,500. The bounded
renderer reduced mounted native diff content and initial mount time in this run. Creating and disposing chunks during
scrolling costs several milliseconds; steady-state input and scrolling were already fast in the baseline. These results
do not establish a general input-latency improvement. All comparison cases remained within the unchanged budget.

Whole-file text and syntax context remain available, so mounted-line counts are not a measurement of total memory.
Single-run mount results are sensitive to parser startup and host load. This in-process harness does not measure OS
terminal delivery, network time, model latency or the entire application startup path.

Regression coverage in `test/cli/tui/patch-diff.test.tsx`, `test/cli/tui/diff-viewer.test.tsx` and
`test/util/added-patch.test.ts` additionally exercises wrapping, Unicode, multi-line syntax, stable gutters, view changes,
resize with preceding content, file/hunk navigation, review actions, cleanup and the small/mixed/partial-patch fallback.
