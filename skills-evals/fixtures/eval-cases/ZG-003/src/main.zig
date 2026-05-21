const std = @import("std");

pub const ReadingKind = enum(u8) {
    temperature,
    pressure,
    vibration,
    voltage,
};

pub const KindSummary = struct {
    count: u32 = 0,
    total: i64 = 0,
    min: i32 = 0,
    max: i32 = 0,
};

pub const SensorSummary = struct {
    sensor_id: u16,
    count: u32,
    total_abs: u64,
    latest_tick: u32,
};

pub const Summary = struct {
    by_kind: [@typeInfo(ReadingKind).@"enum".fields.len]KindSummary,
    top_sensors: []SensorSummary,

    pub fn deinit(self: Summary, allocator: std.mem.Allocator) void {
        allocator.free(self.top_sensors);
    }
};

pub const frame_size = 8;

pub fn decodeAndSummarize(
    allocator: std.mem.Allocator,
    bytes: []const u8,
    top_sensor_count: usize,
) !Summary {
    _ = allocator;
    _ = bytes;
    _ = top_sensor_count;
    return error.NotImplemented;
}

fn writeFrame(out: []u8, sensor_id: u16, kind: ReadingKind, value: i16, tick: u16) void {
    const value_bits: u16 = @bitCast(value);
    out[0] = @truncate(sensor_id);
    out[1] = @truncate(sensor_id >> 8);
    out[2] = @intFromEnum(kind);
    out[3] = 0;
    out[4] = @truncate(value_bits);
    out[5] = @truncate(value_bits >> 8);
    out[6] = @truncate(tick);
    out[7] = @truncate(tick >> 8);
}

fn sampleFrames() [frame_size * 7]u8 {
    var bytes: [frame_size * 7]u8 = undefined;
    writeFrame(bytes[0..8], 7, .temperature, 21, 10);
    writeFrame(bytes[8..16], 9, .pressure, 30, 11);
    writeFrame(bytes[16..24], 7, .temperature, 24, 12);
    writeFrame(bytes[24..32], 4, .vibration, -6, 13);
    writeFrame(bytes[32..40], 9, .pressure, 35, 14);
    writeFrame(bytes[40..48], 4, .voltage, 11, 15);
    writeFrame(bytes[48..56], 7, .vibration, -8, 16);
    return bytes;
}

fn makeBenchFrames(allocator: std.mem.Allocator, count: usize) ![]u8 {
    const bytes = try allocator.alloc(u8, count * frame_size);
    for (0..count) |index| {
        const sensor_id: u16 = @intCast((index * 31) % 2048);
        const kind: ReadingKind = @enumFromInt(index % @typeInfo(ReadingKind).@"enum".fields.len);
        const raw_value: i32 = @as(i32, @intCast((index * 17) % 4000)) - 2000;
        writeFrame(
            bytes[index * frame_size ..][0..frame_size],
            sensor_id,
            kind,
            @intCast(raw_value),
            @intCast(index % 65535),
        );
    }
    return bytes;
}

fn demo(allocator: std.mem.Allocator) !void {
    var bytes = sampleFrames();
    const summary = try decodeAndSummarize(allocator, bytes[0..], 3);
    defer summary.deinit(allocator);
    std.debug.print(
        "temperature={d} top={d}\n",
        .{ summary.by_kind[@intFromEnum(ReadingKind.temperature)].count, summary.top_sensors.len },
    );
}

fn bench(allocator: std.mem.Allocator) !void {
    const bytes = try makeBenchFrames(allocator, 120_000);
    defer allocator.free(bytes);

    var checksum: u64 = 0;
    const start = std.time.nanoTimestamp();
    for (0..30) |_| {
        const summary = try decodeAndSummarize(allocator, bytes, 24);
        defer summary.deinit(allocator);
        for (summary.by_kind) |kind| {
            checksum +%= @as(u64, @intCast(kind.count)) + @as(u64, @intCast(@abs(kind.total)));
        }
        for (summary.top_sensors) |sensor| {
            checksum +%= sensor.total_abs +
                @as(u64, @intCast(sensor.count)) +
                @as(u64, @intCast(sensor.latest_tick));
        }
    }
    const elapsed = std.time.nanoTimestamp() - start;
    std.debug.print("elapsed_ns={d} checksum={d}\n", .{ elapsed, checksum });
}

pub fn main() !void {
    var debug_allocator = std.heap.DebugAllocator(.{}){};
    defer _ = debug_allocator.deinit();
    const allocator = debug_allocator.allocator();

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    if (args.len > 1 and std.mem.eql(u8, args[1], "--bench")) {
        try bench(allocator);
    } else {
        try demo(allocator);
    }
}

test "decodeAndSummarize groups frame values by kind and ranks sensors" {
    const allocator = std.testing.allocator;
    var bytes = sampleFrames();
    const summary = try decodeAndSummarize(allocator, bytes[0..], 2);
    defer summary.deinit(allocator);

    try std.testing.expectEqual(@as(u32, 2), summary.by_kind[@intFromEnum(ReadingKind.temperature)].count);
    try std.testing.expectEqual(@as(i64, 45), summary.by_kind[@intFromEnum(ReadingKind.temperature)].total);
    try std.testing.expectEqual(@as(u32, 2), summary.by_kind[@intFromEnum(ReadingKind.pressure)].count);
    try std.testing.expectEqual(@as(usize, 2), summary.top_sensors.len);
    try std.testing.expectEqual(@as(u16, 9), summary.top_sensors[0].sensor_id);
    try std.testing.expectEqual(@as(u16, 7), summary.top_sensors[1].sensor_id);
}

test "decodeAndSummarize rejects partial frames" {
    const allocator = std.testing.allocator;
    var bytes = sampleFrames();
    try std.testing.expectError(error.InvalidFrameLength, decodeAndSummarize(allocator, bytes[0 .. bytes.len - 1], 2));
}
