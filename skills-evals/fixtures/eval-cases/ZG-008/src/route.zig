const std = @import("std");

pub const SegmentKind = enum(u8) {
    local,
    arterial,
    highway,
    ferry,
};

pub const Segment = struct {
    id: u32,
    kind: SegmentKind,
    meters: u32,
    seconds: u32,
    toll_cents: u32,
    flags: u16,
    label: [32]u8,
    provenance: [64]u8,
};

pub const Weight = struct {
    kind: SegmentKind,
    distance_factor: u32,
    time_factor: u32,
    toll_factor: u32,
    required_flags: u16,
    blocked_flags: u16,
};

pub const RouteScore = struct {
    accepted: usize = 0,
    rejected: usize = 0,
    total: u64 = 0,
    checksum: u64 = 0,
};

fn filled(comptime len: usize, value: u8) [len]u8 {
    var out: [len]u8 = undefined;
    @memset(out[0..], value);
    return out;
}

fn segmentCost(segment: Segment, weight: Weight) u64 {
    return @as(u64, segment.meters) * weight.distance_factor +
        @as(u64, segment.seconds) * weight.time_factor +
        @as(u64, segment.toll_cents) * weight.toll_factor;
}

fn accepts(segment: Segment, weight: Weight) bool {
    return (segment.flags & weight.required_flags) == weight.required_flags and
        (segment.flags & weight.blocked_flags) == 0;
}

pub fn scoreSegments(
    allocator: std.mem.Allocator,
    weights: []const Weight,
    segments: []const Segment,
) !RouteScore {
    var by_kind = std.AutoHashMap(SegmentKind, Weight).init(allocator);
    defer by_kind.deinit();
    try by_kind.ensureTotalCapacity(@intCast(weights.len));
    for (weights) |weight| {
        try by_kind.put(weight.kind, weight);
    }

    var score = RouteScore{};
    for (segments) |segment| {
        const weight = by_kind.get(segment.kind) orelse {
            score.rejected += 1;
            continue;
        };
        if (!accepts(segment, weight)) {
            score.rejected += 1;
            continue;
        }

        const cost = segmentCost(segment, weight);
        score.accepted += 1;
        score.total +%= cost;
        score.checksum +%= cost ^ (@as(u64, segment.id) * 131) ^ @intFromEnum(segment.kind);
    }
    return score;
}

pub const Fixture = struct {
    weights: []Weight,
    segments: []Segment,

    pub fn deinit(self: Fixture, allocator: std.mem.Allocator) void {
        allocator.free(self.weights);
        allocator.free(self.segments);
    }
};

pub fn makeFixture(allocator: std.mem.Allocator, count: usize) !Fixture {
    const weights = try allocator.alloc(Weight, 4);
    errdefer allocator.free(weights);
    weights[0..4].* = .{
        .{ .kind = .local, .distance_factor = 2, .time_factor = 5, .toll_factor = 0, .required_flags = 0b0001, .blocked_flags = 0b1000 },
        .{ .kind = .arterial, .distance_factor = 3, .time_factor = 4, .toll_factor = 1, .required_flags = 0, .blocked_flags = 0b0100 },
        .{ .kind = .highway, .distance_factor = 4, .time_factor = 2, .toll_factor = 3, .required_flags = 0b0010, .blocked_flags = 0 },
        .{ .kind = .ferry, .distance_factor = 6, .time_factor = 7, .toll_factor = 4, .required_flags = 0, .blocked_flags = 0b1000 },
    };

    const segments = try allocator.alloc(Segment, count);
    errdefer allocator.free(segments);
    for (segments, 0..) |*segment, index| {
        segment.* = .{
            .id = @intCast(index + 1),
            .kind = @enumFromInt(@as(u2, @intCast(index % 4))),
            .meters = @intCast(80 + ((index * 37) % 1700)),
            .seconds = @intCast(20 + ((index * 23) % 600)),
            .toll_cents = @intCast((index * 11) % 900),
            .flags = @intCast(((index * 5) ^ (index >> 2)) & 0xf),
            .label = filled(32, 'A' + @as(u8, @intCast(index % 26))),
            .provenance = filled(64, 'a' + @as(u8, @intCast(index % 26))),
        };
    }
    return .{ .weights = weights, .segments = segments };
}

test "scoreSegments preserves route scoring semantics" {
    const allocator = std.testing.allocator;
    const weights = [_]Weight{
        .{ .kind = .local, .distance_factor = 2, .time_factor = 5, .toll_factor = 0, .required_flags = 0b0001, .blocked_flags = 0 },
        .{ .kind = .highway, .distance_factor = 4, .time_factor = 2, .toll_factor = 3, .required_flags = 0b0010, .blocked_flags = 0 },
    };
    const segments = [_]Segment{
        .{ .id = 1, .kind = .local, .meters = 100, .seconds = 10, .toll_cents = 0, .flags = 0b0001, .label = filled(32, 'a'), .provenance = filled(64, 'b') },
        .{ .id = 2, .kind = .local, .meters = 100, .seconds = 10, .toll_cents = 0, .flags = 0, .label = filled(32, 'a'), .provenance = filled(64, 'b') },
        .{ .id = 3, .kind = .highway, .meters = 100, .seconds = 20, .toll_cents = 5, .flags = 0b0010, .label = filled(32, 'a'), .provenance = filled(64, 'b') },
        .{ .id = 4, .kind = .ferry, .meters = 100, .seconds = 20, .toll_cents = 5, .flags = 0, .label = filled(32, 'a'), .provenance = filled(64, 'b') },
    };
    const score = try scoreSegments(allocator, weights[0..], segments[0..]);
    try std.testing.expectEqual(@as(usize, 2), score.accepted);
    try std.testing.expectEqual(@as(usize, 2), score.rejected);
    try std.testing.expectEqual(@as(u64, 705), score.total);
}
