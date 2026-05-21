const std = @import("std");

pub const PacketClass = enum {
    normal,
    boosted,
    damped,
};

pub const Packet = struct {
    id: u32,
    active: bool,
    class: PacketClass,
    gain: f32,
    bias: f32,
    quality: f32,
    samples: []const f32,
    calibration: []const f32,
    weights: ?[]const f32,

    label: [64]u8,
    provenance: [128]u8,
    debug_flags: u32,
};

pub const PacketScore = struct {
    id: u32,
    score: f32,
    clipped: bool,
};

fn filled(comptime len: usize, value: u8) [len]u8 {
    var out: [len]u8 = undefined;
    @memset(out[0..], value);
    return out;
}

pub fn calibrationMean(calibration: []const f32) f32 {
    if (calibration.len == 0) return 1.0;
    var sum: f32 = 0;
    for (calibration) |value| {
        sum += value;
    }
    return sum / @as(f32, @floatFromInt(calibration.len));
}

pub fn scorePacket(
    allocator: std.mem.Allocator,
    packet: *const Packet,
    threshold: f32,
) !PacketScore {
    var scratch = try allocator.alloc(f32, packet.samples.len);
    defer allocator.free(scratch);

    for (packet.samples, 0..) |sample, index| {
        const calibration_bias = calibrationMean(packet.calibration);
        const class_scale: f32 = switch (packet.class) {
            .normal => 1.0,
            .boosted => 1.15,
            .damped => 0.85,
        };
        const weight = if (packet.weights) |weights| weights[index] else 1.0;
        scratch[index] = (sample * weight * packet.gain * class_scale + packet.bias) - calibration_bias;
    }

    var energy: f32 = 0;
    for (scratch) |value| {
        energy += value * value;
    }
    const adjusted_energy = energy * packet.quality;

    if ((packet.debug_flags & 1) != 0) {
        const message = try std.fmt.allocPrint(
            allocator,
            "packet {d} score {d:.3}",
            .{ packet.id, adjusted_energy },
        );
        defer allocator.free(message);
        if (message.len == 0) return error.InvalidScore;
    }

    return .{
        .id = packet.id,
        .score = adjusted_energy,
        .clipped = adjusted_energy > threshold,
    };
}

pub fn processBatch(
    allocator: std.mem.Allocator,
    packets: []const Packet,
    threshold: f32,
) ![]PacketScore {
    var active_count: usize = 0;
    for (packets) |packet| {
        if (packet.active) active_count += 1;
    }

    const scores = try allocator.alloc(PacketScore, active_count);
    errdefer allocator.free(scores);

    var out_index: usize = 0;
    for (packets) |*packet| {
        if (!packet.active) continue;
        scores[out_index] = try scorePacket(allocator, packet, threshold);
        out_index += 1;
    }

    return scores;
}

const Fixture = struct {
    packets: []Packet,
    samples: []f32,
    calibrations: []f32,
    weights: []f32,

    fn deinit(self: Fixture, allocator: std.mem.Allocator) void {
        allocator.free(self.packets);
        allocator.free(self.samples);
        allocator.free(self.calibrations);
        allocator.free(self.weights);
    }
};

fn makeFixture(
    allocator: std.mem.Allocator,
    packet_count: usize,
    samples_per_packet: usize,
    calibration_count: usize,
) !Fixture {
    const packets = try allocator.alloc(Packet, packet_count);
    errdefer allocator.free(packets);
    const samples = try allocator.alloc(f32, packet_count * samples_per_packet);
    errdefer allocator.free(samples);
    const calibrations = try allocator.alloc(f32, packet_count * calibration_count);
    errdefer allocator.free(calibrations);
    const weights = try allocator.alloc(f32, packet_count * samples_per_packet);
    errdefer allocator.free(weights);

    for (samples, 0..) |*sample, index| {
        const wave = @as(f32, @floatFromInt(index % 97)) * 0.03125;
        sample.* = wave + @as(f32, @floatFromInt(index % 5)) * 0.2;
    }
    for (calibrations, 0..) |*calibration, index| {
        calibration.* = 0.75 + @as(f32, @floatFromInt(index % 23)) * 0.015625;
    }
    for (weights, 0..) |*weight, index| {
        weight.* = 0.9 + @as(f32, @floatFromInt(index % 17)) * 0.01;
    }

    for (packets, 0..) |*packet, index| {
        const sample_start = index * samples_per_packet;
        const calibration_start = index * calibration_count;
        packet.* = .{
            .id = @intCast(index),
            .active = (index % 7) != 0,
            .class = switch (index % 3) {
                0 => .normal,
                1 => .boosted,
                else => .damped,
            },
            .gain = 0.85 + @as(f32, @floatFromInt(index % 11)) * 0.025,
            .bias = @as(f32, @floatFromInt(index % 13)) * 0.01,
            .quality = 0.95 + @as(f32, @floatFromInt(index % 9)) * 0.01,
            .samples = samples[sample_start .. sample_start + samples_per_packet],
            .calibration = calibrations[calibration_start .. calibration_start + calibration_count],
            .weights = if ((index % 4) == 0) weights[sample_start .. sample_start + samples_per_packet] else null,
            .label = filled(64, 'A' + @as(u8, @intCast(index % 26))),
            .provenance = filled(128, 'a' + @as(u8, @intCast(index % 26))),
            .debug_flags = if ((index % 64) == 0) 1 else 0,
        };
    }

    return .{
        .packets = packets,
        .samples = samples,
        .calibrations = calibrations,
        .weights = weights,
    };
}

fn smoke(allocator: std.mem.Allocator) !void {
    const fixture = try makeFixture(allocator, 16, 12, 4);
    defer fixture.deinit(allocator);
    const scores = try processBatch(allocator, fixture.packets, 4.0);
    defer allocator.free(scores);
    std.debug.print("scores={d} first={d:.3}\n", .{ scores.len, scores[0].score });
}

fn bench(allocator: std.mem.Allocator) !void {
    const fixture = try makeFixture(allocator, 4096, 96, 16);
    defer fixture.deinit(allocator);

    var checksum: f64 = 0;
    const start = std.time.nanoTimestamp();
    for (0..60) |_| {
        const scores = try processBatch(allocator, fixture.packets, 65.0);
        for (scores) |score| checksum += score.score;
        allocator.free(scores);
    }
    const elapsed = std.time.nanoTimestamp() - start;
    std.debug.print("elapsed_ns={d} checksum={d:.3}\n", .{ elapsed, checksum });
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
        try smoke(allocator);
    }
}

test "processBatch scores only active packets" {
    const allocator = std.testing.allocator;
    var samples_a = [_]f32{ 1.0, 2.0, 3.0, 4.0 };
    var samples_b = [_]f32{ 5.0, 6.0, 7.0, 8.0 };
    var calibration = [_]f32{ 1.0, 1.0 };
    var packets = [_]Packet{
        .{
            .id = 10,
            .active = true,
            .class = .normal,
            .gain = 1.0,
            .bias = 0.0,
            .quality = 1.0,
            .samples = samples_a[0..],
            .calibration = calibration[0..],
            .weights = null,
            .label = filled(64, 'x'),
            .provenance = filled(128, 'y'),
            .debug_flags = 0,
        },
        .{
            .id = 11,
            .active = false,
            .class = .normal,
            .gain = 1.0,
            .bias = 0.0,
            .quality = 1.0,
            .samples = samples_b[0..],
            .calibration = calibration[0..],
            .weights = null,
            .label = filled(64, 'z'),
            .provenance = filled(128, 'w'),
            .debug_flags = 0,
        },
    };

    const scores = try processBatch(allocator, packets[0..], 10.0);
    defer allocator.free(scores);
    try std.testing.expectEqual(@as(usize, 1), scores.len);
    try std.testing.expectEqual(@as(u32, 10), scores[0].id);
}
