# Allocation Evidence

Allocation evidence answers whether allocator traffic remains inside the repeated boundary. Code inspection is useful, but runtime counters and compiler-output checks are stronger.

## Boundaries

Classify allocation before changing code:

- setup allocation: often acceptable;
- workspace allocation: acceptable when reused and visible;
- per-request allocation: acceptable only if it is outside the hot loop and measured honestly;
- per-item or per-iteration allocation: usually a performance bug;
- diagnostics/report allocation: keep outside compute boundaries.

Claim "no allocation" only for the measured boundary, with setup handled consistently across versions.

## Counting Allocator Test

Use a counting allocator around the target boundary when the code accepts an allocator or workspace.

This sketch matches the allocator vtable shape used by Zig 0.15.2:

```zig
const std = @import("std");

const CountingAllocator = struct {
    backing: std.mem.Allocator,
    allocs: usize = 0,
    frees: usize = 0,
    bytes: usize = 0,

    fn allocator(self: *CountingAllocator) std.mem.Allocator {
        return .{
            .ptr = self,
            .vtable = &.{
                .alloc = alloc,
                .resize = resize,
                .remap = remap,
                .free = free,
            },
        };
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ret_addr: usize) ?[*]u8 {
        const self: *CountingAllocator = @ptrCast(@alignCast(ctx));
        self.allocs += 1;
        self.bytes += len;
        return self.backing.rawAlloc(len, alignment, ret_addr);
    }

    fn resize(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ret_addr: usize) bool {
        const self: *CountingAllocator = @ptrCast(@alignCast(ctx));
        if (new_len > memory.len) self.bytes += new_len - memory.len;
        return self.backing.rawResize(memory, alignment, new_len, ret_addr);
    }

    fn remap(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ret_addr: usize) ?[*]u8 {
        const self: *CountingAllocator = @ptrCast(@alignCast(ctx));
        if (new_len > memory.len) self.bytes += new_len - memory.len;
        return self.backing.rawRemap(memory, alignment, new_len, ret_addr);
    }

    fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ret_addr: usize) void {
        const self: *CountingAllocator = @ptrCast(@alignCast(ctx));
        self.frees += 1;
        self.backing.rawFree(memory, alignment, ret_addr);
    }
};
```

Adapt this to the Zig version and allocator API in the repo. Keep it in tests or scratch unless the project has an established instrumentation helper.

## No-Allocation Unit Test

A useful test warms setup first, resets counters, runs the hot boundary, and asserts no allocation:

```zig
var counting = CountingAllocator{ .backing = std.testing.allocator };
const allocator = counting.allocator();

var workspace = try Workspace.init(allocator, input.len);
defer workspace.deinit();

try prepare(&workspace, input);
counting.allocs = 0;
counting.frees = 0;
counting.bytes = 0;

try runHotBoundary(&workspace, input, out);
try std.testing.expectEqual(@as(usize, 0), counting.allocs);
try std.testing.expectEqual(@as(usize, 0), counting.bytes);
```

If the target API lacks an allocator parameter, use compiler-output checks or a higher-level benchmark harness that reports allocation counts.

Reset counters only after setup and warmup. A test that wraps the whole request proves whole-request allocation; separate setup to prove steady-state kernel allocation behavior.

For caller-owned-output APIs with no allocator parameter, make that shape part of the proof. The source-level hypothesis is: the hot entrypoint has no allocator handle, writes into supplied storage, and keeps setup allocation in the demo or workspace. Pair that with a function-scoped assembly or symbol check so allocator calls from benchmark setup are separated from the measured boundary.

## Symbol And Assembly Checks

Use compiler output to check whether allocator paths remain callable from the hot symbol.

```sh
zig build <step> -Doptimize=ReleaseFast --verbose > "$perf_scratch/build.verbose.txt" 2>&1
nm -an "$artifact" > "$perf_scratch/symbols.nm"
rg -n 'alloc|Allocator|malloc|free|hash_map|ensureTotalCapacity|growIfNeeded' "$perf_scratch/symbols.nm"
```

For symbol-specific assembly:

```sh
objdump --macho --disassemble --dis-symname "$target_symbol" --no-show-raw-insn "$artifact" > "$perf_scratch/hot.asm"
rg -n 'alloc|free|malloc|hash_map|ensureTotalCapacity|growIfNeeded|memcpy|memmove' "$perf_scratch/hot.asm"
```

Treat this as evidence about compiled call structure. Runtime counters still tell you whether the allocation executes for the measured input.

When a symbol-specific check finds allocator calls in the hot symbol, inspect whether they are on the normal path, an error path, or a cold capacity-growth path. The best hot boundaries usually have none of these reachable in steady state, but setup functions and workspace growth functions may still allocate legitimately.

## When A Dynamic Container Is The Wrong Shape

If allocation attribution lands in a grow path, hash-map capacity check, sort allocation, temporary buffer, or formatting helper, continue beyond pre-reserving and ask:

- Is the data actually dynamic at this boundary?
- Can the dynamic lookup become enum-indexed or id-indexed dense storage?
- Can unique work be prepared once and referenced by compact indexes?
- Can full sorting become bounded top-k?
- Can caller-owned output or workspace storage replace return-then-copy shapes?

Pre-sizing may remove the loudest allocation but leave the wrong data model in the hot loop.
