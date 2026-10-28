# Lint performance

A cold lint of this repository takes about 5 s wall and 36 s CPU, and peaks
at about 6 GB of memory. Allocation and heap growth cost more CPU than
running the linters' scripts. Analysis keeps every core busy, so that CPU
is wall time.

| | Median | Range |
|---|---|---|
| Wall | 5.02 s | 4.62–5.89 s |
| CPU | 36.5 s | 33.1–43.3 s |
| Max RSS | 6.02 GB | 5.74–6.26 GB |

These are five cold runs at `v0.18.0` on a 10-core Mac with 32 GB, Go
1.27.1. A run makes 5,742 analyzer passes over 363 packages, 36 of them in
the module. The breakdowns below come from one profiled run, which the
profiling slowed to 7.0 s. They predate [Early release](#early-release),
which cut cold wall time to 4.54 s and peak memory to about 3.7 GB.

## Timeline

| Time | Cores busy | Phase |
|---|---|---|
| 0–0.7 s | about 1.3 | Compiling scripts (0.44 s), looking up cached findings (0.53 s) |
| 0.7–1.5 s | 4–9 | Loading and type-checking packages |
| 1.5–6.1 s | 10 | Analysis |
| 6.1–6.5 s | falling | Tail |

Stop-the-world pauses total 24 ms.

## CPU

| Cost | CPU | Share |
|---|---|---|
| Heap growth: `madvise` | 10.8 s | 29% |
| GC marking | 6.2 s | 16% |
| Zeroing fresh memory | 3.7 s | 10% |
| Running scripts | 12.5 s | 33% |
| …of which calls into Go through the bridge | 5.6 s | 15% |
| SSA, type-checking and parsing | 2.4 s | 6% |

Go marks newly mapped memory as released, so on macOS every new span calls
`madvise(MADV_FREE_REUSE)` in `sysUsed`. The kernel serialises those calls.
Growing the heap by 4 GB in 8 KB objects in a standalone program:

| Threads | Wall | CPU |
|---|---|---|
| 1 | 0.29 s | 0.28 s |
| 2 | 0.38 s | 0.74 s |
| 4 | 0.30 s | 1.18 s |
| 10 | 0.36 s | 3.29 s |

Wall time does not change with threads; CPU grows with them. In tsk, ten
threads grow the heap to about 6 GB while analysing, and the contention is
worth about 1.1 s of the 4.6 s of analysis. Allocating in 1 MB or larger
blocks makes growth nearly free.

## Memory

Peak RSS is about twice the live heap, 2.7 GB at the last collection, as
expected with GOGC=100.

| Live at peak | Size | Why |
|---|---|---|
| SSA from `buildssa` | 0.87 GB | The x/tools checker keeps every result until all passes finish |
| Syntax and types from loading | 0.73 GB | Needed throughout |
| Held by script runs | 0.66 GB | Not yet attributed |
| Inspectors | 0.35 GB | Built for all 363 packages and kept to the end |

printf, inline, exhaustive and sumtype run on every dependency for their
facts, and each requires `inspect`, so every dependency gets an inspector.

## Allocation

A run allocates 11.3 GB:

| Source | Allocated | Share |
|---|---|---|
| Script runs | 6.9 GB | 61% |
| …calls into Go through the bridge | 2.8 GB | |
| ……object wrappers | 1.2 GB | |
| ……arrays for slices | 0.9 GB | |
| …sobek arrays | 1.4 GB | |
| …arrow functions | 0.5 GB | |
| …array iterators for `for…of` | 0.3 GB | |
| SSA | 2.1 GB | 19% |
| …dependency members, recreated for each package | 1.0 GB | |
| Package loading | 1.2 GB | 11% |
| Inspectors | 0.5 GB | 4% |

Arrays are created mostly by scripts: in the in-process benchmark, array
literals are 51% of array allocation, the bridge 25%, and `split` 14%.
Every sobek array allocates a property map and a name slice just to hold
`length`, and every `for…of` over an array allocates an iterator object
with its own map. Together these are about 16% of allocation in that
benchmark.

## Candidate fixes

- Allocate less in the bridge, mostly wrappers. Each pass wraps values in a
  scope of its own; an earlier count found 77% of new wrappers were for
  values an earlier pass had wrapped.
- In a sobek fork, keep `length` out of the property map, and iterate
  plain arrays in `for…of` without an iterator object.

## Early release

A patched copy of the x/tools checker counts each action's dependents. When
the last one finishes, it drops the action's result unless the action is a
root, and each pass drops its `ResultOf` map once it has run. All 424 linter
test cases pass. Five cold runs each, alternating:

| | Before | Early release | Change |
|---|---|---|---|
| Wall | 4.91 s (4.62–6.11) | 4.54 s (4.47–4.58) | −7.5% |
| CPU | 35.2 s (33.2–37.6) | 33.6 s (33.6–34.5) | −4% |
| Max RSS | 5.65 GB | 3.77 GB | −33% |
| Peak footprint | 5.94 GB | 3.73 GB | −37% |

Early release was faster in every round. In a profiled run, live heap at
the peak fell from 2.74 GB to 1.07 GB, peak heap in use from 6.2 GB to
3.4 GB, and `madvise` from 10.2 s to 5.4 s of CPU. tsk uses the patch from
the `tsk` branch of
[alecthomas/golang-x-tools](https://github.com/alecthomas/golang-x-tools),
through a `replace` in `go.mod`.

## Measuring

- Compare whole runs, not analyzer durations, which vary by up to 2×
  between identical runs.
- Run cold into a fresh cache, alternate between versions, and idle 30 s
  before each run, because the machine slows under sustained load:

  ```sh
  TSK_CACHE=$(mktemp -d) /usr/bin/time -l tsk ./...
  ```

- Prevent sleep with `caffeinate -i`, and keep the lid open. A run that
  spans a sleep shows a huge wall time with normal CPU.
- `BenchmarkAnalysis/Linters` with `-benchmem` gives allocation per run with
  little noise. Its timings drift under sustained load.
- The profiles came from a temporary hook in `main`, not committed, writing
  a CPU profile, an execution trace, a heap profile at each new peak and
  `runtime.MemStats` every 100 ms. Running cores per 100 ms came from the
  trace, read with `golang.org/x/exp/trace`.

## History

Changes kept:

| Change | Effect |
|---|---|
| Fact runs served first by the runtime pool | Cold wall 4.30 s to 3.98 s, by starting exhaustive's dependency chain at once |
| `pass.dependency`, so exhaustive and sumtype only export facts on dependencies | Cold wall 4.60 s to 2.99 s, removing a 1.1 s single-core tail |
| Cache lookup and module listing overlapped with compiling scripts | Cold wall 3.15 s to 2.80 s, warm 0.47 s to 0.31 s |
| testifylint on the shared inspector instead of `ast.inspect` | 760,000 fewer script callbacks, no measurable change to a full run |
| Intermediate results released once their last dependent finishes ([Early release](#early-release)) | Cold wall 4.91 s to 4.54 s, peak memory 5.94 GB to 3.73 GB |

Tried and reverted, each without a measurable gain in wall time:

| Change | Result |
|---|---|
| Bridge fast path for visitor callbacks, skipping `reflect.MakeFunc` | No change |
| One array per slice per pass, with `--freeze-arrays` to catch scripts modifying one | 31% of conversions hit, skipping 64% of element wrapping, yet allocation stayed 12.2–12.5 GB per run and wall and CPU were within variation |
| GOGC=400 by default | CPU −14%, wall unchanged, peak footprint +58% (5.9 to 9.4 GB) |
| Growing the heap by 6 GB at startup, to skip `madvise` for later spans | The scavenger released all 6 GB within 0.7 s, so `madvise` stayed at 10.6 s of CPU |

The array cache needed hits to check that the slice's memory was unchanged:
Go code reuses some slices in place, such as `ast.PreorderStack`'s stack,
which gave lostcancel stale arrays. Splitting revive into a linter per
rule also made no difference to a full run, and was kept.
