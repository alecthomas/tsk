# Lint performance

tsk is about twice as slow as golangci-lint on a cold run of this repository
with the same 59 linters enabled. Warm runs, served from the result cache,
take the same time.

| | Cold | Warm |
|---|---|---|
| golangci-lint v2.14.0 | 2.0–2.2 s | 0.47 s |
| tsk | 4.6–4.8 s | 0.47 s |

## Where a cold run goes

| Phase | Time |
|---|---|
| Compile and load scripts | 0.27 s |
| Cache lookup | 0.17 s |
| Load packages | 0.96 s |
| Analysis | about 3.2 s |

Summed analyzer durations come to 17.9 s across all cores. They are wall
time per run, so they include waiting for a CPU and garbage collection.

| Analyzer | Time | Share |
|---|---|---|
| dupl | 3.4 s | 19% |
| exhaustive | 3.2 s | 18% |
| unparam | 1.6 s | 9% |
| wastedassign | 1.6 s | 9% |
| testifylint | 1.2 s | 6.5% |
| protogetter | 1.1 s | 6% |

Every other analyzer is under 3.5%.

## Findings

- exhaustive declares `scope: "all"` to collect enum facts from
  dependencies, so it runs on 324 dependency packages as well as the
  module's 31. Most of that time goes to the TypeScript-Go shim's large
  packages, such as `checker` (0.42 s) and `ast` (0.42 s). On a dependency
  only its facts are used, but it also checks every switch.
- dupl's cost grows with package size. Its worst package is `internal/vm`
  (0.63 s).
- `internal/vm` is the slowest package for 38 of the 61 script analyzers.
  Run alone, testifylint, dupl and protogetter each take 0.2–0.26 s on it.
  In a full run they take 2.5–3 times longer because of contention. Why the
  package is expensive is not yet known.

## Measuring

Run a cold lint with debug logging into a fresh cache, then total the
`Analyzer finished` durations by analyzer or package:

```sh
TSK_CACHE=$(mktemp -d) tsk --log-level=debug ./... 2> debug.log
```

## Iterations

Per-analyzer durations vary by up to 2× between identical cold runs, so
compare wall and CPU time of whole runs, repeated, instead.

### 1. exhaustive on dependencies

Run alone, exhaustive takes 2.6–3.3 s wall and 9–10 s CPU. godot, which
runs only on the module, takes 1.07 s wall and 2.3 s CPU.

- Loading packages takes 1.11 s instead of 0.55 s, because analyzers with
  `scope: "all"` need syntax and types for every dependency.
- Analysis takes about 1.5 s more.
- Checking switches is 88% of exhaustive's own time. Collecting enum facts
  is the rest. On a dependency, the facts are all that is used, because its
  findings are discarded.

sumtype is the only other `scope: "all"` analyzer. It reads `//sumtype`
comments on declarations, so it also needs dependency syntax.

Options:

- Tell analyzers whether a package is a dependency, so exhaustive collects
  only facts there. This keeps upstream's behaviour and saves most of the
  analysis time, but not the loading.
- Derive dependency enums from type information and drop `scope: "all"`.
  This saves loading too, but only when sumtype is also disabled. It would
  ignore `//exhaustive:ignore` on declarations in dependencies.

### 2. CPU profile

Profiles came from a temporary `pprof` hook in `main`, which is not
committed.

dupl alone spends almost nothing in the bridge: wrapping and arrays got one
10 ms sample. Its script time goes to closures, array methods, iterators,
and object literals in the interpreter. Garbage collection and heap growth
cost more than the script itself.

A full cold run has 19.6 s of CPU samples:

| Bucket | Time | Share |
|---|---|---|
| Heap growth (`madvise`) | 6.1 s | 31% |
| Script execution | 6.2 s | 32% |
| …of which calls into Go | 2.6 s | 13% |
| GC marking | 3.9 s | 20% |
| Type-checking | 0.75 s | 4% |

`madvise` is the runtime taking memory back from the OS as the heap grows,
which is expensive on macOS. With GC, allocation drives about half of all
CPU. The run allocates 8.5 GB:

| Source | Allocated |
|---|---|
| sobek arrays, including bridge-built ones | 1.5 GB |
| sobek property writes, mostly array setup | 1.4 GB |
| `ast.inspect` with a script callback, used by 27 linters | 1.0 GB |
| `go/types` recording types | 0.5 GB |
| Bridge wrapper cache | 0.5 GB |
| wastedassign's own SSA programs | 0.5 GB |

- `ast.inspect` wraps every node and calls into the script for each one.
  The inspector's filtered traversal selects nodes in Go and is cheaper.
- wastedassign builds a naive-form SSA program per package, creating an SSA
  package for every transitive import each time.

GOGC=400 cuts CPU by about 23% (22.5 s to 17 s) but wall time only by
about 7% (4.3 s to 3.95 s).

### 3. ast.inspect callbacks

Baseline: median 4.25 s wall and 22.2 s CPU over five cold runs.

- A bridge fast path for visitor callbacks, which skipped
  `reflect.MakeFunc`, made no measurable difference (4.31 s, 22.4 s). It
  was reverted. Reflection is not where callback time goes.
- Scripts receive 2.34 million callbacks per cold run. One walk of the
  whole module is about 130,000. testifylint made 34% of them, about six
  walks, because its port reimplemented upstream's inspector calls
  (`Preorder`, `Nodes`, `WithStack`) on `ast.inspect`. They now use the
  shared inspector, which filters in Go. Its findings on upstream's
  generated testdata are unchanged: 5,182 across 25 checkers.
- That removed 760,000 callbacks but changed the full run by nothing
  measurable (4.30 s, 22.2 s). Run alone, testifylint's CPU fell from about
  2.65 s to 2.2 s. Callbacks cost about 0.5 µs each, so the remaining 1.58
  million are worth about 0.8 s of CPU, or 4%. Converting the other
  linters is not worth it for speed.

The run averages about 5 of the machine's 10 cores (22 s of CPU in 4.3 s),
so wall time is bounded by something serialised, not by total CPU. The
next step is a timeline of a cold run to find it.

### 4. Timeline

A timeline came from timestamped debug logs (a temporary change to the
logger), counting runs in progress per 100 ms.

- Startup is serial: 0.26 s compiling scripts, 0.15 s looking up cached
  findings, then 0.8 s loading packages. Analysis starts about 1.3 s in.
- Analysis took 2.84 s. All ten cores were busy for the first 1.5 s. One
  was busy for the remaining 1.35 s.
- That tail was exhaustive working along the TypeScript shim's dependency
  chain, from `ast` through `checker` to `ls`, then tsk's own packages.
  Each run waits for its dependencies' facts, so the chain is serial.
- The chain started late. exhaustive's runs on low-level dependencies, such
  as `unicode`, waited about 1 s for a runtime, because the pool woke
  waiting runs in arrival order. Nothing waits on most of those runs, such
  as any analyzer on a module package.

The pool now serves runs of analyzers with facts first.

| | Wall | CPU |
|---|---|---|
| Before | 4.30 s | 22.2 s |
| Fact runs first | 3.98 s | 21.5 s |

Analysis now takes 2.68 s, and the chain starts at once. But exhaustive's
run on `ast` takes 0.98 s while all cores are busy, against 0.41 s alone.
The chain itself is now the bound: about 1.1 s of single-core tail.
Shortening it means cheaper exhaustive runs on dependencies, such as
skipping switch checks whose findings are discarded (see iteration 1).

### 5. Facts only on dependencies

Scripts now see `pass.dependency`, set for a package outside the modules
being linted, where findings are discarded. exhaustive and sumtype export
their facts there and skip their checks.

From this iteration on, the machine slows under sustained load: back-to-back
runs after the first take up to twice as long. Comparisons alternate between
versions and idle 30 s before each run.

| | Wall | CPU |
|---|---|---|
| Before | 4.60 s | 22.7 s |
| Facts only on dependencies | 2.99 s | 19.2 s |

Analysis takes 1.65 s instead of 2.68 s, with all ten cores busy to the
end; the single-core tail is gone. Startup is still serial: 0.26 s
compiling scripts, 0.14 s looking up cached findings, and 0.77 s loading
packages, about 40% of the run. Analysis is CPU-bound again, so the
allocation costs from iteration 2 matter once more.

exhaustive's findings on the TypeScript module (833) are the same before
and after, apart from the order of names within some groups of
same-valued members. That order varies between identical runs of either
version: like upstream, exhaustive orders members by `token.Pos`, and file
positions depend on the order in which files are parsed.

### 6. Parallel startup

Startup ran one step after another, measured from process start:

| Time | Step |
|---|---|
| 0–0.03 s | Process start, `go env GOROOT`, config |
| 0.03–0.40 s | Compiling and evaluating scripts |
| 0.40–0.42 s | `go list -m` for the main modules |
| 0.42–0.61 s | Looking up cached findings: `go env -json`, a metadata `go list`, hashing files |
| 0.61–1.48 s | Loading packages with syntax |

Only the full load needs the scripts, to know whether any analyzer needs
facts. The cache lookup needed them only for the fingerprint in each key.
Keys are now a package's content key, computed without the scripts, hashed
with the fingerprint.

- Listing the main modules overlaps compiling the scripts.
- The cache lookup starts before the project loads, so its `go` commands
  and hashing overlap compiling the scripts too.

The lookup finishes 15 ms after the scripts instead of 0.2 s after them,
and the first analyzer run starts at 1.15 s instead of 1.48 s.

Starting the full load alongside the lookup, and cancelling it when every
package hit, was tried first. It hid the lookup on cold runs but made warm
runs 70 ms slower, so it was dropped.

| | Cold wall | Cold CPU | Warm wall |
|---|---|---|---|
| Before | 3.15 s | 18.0 s | 0.47 s |
| Parallel startup | 2.80 s | 17.5 s | 0.31 s |

Cold runs alternate between binaries and idle 30 s before each. The full
load, about 0.84 s, is now the only startup step on the critical path.

