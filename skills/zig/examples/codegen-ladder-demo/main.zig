const std = @import("std");

pub const Field = enum {
    temperature,
    pressure,
    vibration,
    voltage,
};

pub const Record = struct {
    id: u32,
    temperature: f64,
    pressure: f64,
    vibration: f64,
    voltage: f64,
    flags: u32,
};

pub const Rule = struct {
    field: Field,
    min: f64,
    max: f64,
    scale: f64 = 1.0,
    offset: f64 = 0.0,
    required_flags: u32 = 0,
};

pub const MatchStats = struct {
    matched: usize = 0,
    rejected: usize = 0,
    id_checksum: u64 = 0,
};

pub noinline fn evaluateRulesInto(rules: []const Rule, records: []const Record, out: []u8) !MatchStats {
    if (out.len < records.len) return error.OutputTooSmall;

    var stats = MatchStats{};
    for (records, 0..) |record, i| {
        var accepted = true;
        for (rules) |rule| {
            if ((record.flags & rule.required_flags) != rule.required_flags) {
                accepted = false;
                break;
            }

            const raw = switch (rule.field) {
                .temperature => record.temperature,
                .pressure => record.pressure,
                .vibration => record.vibration,
                .voltage => record.voltage,
            };
            const value = raw * rule.scale + rule.offset;
            if (value < rule.min or value > rule.max) {
                accepted = false;
                break;
            }
        }

        if (accepted) {
            out[i] = 1;
            stats.matched += 1;
            stats.id_checksum +%= record.id;
        } else {
            out[i] = 0;
            stats.rejected += 1;
        }
    }
    return stats;
}

fn fillRecords(records: []Record) void {
    for (records, 0..) |*record, i| {
        const bucket: f64 = @floatFromInt(i % 100);
        record.* = .{
            .id = @intCast(i + 1),
            .temperature = 270.0 + bucket * 0.2,
            .pressure = 880.0 + @as(f64, @floatFromInt(i % 60)) * 1.5,
            .vibration = @as(f64, @floatFromInt((i * 17) % 37)) * 0.01,
            .voltage = 11.8 + @as(f64, @floatFromInt(i % 25)) * 0.02,
            .flags = if ((i & 3) == 0) 0b11 else 0b01,
        };
    }
}

fn runBench() !void {
    const allocator = std.heap.page_allocator;
    const record_count = 200_000;
    const iterations = 16;

    const records = try allocator.alloc(Record, record_count);
    defer allocator.free(records);
    const out = try allocator.alloc(u8, record_count);
    defer allocator.free(out);

    fillRecords(records);
    const rules = [_]Rule{
        .{ .field = .temperature, .min = 274.0, .max = 288.0, .required_flags = 0b01 },
        .{ .field = .pressure, .min = 905.0, .max = 960.0 },
        .{ .field = .voltage, .min = 11.9, .max = 12.4 },
    };

    _ = try evaluateRulesInto(rules[0..], records, out);

    var timer = try std.time.Timer.start();
    var checksum: u64 = 0;
    for (0..iterations) |_| {
        const stats = try evaluateRulesInto(rules[0..], records, out);
        checksum +%= stats.id_checksum;
        checksum +%= stats.matched;
    }
    const elapsed_ns = timer.read();

    std.debug.print(
        "bench boundary=evaluateRulesInto records={} iterations={} elapsed_ns={} checksum={}\n",
        .{ record_count, iterations, elapsed_ns, checksum },
    );
}

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    if (args.len > 1 and std.mem.eql(u8, args[1], "--bench")) {
        try runBench();
        return;
    }

    var records = [_]Record{
        .{ .id = 1, .temperature = 276.0, .pressure = 925.0, .vibration = 0.2, .voltage = 12.0, .flags = 0b01 },
        .{ .id = 2, .temperature = 292.0, .pressure = 920.0, .vibration = 0.2, .voltage = 12.0, .flags = 0b01 },
        .{ .id = 3, .temperature = 280.0, .pressure = 970.0, .vibration = 0.2, .voltage = 12.0, .flags = 0b01 },
    };
    var out: [records.len]u8 = undefined;
    const rules = [_]Rule{
        .{ .field = .temperature, .min = 274.0, .max = 288.0, .required_flags = 0b01 },
        .{ .field = .pressure, .min = 905.0, .max = 960.0 },
    };
    const stats = try evaluateRulesInto(rules[0..], records[0..], out[0..]);

    std.debug.print(
        "demo boundary=evaluateRulesInto matched={} rejected={} checksum={} marks={any}\n",
        .{ stats.matched, stats.rejected, stats.id_checksum, out },
    );
}

test "evaluateRulesInto writes caller-owned output and stats" {
    var records = [_]Record{
        .{ .id = 10, .temperature = 276.0, .pressure = 925.0, .vibration = 0.2, .voltage = 12.0, .flags = 0b01 },
        .{ .id = 20, .temperature = 291.0, .pressure = 930.0, .vibration = 0.2, .voltage = 12.0, .flags = 0b01 },
        .{ .id = 30, .temperature = 280.0, .pressure = 970.0, .vibration = 0.2, .voltage = 12.0, .flags = 0b01 },
    };
    const rules = [_]Rule{
        .{ .field = .temperature, .min = 274.0, .max = 288.0, .required_flags = 0b01 },
        .{ .field = .pressure, .min = 905.0, .max = 960.0 },
    };
    var out: [records.len]u8 = undefined;

    const stats = try evaluateRulesInto(rules[0..], records[0..], out[0..]);

    try std.testing.expectEqual(@as(usize, 1), stats.matched);
    try std.testing.expectEqual(@as(usize, 2), stats.rejected);
    try std.testing.expectEqual(@as(u64, 10), stats.id_checksum);
    try std.testing.expectEqualSlices(u8, &.{ 1, 0, 0 }, out[0..]);
}

test "evaluateRulesInto checks output capacity" {
    const records = [_]Record{
        .{ .id = 1, .temperature = 276.0, .pressure = 925.0, .vibration = 0.2, .voltage = 12.0, .flags = 0b01 },
    };
    var out: [0]u8 = .{};

    try std.testing.expectError(error.OutputTooSmall, evaluateRulesInto(&.{}, records[0..], out[0..]));
}
