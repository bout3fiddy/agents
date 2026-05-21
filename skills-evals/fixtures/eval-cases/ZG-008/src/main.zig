const std = @import("std");
const route = @import("route.zig");

pub const SegmentKind = route.SegmentKind;
pub const Segment = route.Segment;
pub const Weight = route.Weight;
pub const RouteScore = route.RouteScore;
pub const Fixture = route.Fixture;
pub const makeFixture = route.makeFixture;
pub const scoreSegments = route.scoreSegments;

fn demo(allocator: std.mem.Allocator) !void {
    const fixture = try route.makeFixture(allocator, 16);
    defer fixture.deinit(allocator);
    const score = try route.scoreSegments(allocator, fixture.weights, fixture.segments);
    std.debug.print("accepted={d} rejected={d} total={d}\n", .{ score.accepted, score.rejected, score.total });
}

fn bench(allocator: std.mem.Allocator) !void {
    const fixture = try route.makeFixture(allocator, 64_000);
    defer fixture.deinit(allocator);

    var checksum: u64 = 0;
    const warmup = 3;
    for (0..warmup) |_| {
        const score = try route.scoreSegments(allocator, fixture.weights, fixture.segments);
        checksum +%= score.checksum;
    }

    const iterations = 40;
    const start = std.time.nanoTimestamp();
    for (0..iterations) |_| {
        const score = try route.scoreSegments(allocator, fixture.weights, fixture.segments);
        checksum +%= score.checksum + score.total + score.accepted + score.rejected;
    }
    const elapsed = std.time.nanoTimestamp() - start;
    std.debug.print(
        "bench boundary=scoreSegments segments={d} iterations={d} warmup={d} elapsed_ns={d} checksum={d}\n",
        .{ fixture.segments.len, iterations, warmup, elapsed, checksum },
    );
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
