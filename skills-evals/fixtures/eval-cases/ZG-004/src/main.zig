const std = @import("std");

pub const GrayImage = struct {
    width: usize,
    height: usize,
    pixels: []const u8,
};

pub const MaskStats = struct {
    active_count: usize = 0,
    weighted_sum: u64 = 0,
    min_x: usize = 0,
    min_y: usize = 0,
    max_x: usize = 0,
    max_y: usize = 0,
};

pub fn classifyCrossBlurInto(
    image: GrayImage,
    threshold: u16,
    mask: []u8,
) !MaskStats {
    _ = image;
    _ = threshold;
    _ = mask;
    return error.NotImplemented;
}

fn sampleImage() [16]u8 {
    return .{
        0, 0,  0, 0,
        0, 10, 0, 0,
        0, 0,  0, 0,
        0, 0,  0, 0,
    };
}

fn makeBenchImage(allocator: std.mem.Allocator, width: usize, height: usize) ![]u8 {
    const pixels = try allocator.alloc(u8, width * height);
    for (pixels, 0..) |*pixel, index| {
        const x = index % width;
        const y = index / width;
        pixel.* = @intCast(((x * 13) + (y * 17) + ((x ^ y) * 3)) % 256);
    }
    return pixels;
}

fn demo() !void {
    var pixels = sampleImage();
    var mask: [16]u8 = undefined;
    const stats = try classifyCrossBlurInto(.{ .width = 4, .height = 4, .pixels = pixels[0..] }, 20, mask[0..]);
    std.debug.print("active={d} bounds=({d},{d})-({d},{d})\n", .{ stats.active_count, stats.min_x, stats.min_y, stats.max_x, stats.max_y });
}

fn bench(allocator: std.mem.Allocator) !void {
    const width = 384;
    const height = 256;
    const pixels = try makeBenchImage(allocator, width, height);
    defer allocator.free(pixels);
    const mask = try allocator.alloc(u8, width * height);
    defer allocator.free(mask);
    const image: GrayImage = .{ .width = width, .height = height, .pixels = pixels };

    var checksum: u64 = 0;
    const start = std.time.nanoTimestamp();
    for (0..120) |_| {
        const stats = try classifyCrossBlurInto(image, 520, mask);
        checksum +%= @as(u64, @intCast(stats.active_count)) +
            stats.weighted_sum +
            @as(u64, @intCast(stats.min_x)) +
            @as(u64, @intCast(stats.max_x)) +
            @as(u64, @intCast(stats.min_y)) +
            @as(u64, @intCast(stats.max_y));
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
        try demo();
    }
}

test "classifyCrossBlurInto marks only cells above cross-weighted threshold" {
    var pixels = sampleImage();
    var mask: [16]u8 = undefined;
    const stats = try classifyCrossBlurInto(.{ .width = 4, .height = 4, .pixels = pixels[0..] }, 20, mask[0..]);

    try std.testing.expectEqual(@as(usize, 1), stats.active_count);
    try std.testing.expectEqual(@as(u8, 1), mask[5]);
    try std.testing.expectEqual(@as(u8, 0), mask[1]);
    try std.testing.expectEqual(@as(usize, 1), stats.min_x);
    try std.testing.expectEqual(@as(usize, 1), stats.min_y);
    try std.testing.expectEqual(@as(usize, 1), stats.max_x);
    try std.testing.expectEqual(@as(usize, 1), stats.max_y);
}

test "classifyCrossBlurInto validates buffer shape" {
    var pixels = sampleImage();
    var short_mask: [15]u8 = undefined;
    try std.testing.expectError(
        error.OutputTooSmall,
        classifyCrossBlurInto(.{ .width = 4, .height = 4, .pixels = pixels[0..] }, 20, short_mask[0..]),
    );
}
