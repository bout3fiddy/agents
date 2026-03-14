---
name: zig
description: Zig production code style for systems code — ownership, error paths, comptime, data layout, testing. Use when writing, reviewing, or refactoring Zig code.
---

# Zig Production Code Style

## Goal

Write Zig code that is easy to reason about locally. Every style preference here solves a concrete problem: explicit ownership, immediate rollback, compile-time composition, access-pattern-driven layout, typed boundaries, and intent-preserving comments.

The goal is not "clever Zig." The goal is code that stays understandable under failure, optimization, and maintenance pressure.

## Principles

- **Explicit ownership** — callers see who allocates, who frees, and how long data lives.
- **Immediate rollback** — `defer`/`errdefer` right after acquisition; partial init never leaks.
- **Compile-time composition** — build-time choices resolved at comptime, not runtime vtables.
- **Data layout from access patterns** — container choice matches actual read/write workload.
- **Typed boundaries** — dynamic APIs wrapped in typed facades at the edge.
- **Intent-preserving comments** — explain pressure, invariants, tradeoffs; never narrate syntax.

## Workflow (review order for existing codebases)

1. **Root composition** — `build.zig`, `main.zig`, top-level dispatch.
2. **Ownership boundaries** — where allocators enter, which types own memory, `init`/`deinit` pairs.
3. **Error cleanup discipline** — `defer`/`errdefer` placement in constructors and setup.
4. **Compile-time structure** — `comptime`, `@hasDecl`, backend selection, feature gating.
5. **Hot data paths** — parsers, renderers, protocol handlers, container choices.
6. **Boundary code** — config loaders, FFI shims, environment handling, protocol parsing.
7. **Tests and comments** — invariant explanations, failure path coverage.

## Hard rules

- Root files are composition only — no implementation logic in `build.zig` or `main.zig`.
- Every allocating API takes an explicit `Allocator` parameter; every owning type has `deinit`.
- `defer`/`errdefer` must be attached immediately after acquisition, never deferred to end of function.
- Build-time choices use `comptime` selection, not runtime vtables or function pointers.
- Dynamic boundaries (env vars, config, FFI, protocol payloads) get typed wrappers at the edge.
- Domain types define their own protocol: `init`, `deinit`, `clone`, `equal`, `format` as needed.
- Container choice must match access pattern — don't default to `ArrayList` when `MultiArrayList` fits the hot path.
- No silent truncation to avoid allocation — fall back explicitly to heap when stack buffer overflows.
- Protocol states use enums, tagged unions, or packed structs — not raw integers and loose strings.
- Globals are fenced to C/FFI boundaries only; pure Zig APIs receive state explicitly.
- Tests must cover failure paths, cleanup, ownership semantics, and ABI drift — not just happy paths.
- Don't cargo-cult advanced patterns (`MultiArrayList`, `packed struct`, arenas, heavy `comptime`) without a concrete reason.

## Anti-patterns (reject quickly)

- Root files mixing composition, parsing, runtime selection, and implementation
- Hidden global allocators used from ordinary Zig APIs
- `defer`/`errdefer` installed long after resource acquisition
- Build-time choices as runtime vtables
- String keys and manual casts spread across the codebase
- Advanced containers chosen by habit, not workload
- Silent truncation to preserve stack-only design
- Raw integer protocol tags where enums/unions would work
- Syntax-narrating comments with no design intent
- Happy-path-only tests for code with explicit allocation and cleanup

## Small conventions

- Prefer `const` by default; `var` only when mutation is needed.
- Favor early returns over deep nesting.
- Use `const Self = @This();` in files centered on one type.
- Short aliases for common imports: `const Allocator = std.mem.Allocator;`
- Scoped loggers: `const log = std.log.scoped(.parser);`
- Imports at top of file.
- Use `zig fmt`; don't fight it.

## Review checklist

- [ ] Root files are composition/dispatch only?
- [ ] Signatures reveal whether allocation may happen?
- [ ] Every owning type has a clear `deinit`?
- [ ] Non-allocating APIs are free of fake allocator params?
- [ ] `defer`/`errdefer` attached immediately after acquisition?
- [ ] Partial init failure doesn't leak or leave broken state?
- [ ] Values computed once, not mutated through many branches?
- [ ] Early returns flatten error/optional paths?
- [ ] `comptime` solves a real structural problem?
- [ ] Runtime polymorphism only when multiple impls coexist at runtime?
- [ ] Dynamic APIs wrapped in typed facades?
- [ ] Protocol states are enums/unions/structs, not raw ints/strings?
- [ ] Container choice matches actual access pattern?
- [ ] Hot fields dense, cold fields excluded from hot loops?
- [ ] Globals fenced to process/C boundaries?
- [ ] ABI-relevant enums/layouts explicit and tested?
- [ ] Comments explain *why*, not *what*?
- [ ] Tests cover invalid input, cleanup, ownership, ABI drift?
- [ ] Tests are close to the code they validate?

---

## Detailed rules with examples

### 1) Keep root files boring

Root files are composition boundaries. They answer: which artifacts exist, which module is the entrypoint, which subsystems are selected.

When orchestration and implementation mix, dependency graphs become hard to see and root files become dumping grounds.

#### Good

```zig
// build.zig
const std = @import("std");
const app = @import("build/app.zig");
const tests = @import("build/tests.zig");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    app.addExecutable(b, target, optimize);
    tests.addAll(b, target, optimize);
}
```

```zig
// src/main.zig
const build_config = @import("build_config.zig");

const entrypoint = switch (build_config.exe_kind) {
    .app => @import("main_app.zig"),
    .docs => @import("main_docs.zig"),
    .bench => @import("main_bench.zig"),
};

pub const main = entrypoint.main;
```

#### Bad

```zig
// build.zig — 1000+ lines mixing addExecutable, addBenchmarks, addGeneratedTables, addDocs
// src/main.zig — CLI parsing, backend selection, config loading, test setup, docs generation all inlined
```

### 2) Make ownership and allocation part of the API

Allocation changes lifetime, performance, testability, and cleanup order. If an API allocates, the caller should see it from the signature.

#### Good

```zig
pub const Parser = struct {
    alloc: Allocator,
    buffer: std.ArrayList(u8),

    pub fn init(alloc: Allocator) Parser {
        return .{
            .alloc = alloc,
            .buffer = std.ArrayList(u8).init(alloc),
        };
    }

    pub fn deinit(self: *Parser) void {
        self.buffer.deinit();
        self.* = undefined;
    }
};
```

Non-allocating functions should not accept an allocator:

```zig
pub fn parseInt(text: []const u8) !u32 {
    return std.fmt.parseInt(u32, text, 10);
}
```

#### Bad

```zig
// Hidden global allocator
var gpa = std.heap.GeneralPurposeAllocator(.{}){};
const alloc = gpa.allocator();

pub const Parser = struct {
    buffer: std.ArrayList(u8) = std.ArrayList(u8).init(alloc),
};
```

```zig
// Lying about cost — accepts allocator but never uses it
pub fn parseInt(alloc: std.mem.Allocator, text: []const u8) !u32 {
    _ = alloc;
    return std.fmt.parseInt(u32, text, 10);
}
```

### 3) Pair init with deinit, and register rollback immediately

Every successful acquisition creates a new failure point. If cleanup is delayed, partial-initialization bugs happen.

#### Good

```zig
pub fn loadConfig(alloc: Allocator, path: []const u8) !Config {
    const file = try std.fs.cwd().openFile(path, .{});
    defer file.close();

    const bytes = try file.readToEndAlloc(alloc, 1024 * 1024);
    errdefer alloc.free(bytes);

    var table: std.StringHashMapUnmanaged([]const u8) = .{};
    errdefer table.deinit(alloc);

    try parseIntoTable(alloc, bytes, &table);

    return .{ .bytes = bytes, .table = table };
}
```

#### Bad

```zig
pub fn loadConfig(alloc: Allocator, path: []const u8) !Config {
    const file = try std.fs.cwd().openFile(path, .{});
    const bytes = try file.readToEndAlloc(alloc, 1024 * 1024);
    var table: std.StringHashMapUnmanaged([]const u8) = .{};
    try parseIntoTable(alloc, bytes, &table);

    // cleanup installed too late — any error above leaks resources
    defer file.close();
    defer alloc.free(bytes);
    defer table.deinit(alloc);

    return .{ .bytes = bytes, .table = table };
}
```

### 4) Prefer immutable, expression-oriented setup over staged mutation

Staged mutation increases temporary states. Expression-oriented setup is easier to audit.

#### Good

```zig
const Mode = enum { safe, fast, balanced };

pub fn chooseMode(args: anytype) Mode {
    return blk: {
        if (args.safe) break :blk .safe;
        if (args.fast) break :blk .fast;
        break :blk .balanced;
    };
}
```

#### Bad

```zig
pub fn chooseMode(args: anytype) Mode {
    var mode: Mode = .balanced;
    if (args.safe) mode = .safe;
    if (args.fast) mode = .fast;  // silently overrides safe
    return mode;
}
```

### 5) Use compile-time composition for build-time choices

If a build contains exactly one backend, runtime indirection is solving the wrong problem.

#### Good

```zig
const builtin = @import("builtin");

const Backend = switch (builtin.os.tag) {
    .macos => @import("backend/metal.zig").Backend,
    .linux, .windows => @import("backend/opengl.zig").Backend,
    else => @compileError("unsupported platform"),
};

pub fn initBackend(alloc: std.mem.Allocator) !Backend {
    return try Backend.init(alloc);
}
```

```zig
pub fn draw(surface: *Surface) !void {
    if (comptime build_options.enable_profiler) {
        profiler.beginZone("draw");
        defer profiler.endZone();
    }
    try surface.render();
}
```

#### Bad

```zig
pub const BackendVTable = struct {
    init: *const fn (std.mem.Allocator) anyerror!*anyopaque,
    draw: *const fn (*anyopaque, *Surface) anyerror!void,
    deinit: *const fn (*anyopaque, std.mem.Allocator) void,
};
```

Use runtime polymorphism only when multiple implementations must coexist at runtime.

### 6) Recover static type safety around dynamic boundaries

Dynamic shape (env vars, config, JSON, FFI) should not leak inward.

#### Good

```zig
pub const Key = enum {
    timeout_ms,
    title,

    pub fn Type(comptime key: Key) type {
        return switch (key) {
            .timeout_ms => u32,
            .title => []const u8,
        };
    }
};

pub fn get(comptime key: Key, raw: *RawSettings, alloc: Allocator) !Key.Type(key) {
    return switch (key) {
        .timeout_ms => try raw.getU32("timeout-ms"),
        .title => try raw.getOwnedString(alloc, "title"),
    };
}
```

#### Bad

```zig
pub fn get(raw: *RawSettings, key: []const u8) ![]const u8 {
    return try raw.lookup(key);
}
// Parsing rules, allocation policy, and key spelling scattered across call sites
```

### 7) Give domain types a small protocol of their own

Value types need operations repeatedly: `deinit`, `clone`, `equal`, `parse`, `format`. Define them on the type to avoid scattered inconsistent implementations.

#### Good

```zig
pub const Rule = struct {
    pattern: []const u8,
    replacement: []const u8,

    pub fn clone(self: Rule, alloc: Allocator) !Rule {
        return .{
            .pattern = try alloc.dupe(u8, self.pattern),
            .replacement = try alloc.dupe(u8, self.replacement),
        };
    }

    pub fn deinit(self: *Rule, alloc: Allocator) void {
        alloc.free(self.pattern);
        alloc.free(self.replacement);
        self.* = undefined;
    }

    pub fn equal(a: Rule, b: Rule) bool {
        return std.mem.eql(u8, a.pattern, b.pattern) and
            std.mem.eql(u8, a.replacement, b.replacement);
    }

    pub fn format(
        self: Rule,
        comptime fmt: []const u8,
        opts: std.fmt.FormatOptions,
        writer: anytype,
    ) !void {
        _ = fmt;
        _ = opts;
        try writer.print("{s} => {s}", .{ self.pattern, self.replacement });
    }
};
```

#### Bad

```zig
pub const Rule = struct {
    pattern: []const u8,
    replacement: []const u8,
};
// clone, equal, free scattered across separate files
```

### 8) Choose containers from access patterns, not habit

Container choice controls cache locality, mutation cost, allocator ownership, and reset cost.

**Useful defaults:**

- `std.ArrayList(T)` — append and iterate whole records
- `std.MultiArrayList(T)` — hot loops touch only a few fields
- `*Unmanaged` containers — allocator ownership belongs to caller
- Arenas — many allocations die together
- Fixed buffers — common case is small and bounded

#### Good — MultiArrayList for hot field access

```zig
pub fn integrate(
    particles: *std.MultiArrayList(Particle),
    dt: f32,
) void {
    const x = particles.items(.x);
    const y = particles.items(.y);
    const vx = particles.items(.vx);
    const vy = particles.items(.vy);

    for (x, y, vx, vy) |*px, *py, pvx, pvy| {
        px.* += pvx * dt;
        py.* += pvy * dt;
    }
}
```

#### Good — Unmanaged for caller-controlled allocation

```zig
pub const Table = struct {
    entries: std.StringHashMapUnmanaged(Value) = .{},

    pub fn deinit(self: *Table, alloc: std.mem.Allocator) void {
        self.entries.deinit(alloc);
        self.* = undefined;
    }
};
```

#### Bad — ArrayList dragging cold fields through hot loop

```zig
pub fn integrate(particles: *std.ArrayList(Particle), dt: f32) void {
    for (particles.items) |*p| {
        p.x += p.vx * dt;  // every iteration drags color, label_offset through cache
        p.y += p.vy * dt;
    }
}
```

### 9) Separate the common fast path from the rare slow path

Many operations have a small common case and a large rare case.

#### Good

```zig
pub fn formatMessage(alloc: Allocator, name: []const u8, id: u64) ![]u8 {
    var stack_buf: [128]u8 = undefined;
    var fbs = std.io.fixedBufferStream(&stack_buf);

    std.fmt.format(fbs.writer(), "{s}:{d}", .{ name, id }) catch {
        return try std.fmt.allocPrint(alloc, "{s}:{d}", .{ name, id });
    };

    return try alloc.dupe(u8, fbs.getWritten());
}
```

#### Bad

```zig
// Always allocates, even for tiny output
pub fn formatMessage(alloc: Allocator, name: []const u8, id: u64) ![]u8 {
    return try std.fmt.allocPrint(alloc, "{s}:{d}", .{ name, id });
}
```

```zig
// Silently drops correctness to avoid allocation
pub fn formatMessage(name: []const u8, id: u64) []const u8 {
    var stack_buf: [32]u8 = undefined;
    return std.fmt.bufPrint(&stack_buf, "{s}:{d}", .{ name, id }) catch "";
}
```

### 10) Model protocols and flags directly in the type system

Typed enums, tagged unions, and explicit small structs make state machines visible.

#### Good

```zig
pub const Command = union(enum) {
    ping,
    set_title: []const u8,
    move_cursor: struct { row: u16, col: u16 },
};

pub const Modifiers = packed struct(u8) {
    shift: bool = false,
    alt: bool = false,
    ctrl: bool = false,
    super: bool = false,
    _reserved: u4 = 0,
};
```

#### Bad

```zig
pub const Command = struct {
    kind: u8,
    a: usize,
    b: usize,
    payload: []const u8,
};

pub const Modifiers = u8;
```

Use `packed struct` only when bit/ABI layout matters. Normal structs for ordinary in-memory state.

### 11) Fence globals to the boundary, and make FFI loud

Global state should only exist at C boundaries, process entrypoints, or library singletons.

#### Good

```zig
pub const Library = struct {
    alloc: Allocator,
    cache: Cache,

    pub fn init(alloc: Allocator) !Library {
        return .{
            .alloc = alloc,
            .cache = try Cache.init(alloc),
        };
    }

    pub fn deinit(self: *Library) void {
        self.cache.deinit(self.alloc);
        self.* = undefined;
    }
};

var c_api_state: ?Library = null;

export fn mylib_init() c_int {
    c_api_state = Library.init(std.heap.c_allocator) catch return -1;
    return 0;
}
```

Test ABI values explicitly:

```zig
test "C ABI values stay stable" {
    try std.testing.expectEqual(@as(c_int, 0), @intFromEnum(CStatus.ok));
    try std.testing.expectEqual(@as(c_int, 1), @intFromEnum(CStatus.bad_input));
}
```

#### Bad

```zig
var g_alloc = std.heap.page_allocator;
var g_cache: Cache = .{};

pub fn parseFile(path: []const u8) !Result {
    // implicitly depends on globals — untestable with alternate allocator
}
```

### 12) Comments should explain pressure, invariants, and tradeoffs

#### Good

```zig
// Use MultiArrayList here because frame updates touch position and velocity
// far more often than color or label metadata.
var particles = std.MultiArrayList(Particle){};
```

```zig
// This global is only for the C entrypoint. Internal Zig APIs must receive
// allocators and state explicitly so tests can create isolated instances.
var c_api_state: ?Library = null;
```

#### Bad

```zig
// Create a MultiArrayList for particles.
var particles = std.MultiArrayList(Particle){};

// Check if the pointer is null.
if (ptr == null) return error.Missing;
```

### 13) Tests should verify invariants and failure paths

#### Good

```zig
test "unknown command is rejected" {
    try std.testing.expectError(error.UnknownCommand, parseCommand("wat"));
}

test "clone makes an independent copy" {
    var rule = Rule{
        .pattern = try std.testing.allocator.dupe(u8, "a"),
        .replacement = try std.testing.allocator.dupe(u8, "b"),
    };
    defer rule.deinit(std.testing.allocator);

    var copy = try rule.clone(std.testing.allocator);
    defer copy.deinit(std.testing.allocator);

    copy.pattern[0] = 'z';

    try std.testing.expect(rule.pattern[0] == 'a');
    try std.testing.expect(copy.pattern[0] == 'z');
}

test "init rolls back cleanly on allocation failure" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{
        .fail_index = 1,
    });
    const alloc = failing.allocator();

    try std.testing.expectError(error.OutOfMemory, Widget.init(alloc));
    try std.testing.expect(failing.deinit() == .ok);
}
```

#### Bad

```zig
test "widget init works" {
    _ = try Widget.init(std.testing.allocator);
    // no deinit, no assertions, no failure coverage
}
```

### 14) Do not cargo-cult advanced patterns

`MultiArrayList`, `packed struct`, arenas, generated modules, heavy `comptime` — use only when solving a real problem.

#### Good — simple structure for simple needs

```zig
pub const Config = struct {
    items: std.ArrayList(Item),

    pub fn init(alloc: std.mem.Allocator) Config {
        return .{ .items = std.ArrayList(Item).init(alloc) };
    }

    pub fn deinit(self: *Config) void {
        self.items.deinit();
        self.* = undefined;
    }
};
```

#### Bad — unnecessary complexity for a config object

```zig
pub const Config = struct {
    arena: std.heap.ArenaAllocator,
    items: std.MultiArrayList(Item),
    flags: packed struct(u32) {
        loaded: bool = false,
        dirty: bool = false,
        _reserved: u30 = 0,
    },
};
```

Optimization patterns are tools, not identity markers.

## Bottom line

Code should make these questions cheap to answer locally:

- Who owns this memory?
- What gets cleaned up on failure?
- Is this choice build-time or runtime?
- Why is this container or representation being used?
- What invariant is this comment preserving?
- Which tests prove the dangerous paths are correct?
