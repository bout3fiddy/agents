# Compiler Evidence

Use compiler evidence to test a source-level performance claim. Ask one concrete question, emit the smallest useful artifact, and keep large output in scratch space.

Start by creating a scratch output directory:

```sh
perf_scratch="${TMPDIR:-/tmp}/zig-perf-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$perf_scratch"
```

## JSON Codegen Ladder

When the Zig skill is available, prefer the bundled JSON harness for the default evidence ladder. It keeps raw compiler output in scratch files and gives the agent structured fields to inspect with `jq`.

Treat the ladder as a CLI contract. Use `codegen-ladder.sh`, `--json-out`, and `jq` queries during ordinary optimization work. Open `scripts/codegen_ladder/*.py` only when changing the tool itself.

Single-file mode:

```sh
skills/zig/scripts/codegen-ladder.sh \
  --source src/main.zig \
  --symbol hotFunction \
  --run-arg --bench \
  --emit-ir \
  --json-out "$perf_scratch/codegen.json" > "$perf_scratch/codegen.stdout.json"
```

Build-system mode:

```sh
skills/zig/scripts/codegen-ladder.sh \
  --build-root . \
  --test-step test \
  --bench-step bench \
  --build-step default \
  --artifact zig-out/bin/app \
  --symbol hotFunction \
  --json-out "$perf_scratch/codegen.json" > "$perf_scratch/codegen.stdout.json"
```

Useful queries:

```sh
jq '.decision_card' "$perf_scratch/codegen.json"
jq -r '.runtime.benchmark.parsed.elapsed_ns' "$perf_scratch/codegen.json"
jq -r '.hot_boundary' "$perf_scratch/codegen.json"
jq -r '.checks[] | select(.status == "review") | [.key, .count] | @tsv' "$perf_scratch/codegen.json"
jq -r '.next_checks.suggestions[]? | [.id, .severity, .confidence] | @tsv' "$perf_scratch/codegen.json"
jq -r '.source_map.entries[]? | [.address, (.frames | join(" <- "))] | @tsv' "$perf_scratch/codegen.json"
```

The decision card is the first-pass routing layer. It summarizes benchmark signal, hot-boundary state, hazards, recommended actions, and the reporting rule for the current evidence. Use it to choose between source edits, symbol/boundary repair, matched benchmark reruns, source-level alternatives, and ceiling reports.

`next_checks` is a rule-based checklist for choosing the next investigation step. Each suggestion includes `triggered_by` evidence and a `tool_call` object with `jq` queries back into the same report. The categories live in `scripts/codegen_ladder/next_checks.py` so tool maintainers can audit or extend the rules without reading the rest of the implementation.

Some `next_checks` are source-level probes. They catch patterns such as bounded fast paths with fallback scans or bitset candidate loops, then ask for a rival source-shape comparison. Treat those as design prompts: compiler evidence can show that the current shape compiles cleanly, while same-boundary timing and workload coverage decide whether a direct table, prepared indexes, active list, or uniform fallback-free path is better.

For small project fixes, finish after one useful low-level check once correctness and same-boundary timing are good. Prefer a focused symbol, emitted assembly, codegen-ladder decision card, allocation counter, or no-allocation test over a broad optimized `--verbose` compiler command listing. If symbol-specific extraction is awkward, keep the verbose listing as build provenance and report symbol-level disassembly or allocation evidence as a follow-up. Deeper compiler browsing is most valuable when timing is still bad, an allocator/copy/call fingerprint remains, or the user asked for assembly-level proof.

For before/after comparisons, save both reports and run:

```sh
skills/zig/scripts/codegen-ladder.sh diff \
  --before "$perf_scratch/before.json" \
  --after "$perf_scratch/after.json" \
  --json-out "$perf_scratch/diff.json"
```

Read the comparability block first:

```sh
jq '.decision_card' "$perf_scratch/diff.json"
jq -r '.comparability.status, .comparability.timing_claim' "$perf_scratch/diff.json"
jq -r '.comparability.mismatches[]? | [.field, .before, .after] | @tsv' "$perf_scratch/diff.json"
jq -r '.checks | to_entries[] | select(.value.delta != 0) | [.key, .value.before, .value.after, .value.delta] | @tsv' "$perf_scratch/diff.json"
jq -r '.calls.summary | to_entries[] | select(.value.delta != 0) | [.key, .value.before, .value.after, .value.delta] | @tsv' "$perf_scratch/diff.json"
```

When `comparability.timing_claim` is `needs_matched_boundary`, use check and call deltas as exploration signals. Use timing deltas for speed claims after rerunning on a matched symbol, build, compiler, workload, checksum, and benchmark boundary. A different source path by itself is provenance; the measured boundary and benchmark fields decide whether timing can support a speed claim.

## Build Truth

Use this when you need the actual build step, flags, target, CPU features, or artifact being measured.

```sh
zig --help
zig build --list-steps
zig build <step> -Doptimize=ReleaseFast --summary all
zig build <step> -Doptimize=ReleaseFast --verbose > "$perf_scratch/build.verbose.txt" 2>&1
zig env
zig targets
zig build-exe --help
```

`zig build --verbose` belongs to the build system. Direct compile commands such as `zig build-exe` use command-specific `--help` and `-femit-*` flags for compiler artifacts in Zig 0.15.

For direct commands, use the optimized mode explicitly:

```sh
zig build-exe src/main.zig -OReleaseFast -fno-emit-bin
zig test src/main.zig -OReleaseFast
```

Use `ReleaseFast` for speed claims. Use `ReleaseSafe` when optimized validation with safety checks is more useful than final speed.

Confirm target assumptions when CPU features or builtin configuration matter:

```sh
zig build-exe src/main.zig -OReleaseFast --show-builtin > "$perf_scratch/builtin.zig"
zig build-exe src/main.zig -OReleaseFast --verbose-llvm-cpu-features > "$perf_scratch/cpu-features.txt" 2>&1
```

## Compiler IR

Use IR when the question is whether work disappeared before machine code or whether LLVM received the shape you expected.

```sh
zig build-exe src/main.zig -OReleaseFast -femit-llvm-ir="$perf_scratch/optimized.ll" -fno-emit-bin
zig build-exe src/main.zig -OReleaseFast --verbose-llvm-ir="$perf_scratch/unoptimized.ll" -fno-emit-bin
zig build-exe src/main.zig -OReleaseFast -femit-llvm-bc="$perf_scratch/optimized.bc" -fno-emit-bin
```

Use `--verbose-air` for Zig compiler lowering questions:

```sh
zig build-exe src/main.zig -OReleaseFast --verbose-air -fno-emit-bin > "$perf_scratch/air.txt" 2>&1
```

Use `-fopt-bisect-limit=N` when isolating an LLVM optimization-pass effect. Treat it as a compiler investigation tool.

Compiler diagnostics such as `--verbose-air`, `-fstack-report`, and `-fopt-bisect-limit` can legitimately produce little or no useful output for a given program. Keep them as escalation tools; for routine performance proof, prefer optimized IR, focused assembly, symbols, allocation counters, and same-boundary timing.

## Symbols And Assembly

Use symbols first. They tell you whether helpers, allocators, hash maps, sort routines, or formatting paths survived as real calls.

```sh
nm -an "$artifact" > "$perf_scratch/symbols.nm"
rg -n 'hotFunction|hotKernel|helperName|alloc|hash|sort|memcpy|panic|format' "$perf_scratch/symbols.nm"
```

When available, sort symbols by size to find unexpected code growth:

```sh
llvm-nm -S --size-sort "$artifact" > "$perf_scratch/symbols-size.nm"
tail -40 "$perf_scratch/symbols-size.nm"
```

Emit assembly directly for direct compiler invocations:

```sh
zig build-exe src/main.zig -OReleaseFast -femit-asm="$perf_scratch/full.s" -fno-emit-bin
```

For standalone direct-build tasks, first find the symbol and then inspect that symbol's body. Whole-file greps often report setup, benchmark, formatting, and allocator code that sits outside the hot boundary:

```sh
zig build-exe src/main.zig -OReleaseFast -femit-bin="$perf_scratch/hot"
nm -an "$perf_scratch/hot" | grep -Ei 'hotFunction|decodeAndSummarize|classify|process'
objdump --disassemble --no-show-raw-insn "$perf_scratch/hot" > "$perf_scratch/full.asm"
awk '/<main.hotFunction>:/,/^$/' "$perf_scratch/full.asm" > "$perf_scratch/hot.asm"
grep -nE 'bl|blr|call|alloc|HashMap|memcpy|panic|fdiv|idiv' "$perf_scratch/hot.asm" || true
```

Adjust the symbol pattern to the actual public entrypoint. If the target symbol was inlined or folded away, say that and inspect the caller that owns the measured loop.

If you only have a whole-artifact grep, label it as setup-inclusive evidence. Do not use allocator, formatting, or diagnostic hits from benchmark/demo setup as proof that the measured hot function still contains those calls.

Disassemble a built artifact when the real build path matters more than direct assembly emission:

```sh
objdump --disassemble --no-show-raw-insn "$artifact" > "$perf_scratch/full.asm"
objdump --macho --disassemble --no-show-raw-insn "$artifact" > "$perf_scratch/full.asm"
otool -tvV "$artifact" > "$perf_scratch/full.asm"
```

Prefer symbol-specific disassembly:

```sh
objdump --macho --disassemble --dis-symname "$target_symbol" --no-show-raw-insn "$artifact" > "$perf_scratch/hot.asm"
xcrun llvm-objdump --macho --disassemble-symbols="$target_symbol" --no-show-raw-insn "$artifact" > "$perf_scratch/hot.asm"
```

Use source and line interleaving when debug info is available:

```sh
xcrun llvm-objdump --macho --source --line-numbers --disassemble-symbols="$target_symbol" "$artifact" > "$perf_scratch/hot-source.asm"
```

On macOS, `/usr/bin/objdump --macho --disassemble --dis-symname` is often the cleanest symbol-specific view. `xcrun llvm-objdump --source --line-numbers` is useful for source interleaving, but check that it filtered to the symbol you asked for; some builds may include neighboring symbols in the output.

When the linked executable lacks the helper symbol you need, check whether the function inlined, folded, or stayed unexported. Use emitted assembly for pre-link inspection, or build a temporary dynamic library/object with exported functions for focused symbol analysis:

```sh
zig build-lib src/main.zig -OReleaseFast -dynamic -femit-bin="$perf_scratch/libhot.dylib"
nm -an "$perf_scratch/libhot.dylib" | rg 'targetFunction|helperName'
objdump --macho --disassemble --dis-symname _targetFunction --no-show-raw-insn "$perf_scratch/libhot.dylib" > "$perf_scratch/target.asm"
```

Run focused checks on the extracted hot artifact:

```sh
rg -n 'bl|blr|call|memcpy|memmove|malloc|alloc|free|hash|sort|div|idiv|fdiv|fmla|fmul|fadd' "$perf_scratch/hot.asm"
rg -o '\b(bl|call)\s+[^ ;]+' "$perf_scratch/hot.asm" | sort | uniq -c | sort -nr | head -40
```

Use `grep -nE` when `rg` is unavailable in a restricted environment.

Use pass/fail checks for expected absences:

```sh
if rg -n 'SmpAllocator|PageAllocator|GeneralPurposeAllocator|malloc|alloc|free' "$perf_scratch/hot.asm"; then echo "FAIL: allocator traffic in boundary"; else echo "OK: no allocator symbol in boundary"; fi
if rg -n 'memcpy|memmove' "$perf_scratch/hot.asm"; then echo "FAIL: copy call in boundary"; else echo "OK: no copy call in boundary"; fi
if rg -n 'print|format|json|trace|zone' "$perf_scratch/hot.asm"; then echo "FAIL: diagnostics in boundary"; else echo "OK: no diagnostics symbol in boundary"; fi
```

## Address To Source

Use address-to-source mapping when a profiler, allocation trace, crash, or sample names an address instead of a source line.

On macOS:

```sh
atos -inlineFrames -o "$artifact" -arch "$(uname -m)" "$address"
atos -inlineFrames --fullPath -o "$artifact" -arch "$(uname -m)" "$address"
xcrun dwarfdump --lookup "$address" "$artifact"
```

If the address is an offset rather than a loaded address, pass `--offset` to `atos`:

```sh
atos -inlineFrames --offset -o "$artifact" -arch "$(uname -m)" "$offset"
```

Prefer `atos -inlineFrames` for quick allocation/profiler address attribution on macOS. `dwarfdump --lookup` can be useful, but it may be less direct depending on whether you have a loaded address, an offset, and usable debug info.

## CPU Hotspots

Use CPU tools when optimized timing is bad and source inspection leaves the cause unclear.

On macOS, start with a quick sample for long enough runs:

```sh
sample <pid> 10 1 -fullPaths -mayDie -file "$perf_scratch/sample.txt"
```

Use Instruments Time Profiler through `xctrace` for deeper macOS investigation when full Xcode tooling is available. Command Line Tools-only installs may expose an `xctrace` stub that requires Xcode selection. Keep profiler traces separate from low-overhead runtime numbers. If the program finishes too quickly, increase iterations so sampling catches the hot source lines.

On Linux:

```sh
perf stat -- <command>
perf record -g -- <command>
perf report
perf annotate
```

Use `llvm-mca` on a small extracted loop when the question is throughput, latency, port/resource pressure, or whether the loop is arithmetic-bound:

```sh
llvm-mca -mcpu=<cpu> "$perf_scratch/hot-loop.s" > "$perf_scratch/mca.txt"
```

## Code Size

Use size tools when generic instantiations, helper splitting, debug paths, or feature flags may bloat the artifact.

```sh
size "$artifact"
objdump --section-headers "$artifact" > "$perf_scratch/sections.txt"
bloaty "$artifact" -d symbols,compileunits
```

On Mach-O, `size` can be confusing for executables because non-text segments may dominate or display platform-specific values. Use section headers, symbol sizes, or `bloaty` when available before drawing a code-size conclusion.

Consider `-ffunction-sections`, `-fdata-sections`, `--gc-sections`, and platform dead-strip options only after confirming they fit the repo's build and release goals.

## Output Discipline

- Keep compiler output in `/tmp` or an ignored scratch directory.
- Extract one symbol, function, object, address range, or loop before reading.
- Report the command, artifact, target symbol, and exact question checked.
- Prefer pass/fail checks for expected absences: no allocator call, no `memcpy`, no tiny helper call, no formatting, no tracing.
- Present performance compiler evidence from optimized artifacts.
