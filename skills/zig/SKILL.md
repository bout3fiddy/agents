---
name: zig
description: "Performance-first Zig guidance for systems code: data-oriented design, hot loops, allocation removal, workspace reuse, comptime specialization, correctness validation, and benchmark evidence."
---

# Zig Performance And Data-Oriented Design

## Goal

Write Zig code where performance follows from the shape of the data.

The default posture is performance-first: identify repeated work, make hot loops consume dense and predictable data, remove avoidable allocation, and keep behavior explicit. A speedup only counts when correctness validation and timing evidence prove the same problem is still being solved.

## First Pass

1. Identify the repeated thing: records, rows, columns, tokens, cells, samples, instructions, items, tasks, buffers, or states.
2. Identify the hot loop and list exactly which fields it reads and writes.
3. Separate setup, preparation, steady-state execution, diagnostics, formatting, and final evaluation.
4. Inspect or measure per-item size, allocation count, cache reuse, branch shape, and repeated conversions.
5. Choose the smallest behavior-preserving layout change that removes repeated work or memory traffic.
6. Validate correctness first, then compare timings on the same boundary.

## Quantified Performance Loop

For performance-sensitive Zig work, do not judge code by whether it looks clean. Judge it by the named boundary, correctness gate, allocation behavior, compiler output, and timing evidence.

1. Define the boundary: setup, prepare, one iteration, one kernel, one parser pass, full request, or another named unit.
2. Define correctness: exact output, residual tolerance, invariant, golden file, roundtrip, or domain check.
3. Write the simple correct version with explicit inputs, outputs, ownership, and caller-owned buffers where repeated.
4. Map the hot path from source: what repeats, what mutates, what is invariant, what allocates, and what data is read per item.
5. Build the project's optimized artifact and record the exact command.
6. Get the real compiler command before inspecting generated output, so the inspected artifact is the one being measured.
7. Write large compiler outputs to scratch files, then extract the target symbol or address range before reading.
8. Inspect symbols or compiler output when the claim depends on inlining, call removal, allocation removal, vectorization, branch removal, or layout.
9. Check allocation behavior inside the repeated boundary. A hot kernel should normally have zero allocator traffic.
10. Benchmark the same boundary with the same workload, worker count, warmup, build mode, and correctness checks.
11. Change one thing: layout, allocation, prepared-state reuse, branch removal, SIMD-friendly loop, or fused output.
12. Re-check correctness before reporting speed. Fast wrong code is a different program.

## Verification Commands

Use these as command patterns, not as a substitute for reading the repo's `build.zig`. Replace placeholders and record the exact command used next to the evidence.

Find the build surface:

```sh
zig build --list-steps
zig build <step> -Doptimize=ReleaseFast --summary all
zig build <step> -Doptimize=ReleaseSafe --summary all
```

Use the optimized artifact for performance evidence. In ordinary Zig projects that is usually `-Doptimize=ReleaseFast` through `build.zig`, or `-O ReleaseFast` for direct compiler commands. Use `ReleaseSafe` when optimized validation with runtime safety checks is useful.

Create a scratch output directory and keep large outputs there:

```sh
perf_scratch="${TMPDIR:-/tmp}/zig-perf-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$perf_scratch"
artifact="zig-out/bin/<exe>"
target_symbol="_hotFunction"
```

Get the real compiler command without dumping it into the conversation:

```sh
zig build <step> -Doptimize=ReleaseFast --verbose > "$perf_scratch/build.verbose.txt" 2>&1
sed -n '1,20p' "$perf_scratch/build.verbose.txt"
```

Inspect symbols from a scratch file to find the target boundary and see whether hot helpers became real calls:

```sh
nm -an "$artifact" > "$perf_scratch/symbols.nm"
rg -n 'hotFunction|hotKernel|helperName' "$perf_scratch/symbols.nm"
```

If tiny hot helpers survive unexpectedly, investigate. If only the public or kernel boundary survives, helper splitting is probably not the issue.

Emit assembly for a direct compiler invocation into scratch:

```sh
zig build-exe path/to/main.zig -O ReleaseFast -femit-asm="$perf_scratch/full.s" -fno-emit-bin
wc -l -c "$perf_scratch/full.s"
```

Disassemble a built artifact into scratch when direct assembly emission is not the real build path:

```sh
objdump --disassemble --no-show-raw-insn "$artifact" > "$perf_scratch/full.asm"
# macOS Mach-O alternatives when plain objdump output is not useful:
objdump --macho --disassemble --no-show-raw-insn "$artifact" > "$perf_scratch/full.asm"
otool -tvV "$artifact" > "$perf_scratch/full.asm"
wc -l -c "$perf_scratch/full.asm"
```

Extract the target symbol or range before reading output. Prefer symbol-specific disassembly when the tool supports it:

```sh
objdump --macho --disassemble --dis-symname "$target_symbol" --no-show-raw-insn "$artifact" > "$perf_scratch/hotFunction.asm"
wc -l -c "$perf_scratch/hotFunction.asm"
```

When symbol-specific disassembly is unavailable, locate function starts and cut the smallest useful range:

```sh
rg -n '^_hotFunction:|^_hotKernel:|^_nextFunction:' "$perf_scratch/full.asm"
sed -n '<start>,<end>p' "$perf_scratch/full.asm" > "$perf_scratch/hotFunction.asm"
wc -l -c "$perf_scratch/hotFunction.asm"
```

Run focused checks on the extracted file, not on the whole artifact:

```sh
rg -n 'bl|blr|call|memcpy|memmove|malloc|alloc|free|div|idiv|fdiv|fmla|fmul|fadd' "$perf_scratch/hotFunction.asm"
rg -o '\b(bl|call)\s+[^ ;]+' "$perf_scratch/hotFunction.asm" | sort | uniq -c | sort -nr | head -40
```

Use pass/fail checks for expected absences:

```sh
if rg -n 'SmpAllocator|PageAllocator|GeneralPurposeAllocator|malloc|alloc|free' "$perf_scratch/hotFunction.asm"; then echo "FAIL: allocator traffic in boundary"; else echo "OK: no allocator symbol in boundary"; fi
if rg -n 'memcpy|memmove' "$perf_scratch/hotFunction.asm"; then echo "FAIL: copy call in boundary"; else echo "OK: no copy call in boundary"; fi
if rg -n 'print|format|json|trace|zone' "$perf_scratch/hotFunction.asm"; then echo "FAIL: diagnostics in boundary"; else echo "OK: no diagnostics symbol in boundary"; fi
```

Check allocation behavior with the project's allocator counters, benchmark harness, or a scratch counting allocator around the boundary. Compiler output can show allocator calls; runtime counters tell you whether they execute in the hot loop.

Benchmark with the project's retained benchmark or a scratch harness that times the same boundary:

```sh
zig build <bench-step> -Doptimize=ReleaseFast --summary all
zig build <bench-step> -Doptimize=ReleaseFast -- <bench-args>
```

Do not compare setup-included timing to setup-excluded timing. Do not use timeline-tracing wall time as the final speed number unless tracing overhead is the thing being measured.

## Compiler Output Budget

- Do not paste full `nm`, assembly, disassembly, or broad grep output into the answer unless the user asks for raw output.
- Redirect large outputs to `/tmp` or the repo's ignored scratch area.
- Inspect the smallest useful artifact: one function, one object, one benchmark binary, or one address range.
- Start with symbol lookup and call-target summaries before reading instruction listings.
- Keep reported compiler-output evidence under about 80 lines unless the user asks for more.
- Prefer pass/fail checks for expected absences: no allocator call, no `memcpy`, no tiny helper call, no formatting, no tracing.
- If the extracted output is still large, write a scratch summarizer that reports call counts, suspicious symbols, and the exact file/range inspected.

## Compiler-Output Checks

Compiler output is for targeted questions, not for reading every instruction.

- Did tiny hot helpers inline, or did they survive as calls?
- Did allocator calls, `memcpy`, formatting, file I/O, JSON, or trace calls enter the kernel?
- Did expected branches disappear or move out of the inner loop?
- Are divisions, scattered loads, pointer chasing, or dynamic dispatch still present?
- Are loads and stores mostly contiguous for the actual loop shape?
- Is the output dominated by arithmetic and predictable memory traffic?

If the source-level change claims to remove work, inspect whether that work disappeared from the optimized artifact.

## Performance Claim Contract

A performance claim must name:

- measured boundary;
- correctness gate;
- optimized build command or artifact;
- allocation behavior inside the repeated loop;
- benchmark command and timing boundary;
- before/after numbers when available;
- compiler-output question checked, when relevant;
- remaining risk or unmeasured boundary.

## Core Priorities And Rationale

- Start with data layout because hot code usually waits on memory before it waits on arithmetic. If the loop reads fewer bytes, reads them contiguously, and avoids cold fields, every operation in that loop gets cheaper.
- Remove allocation from hot paths because allocators add bookkeeping, failure edges, cache churn, and sometimes synchronization. Reusing caller-owned buffers makes runtime and ownership predictable.
- Reuse prepared workspaces because setup costs are often independent of the changing input. A workspace makes that reuse explicit, but its key and invalidation must be visible enough to audit.
- Carry typed active sets because repeating the same "is this enabled?" decision inside every loop burns branches and obscures which work is actually required. Masks, lists, and typed indexes let later stages skip work without losing meaning.
- Keep kernels narrow because mixed compute/report/validation functions are hard to profile and hard to optimize without changing behavior. Small compute kernels make the hot path measurable.
- Define timing boundaries because speedups are meaningless if setup, cache warmup, diagnostics, or output work moved outside the measured block. Compare only like with like.
- Keep correctness gates coupled to speed work because many "optimizations" are actually problem changes. The validation should prove the same observable behavior before the timing is trusted.

## Architecture Rules

- Keep public flow simple: input -> prepare -> compute -> output.
- Keep compute modules free of file I/O, CLI wiring, text parsing, display formatting, and hidden global state.
- Put loaders, parsers, config, and FFI translation at input boundaries.
- Put reports, serialization, diagnostics, and validation artifact construction at output or validation boundaries.
- Consume every parsed control, reject it with a typed error, or document it as inert with focused coverage.
- Do not silently drop enabled features, modes, states, unsupported combinations, or requested output fields.
- Do not add broad compatibility shims, framework scaffolding, or string-keyed mutation APIs to make an optimization easier.
- Root files compose artifacts and modules; they should not become the place where performance logic hides.

## Data-Oriented Rules

- Design hot data from the loop's access pattern, not from the shape of input files or UI/API payloads.
- Keep hot fields dense and contiguous; keep cold fields, diagnostics, provenance, labels, and formatting state out of hot structs.
- Prefer struct-of-arrays when loops consume one or a few fields across many items.
- Prefer array-of-structs when loops consume most fields of each item together.
- Split common and rare payloads instead of forcing every item into a maximal tagged union.
- Store sparse or optional data out of band when most items do not use it.
- Decide whether to store or recompute derived values from the consumer loop's total cost, not from a general preference for memoization or lazy computation.
- Use indexes or typed handles instead of pointers when data lives in stable arrays.
- Use distinct index types or small wrappers when raw integers would erase meaning.
- Turn loop-membership booleans into active lists, masks, bitsets, or partitioned arrays when they dominate the loop.
- Use compact masks for selected output/state work, but keep enum-backed accessors for type clarity.
- Keep row/column order and state dimensions tied to typed enums or explicit types, not comments around raw offsets.

## Memoization Vs Lazy Computation

- Do not treat memoization or lazy computation as inherently faster. The real question is which version makes the actual hot loop move less expensive data and do less expensive work.
- Memoize when recompute cost multiplied by reuse count is higher than stored-value load cost plus storage/cache pressure.
- Compute lazily when stored-value load cost plus storage/cache pressure is higher than recompute cost multiplied by reuse count.
- Count input bytes, not just output bytes. Removing a stored value is not a win if recomputing it requires scattered source reads, pointer chasing, extra branches, divisions, function calls, or vectorization barriers.
- Check locality. A larger stored value can be faster when it streams with adjacent hot data; a smaller struct can be slower when it forces distant loads or unpredictable control flow.
- Separate hot and cold paths. Memoize expensive, frequently reused, cache-friendly results. Recompute cheap, rarely used, or bloated derived values. Keep diagnostic, optional, and rare payloads out of every hot item.
- Store compact source data when that lets the hot loop stream predictably.
- Do not optimize memory footprint in isolation. Smaller structs are useful only when the hot loop gets faster, or when memory drops materially while runtime stays acceptably close.
- Benchmark both shapes under the same workload, build mode, worker count, warmup, timing boundary, and correctness checks.

## Allocation And Workspace Rules

- Do not allocate inside repeated numeric, parser, search, scheduling, or rendering loops.
- Make allocation visible in signatures with an explicit allocator.
- Keep non-allocating hot helpers free of fake allocator parameters.
- Give owning workspaces `init`/`deinit` and reuse their buffers across calls.
- Grow buffers by capacity, then return sliced views for the current problem size.
- Replace buffers only after replacement allocation succeeds; do not free the old buffer before a fallible allocation.
- Attach `defer`/`errdefer` immediately after acquisition.
- Avoid temporary return-then-copy shapes in repeated matrix/vector work; write into caller-owned outputs.
- Prefer fixed-size arrays for tiny fixed dimensions when that removes heap traffic without obscuring semantics.
- Use arenas only when many allocations truly share one lifetime; do not use arenas to hide unclear ownership.

## Branch And Work-Skipping Rules

- Test cheap no-contribution cases before expensive setup.
- Carry active masks forward so later stages do not rediscover inactive work.
- Specialize loops by mode/state when a branch is repeated and predictable.
- Request and compute only active output/state columns for the current operation.
- Avoid computing diagnostics, final evaluations, display values, or retained artifacts until they are requested.
- Stop converged tails only when the threshold is a real validation contract, not a tuning shortcut.
- Move rare paths out of common loops when it reduces branches or payload size.
- Use comptime specialization for build-time or type-shape choices; use runtime dispatch only when multiple implementations must coexist at runtime.

## Zig Safety And Boundary Rules

- Every owning type has a clear `deinit`; every allocating constructor has a tested cleanup path.
- Partial initialization must roll back immediately and locally.
- Dynamic boundaries get typed wrappers at the edge: env vars, config, JSON, FFI, protocol payloads, and string-keyed controls.
- Protocol states use enums, tagged unions, packed structs, or explicit structs, not loose strings and raw integers.
- Use `packed struct` only when bit/ABI layout matters; use normal structs for ordinary in-memory state.
- Globals are fenced to C/FFI boundaries, process entrypoints, or true singletons; pure Zig APIs receive state explicitly.
- ABI-relevant enums, packed layouts, and C-facing values must be explicit and tested.
- Comments explain performance pressure, invariants, validation contracts, and tradeoffs; they do not narrate syntax.

## Matrix, Vector, And Kernel Rules

- Write repeated products into final destinations.
- Keep state dimensions explicit.
- Do not carry all possible output columns through a kernel if only a subset is active.
- Separate numerical kernels from validation/report construction.
- Keep batch-stable or request-stable setup in reusable workspaces.
- Separate input construction, preparation/loading, cache warmup, steady-state execution, final evaluation, and diagnostics when timing multi-stage work.

## Measurement Discipline

- State exactly what a timing includes: setup, preparation, cache warmup, steady-state execution, final evaluation, diagnostics, formatting, and artifact writing.
- Benchmark the narrow hot path and the end-to-end path separately.
- Keep benchmark artifacts in the project's retained evidence location when the repo has one.
- Do not compare numbers from different timing boundaries.
- Validate expected outputs, invariants, or domain-specific checks before reporting a speedup.
- Treat threshold changes as correctness contract changes, not performance fixes.
- Prefer explicit benchmark scripts and reproducible commands over hand-edited timing notes.

## Instrumentation And Evidence Rules

- Treat instrumentation as a boundary around the product path, not as a second implementation mode. The measured code should keep the same input -> prepare -> compute -> output shape; trace and benchmark harnesses should drive that path from the outside.
- Compile heavy tracing/profiling dependencies only into explicit trace or benchmark artifacts. Normal library and test builds should use no-op stubs or compile-time-disabled facades so production code does not inherit profiler dependencies.
- Keep one tiny instrumentation facade in hot code. Kernels may emit zones, counters, labels, or thread names, but they should not know about capture files, export formats, profiler options, shell scripts, or report generation.
- Keep instrumentation consumers outside kernels. Capture, export, summaries, hardware-counter wrappers, and report assembly belong in benchmark scripts or tooling, not in compute modules.
- Keep trace labels stable and hierarchical because labels become the shared vocabulary for comparing runs. Renaming labels casually breaks historical comparisons even when the code still works.
- Keep timeline profiling separate from low-overhead elapsed timing. Instrumented profilers explain what time is made of; uninstrumented or low-overhead runs establish how fast the code is.
- Never report profiler-instrumented wall time as product runtime unless instrumentation overhead is explicitly the thing being measured.
- Keep retained validation/benchmark evidence separate from scratch traces and exploratory captures. The former supports claims; the latter supports investigation.
- Delete scaffolding once it stops paying rent. Custom trace tables, counters, diff harnesses, and profile CLIs are useful while they drive decisions; they become architecture debt when optimized code keeps depending on them.
- Do not let instrumentation facades grow into general runtime configuration modules. Scheduling, worker limits, cache policy, and feature behavior belong with the subsystem that owns them.

## Anti-Patterns

- Allocating in hot loops.
- Computing inactive states, output columns, diagnostics, or final evaluations by default.
- Dragging cold fields through hot loops because input structs were reused as compute structs.
- Storing all optional payloads inline when most items do not use them.
- Repeated string-key lookup, parsing, unit conversion, or dynamic dispatch inside steady-state loops.
- Workspace caches with vague keys, hidden invalidation, or cross-request mutation.
- Memoizing rare, diagnostic, or optional data inside every hot item.
- Removing stored derived values while adding scattered source loads, branches, divisions, or function calls.
- Optimizing memory footprint without proving the hot loop is faster or acceptably close.
- Runtime vtables for build-time choices.
- Raw integer state masks without enum-backed accessors.
- Silent truncation or threshold relaxation to get a faster result.
- Performance claims without correctness evidence.
- Benchmark comparisons across different timing boundaries.
- Trace/profiling dependencies imported by normal library builds.
- Instrumented timeline numbers presented as uninstrumented runtime.
- Inspecting Debug compiler output for a performance claim.
- Reading assembly without a specific question.
- Instrumentation facades that become dumping grounds for scheduler or runtime policy.
- Broad compatibility shims that preserve old structure instead of making the hot path direct.

## Review Checklist

- [ ] Is the repeated thing identified?
- [ ] Is the measured boundary named?
- [ ] Is the correctness gate named?
- [ ] Is the hot loop identified, including exact fields read and written?
- [ ] Are setup, preparation, steady-state execution, diagnostics, formatting, and final evaluation separated?
- [ ] Are hot fields dense and cold fields out of the loop?
- [ ] Is the layout SoA, AoS, sparse side storage, or partitioned storage for a concrete reason?
- [ ] Is the memoized/lazy choice based on the consumer loop, reuse count, input bytes, and locality?
- [ ] Does a smaller layout avoid adding scattered reads, branches, divisions, or recomputation?
- [ ] Are active states represented as typed enums, masks, bitsets, or lists?
- [ ] Are allocations outside hot loops?
- [ ] Is workspace reuse explicit and invalidated by typed keys?
- [ ] Are matrix/vector helpers writing into caller-owned outputs where repeated?
- [ ] Are mode branches moved out of inner loops where practical?
- [ ] Are all parsed controls consumed, rejected, or covered as inert?
- [ ] Is file I/O outside compute code?
- [ ] Are ABI and boundary layouts explicit where relevant?
- [ ] Is the optimized build command or artifact recorded?
- [ ] Has compiler output been checked when the claim depends on inlining, call removal, allocation removal, vectorization, branch removal, or layout?
- [ ] Are correctness validation and timing evidence both present?
- [ ] Does the performance claim compare the same boundary before and after?
- [ ] Does normal code compile without heavy tracing/profiling dependencies?
- [ ] Is instrumentation behind one narrow facade?
- [ ] Are timeline profiling numbers kept separate from low-overhead runtime numbers?
- [ ] Are trace labels stable enough to compare across runs?
- [ ] Has obsolete scaffolding been removed after the finding was converted into code, tests, or retained evidence?
- [ ] Does the optimization preserve observable behavior rather than changing the problem?

## Bottom Line

Before editing Zig performance code, make these questions cheap to answer:

- What data repeats?
- Which fields does the hot loop actually touch?
- What allocation, branch, conversion, or cache miss is being removed?
- Which side of the memoization/lazy-computation tradeoff moves less expensive data and does less expensive work?
- What workspace or prepared representation is reused?
- What correctness gate proves the same behavior is preserved?
- What timing boundary proves the speedup?
- What instrumentation boundary prevents the profiler from becoming the architecture?
