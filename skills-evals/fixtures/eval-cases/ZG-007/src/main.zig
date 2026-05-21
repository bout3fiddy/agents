const std = @import("std");

pub const SampleKind = enum {
    temperature,
    pressure,
    vibration,
    voltage,
    humidity,
    current,
};

pub const Sample = struct {
    sensor_id: u32,
    kind: SampleKind,
    tick: u64,
    value: i32,
    quality: u8,
    flags: u16,
    label: [32]u8,
    provenance: [64]u8,
};

pub const Rule = struct {
    kind: SampleKind,
    min_quality: u8,
    limit: i32,
    required_flags: u16,
};

pub const KindStats = struct {
    count: usize = 0,
    alert_count: usize = 0,
    total: i64 = 0,
    min: i32 = 0,
    max: i32 = 0,
};

pub const Alert = struct {
    sensor_id: u32,
    kind: SampleKind,
    tick: u64,
    value: i32,
};

pub const AnalyzeStats = struct {
    accepted: usize = 0,
    rejected: usize = 0,
    alert_count: usize = 0,
};

pub const BatchResult = struct {
    stats: []KindStats,
    alerts: []Alert,
    alert_storage: []Alert,
    allocator: std.mem.Allocator,

    pub fn deinit(self: BatchResult) void {
        self.allocator.free(self.stats);
        self.allocator.free(self.alert_storage);
    }
};

fn filled(comptime len: usize, value: u8) [len]u8 {
    var out: [len]u8 = undefined;
    @memset(out[0..], value);
    return out;
}

fn kindCount() usize {
    return @typeInfo(SampleKind).@"enum".fields.len;
}

fn resetStats(stats: []KindStats) void {
    for (stats) |*entry| entry.* = .{};
}

fn updateStats(stats: []KindStats, sample: Sample, alert: bool) void {
    const index = @intFromEnum(sample.kind);
    var entry = &stats[index];
    if (entry.count == 0) {
        entry.min = sample.value;
        entry.max = sample.value;
    } else {
        entry.min = @min(entry.min, sample.value);
        entry.max = @max(entry.max, sample.value);
    }
    entry.count += 1;
    entry.total += sample.value;
    if (alert) entry.alert_count += 1;
}

pub fn evaluateBatch(
    allocator: std.mem.Allocator,
    rules: []const Rule,
    samples: []const Sample,
) !BatchResult {
    var rule_map = std.AutoHashMap(SampleKind, Rule).init(allocator);
    defer rule_map.deinit();
    try rule_map.ensureTotalCapacity(@intCast(rules.len));
    for (rules) |rule| {
        try rule_map.put(rule.kind, rule);
    }

    const stats = try allocator.alloc(KindStats, kindCount());
    errdefer allocator.free(stats);
    resetStats(stats);

    const alert_storage = try allocator.alloc(Alert, samples.len);
    errdefer allocator.free(alert_storage);

    var alert_count: usize = 0;
    for (samples) |sample| {
        const rule = rule_map.get(sample.kind) orelse continue;
        if (sample.quality < rule.min_quality) continue;
        if ((sample.flags & rule.required_flags) != rule.required_flags) continue;

        const is_alert = sample.value > rule.limit;
        updateStats(stats, sample, is_alert);
        if (is_alert) {
            alert_storage[alert_count] = .{
                .sensor_id = sample.sensor_id,
                .kind = sample.kind,
                .tick = sample.tick,
                .value = sample.value,
            };
            alert_count += 1;
            if ((sample.flags & 0x8000) != 0) {
                const message = try std.fmt.allocPrint(
                    allocator,
                    "sensor {d} {s} value {d}",
                    .{ sample.sensor_id, @tagName(sample.kind), sample.value },
                );
                defer allocator.free(message);
                if (message.len == 0) return error.InvalidDiagnostic;
            }
        }
    }

    return .{
        .stats = stats,
        .alerts = alert_storage[0..alert_count],
        .alert_storage = alert_storage,
        .allocator = allocator,
    };
}

const Fixture = struct {
    rules: []Rule,
    samples: []Sample,

    fn deinit(self: Fixture, allocator: std.mem.Allocator) void {
        allocator.free(self.rules);
        allocator.free(self.samples);
    }
};

fn makeFixture(allocator: std.mem.Allocator, sample_count: usize) !Fixture {
    const rules = try allocator.alloc(Rule, kindCount());
    errdefer allocator.free(rules);
    const default_rules = [_]Rule{
        .{ .kind = .temperature, .min_quality = 4, .limit = 72, .required_flags = 0b0001 },
        .{ .kind = .pressure, .min_quality = 5, .limit = 1010, .required_flags = 0 },
        .{ .kind = .vibration, .min_quality = 5, .limit = 12, .required_flags = 0b0010 },
        .{ .kind = .voltage, .min_quality = 3, .limit = 240, .required_flags = 0 },
        .{ .kind = .humidity, .min_quality = 4, .limit = 65, .required_flags = 0b0100 },
        .{ .kind = .current, .min_quality = 4, .limit = 25, .required_flags = 0 },
    };
    @memcpy(rules, default_rules[0..]);

    const samples = try allocator.alloc(Sample, sample_count);
    errdefer allocator.free(samples);
    for (samples, 0..) |*sample, index| {
        const kind: SampleKind = @enumFromInt(index % kindCount());
        const base: i32 = switch (kind) {
            .temperature => 65,
            .pressure => 990,
            .vibration => 6,
            .voltage => 220,
            .humidity => 55,
            .current => 20,
        };
        sample.* = .{
            .sensor_id = @intCast(index % 4096),
            .kind = kind,
            .tick = @intCast(index),
            .value = base + @as(i32, @intCast(index % 31)),
            .quality = @intCast(1 + (index % 9)),
            .flags = if ((index & 7) == 0) 0x8007 else 0x0007,
            .label = filled(32, 'A' + @as(u8, @intCast(index % 26))),
            .provenance = filled(64, 'a' + @as(u8, @intCast(index % 26))),
        };
    }

    return .{ .rules = rules, .samples = samples };
}

fn bench(allocator: std.mem.Allocator) !void {
    const fixture = try makeFixture(allocator, 180_000);
    defer fixture.deinit(allocator);

    var checksum: i64 = 0;
    const start = std.time.nanoTimestamp();
    for (0..24) |_| {
        const result = try evaluateBatch(allocator, fixture.rules, fixture.samples);
        defer result.deinit();
        for (result.alerts) |alert| checksum += alert.value;
        for (result.stats) |stats| checksum += stats.total + @as(i64, @intCast(stats.alert_count));
    }
    const elapsed_ns = std.time.nanoTimestamp() - start;
    std.debug.print("elapsed_ns={d} checksum={d}\n", .{ elapsed_ns, checksum });
}

pub fn main() !void {
    var debug_allocator = std.heap.DebugAllocator(.{}){};
    defer _ = debug_allocator.deinit();
    const allocator = debug_allocator.allocator();

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    if (args.len > 1 and std.mem.eql(u8, args[1], "--bench")) {
        try bench(allocator);
        return;
    }

    const fixture = try makeFixture(allocator, 32);
    defer fixture.deinit(allocator);
    const result = try evaluateBatch(allocator, fixture.rules, fixture.samples);
    defer result.deinit();
    std.debug.print("alerts={d} first_total={d}\n", .{ result.alerts.len, result.stats[0].total });
}

test "evaluateBatch computes alerts and stats" {
    const allocator = std.testing.allocator;
    var rules = [_]Rule{
        .{ .kind = .temperature, .min_quality = 5, .limit = 25, .required_flags = 0b0001 },
        .{ .kind = .pressure, .min_quality = 4, .limit = 1005, .required_flags = 0 },
    };
    var samples = [_]Sample{
        .{ .sensor_id = 1, .kind = .temperature, .tick = 10, .value = 24, .quality = 8, .flags = 0b0001, .label = filled(32, 'a'), .provenance = filled(64, 'a') },
        .{ .sensor_id = 2, .kind = .temperature, .tick = 11, .value = 27, .quality = 8, .flags = 0b0001, .label = filled(32, 'b'), .provenance = filled(64, 'b') },
        .{ .sensor_id = 3, .kind = .pressure, .tick = 12, .value = 1007, .quality = 5, .flags = 0, .label = filled(32, 'c'), .provenance = filled(64, 'c') },
    };

    const result = try evaluateBatch(allocator, rules[0..], samples[0..]);
    defer result.deinit();

    try std.testing.expectEqual(@as(usize, 2), result.alerts.len);
    try std.testing.expectEqual(@as(usize, 2), result.stats[@intFromEnum(SampleKind.temperature)].count);
    try std.testing.expectEqual(@as(i64, 51), result.stats[@intFromEnum(SampleKind.temperature)].total);
}
