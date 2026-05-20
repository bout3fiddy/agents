const std = @import("std");

pub const EventKind = enum(u8) {
    view,
    click,
    purchase,
    fault,
    heartbeat,
    timeout,
};

pub const Event = struct {
    user_id: u32,
    kind: EventKind,
    value: f64,
    timestamp_ms: i64,
    source: []const u8,
    campaign: []const u8,
};

pub const KindSummary = struct {
    count: u64 = 0,
    total: f64 = 0,
    min: f64 = 0,
    max: f64 = 0,
    latest_timestamp_ms: i64 = 0,
};

pub const UserSummary = struct {
    user_id: u32,
    count: u64,
    total: f64,
    last_timestamp_ms: i64,
};

pub const Report = struct {
    by_kind: []KindSummary,
    top_users: []UserSummary,

    pub fn deinit(self: Report, allocator: std.mem.Allocator) void {
        allocator.free(self.by_kind);
        allocator.free(self.top_users);
    }
};

const SummaryBuilder = struct {
    allocator: std.mem.Allocator,
    by_kind_name: std.StringHashMap(KindSummary),
    users: std.ArrayList(UserSummary),
    seen_sources: std.ArrayList([]const u8),

    fn init(allocator: std.mem.Allocator) SummaryBuilder {
        return .{
            .allocator = allocator,
            .by_kind_name = std.StringHashMap(KindSummary).init(allocator),
            .users = .empty,
            .seen_sources = .empty,
        };
    }

    fn deinit(self: *SummaryBuilder) void {
        self.by_kind_name.deinit();
        self.users.deinit(self.allocator);
        self.seen_sources.deinit(self.allocator);
    }

    fn addEvent(self: *SummaryBuilder, event: Event) !void {
        const kind_name = @tagName(event.kind);
        const kind_entry = try self.by_kind_name.getOrPut(kind_name);
        if (!kind_entry.found_existing) {
            kind_entry.value_ptr.* = .{};
        }
        updateKindSummary(kind_entry.value_ptr, event);

        var found_user = false;
        for (self.users.items) |*user| {
            if (user.user_id == event.user_id) {
                user.count += 1;
                user.total += event.value;
                if (event.timestamp_ms > user.last_timestamp_ms) {
                    user.last_timestamp_ms = event.timestamp_ms;
                }
                found_user = true;
                break;
            }
        }
        if (!found_user) {
            try self.users.append(self.allocator, .{
                .user_id = event.user_id,
                .count = 1,
                .total = event.value,
                .last_timestamp_ms = event.timestamp_ms,
            });
        }

        var seen_source = false;
        for (self.seen_sources.items) |source| {
            if (std.mem.eql(u8, source, event.source)) {
                seen_source = true;
                break;
            }
        }
        if (!seen_source) {
            try self.seen_sources.append(self.allocator, event.source);
        }
    }

    fn finish(self: *SummaryBuilder, top_user_count: usize) !Report {
        const kind_count = @typeInfo(EventKind).@"enum".fields.len;
        const by_kind = try self.allocator.alloc(KindSummary, kind_count);
        errdefer self.allocator.free(by_kind);
        @memset(by_kind, .{});

        inline for (@typeInfo(EventKind).@"enum".fields) |field| {
            const kind: EventKind = @enumFromInt(field.value);
            if (self.by_kind_name.get(field.name)) |summary| {
                by_kind[@intFromEnum(kind)] = summary;
            }
        }

        std.mem.sort(UserSummary, self.users.items, {}, userSummaryGreaterThan);
        const limit = @min(top_user_count, self.users.items.len);
        const top_users = try self.allocator.alloc(UserSummary, limit);
        errdefer self.allocator.free(top_users);
        @memcpy(top_users, self.users.items[0..limit]);

        return .{
            .by_kind = by_kind,
            .top_users = top_users,
        };
    }
};

fn updateKindSummary(summary: *KindSummary, event: Event) void {
    if (summary.count == 0) {
        summary.min = event.value;
        summary.max = event.value;
        summary.latest_timestamp_ms = event.timestamp_ms;
    } else {
        summary.min = @min(summary.min, event.value);
        summary.max = @max(summary.max, event.value);
        summary.latest_timestamp_ms = @max(summary.latest_timestamp_ms, event.timestamp_ms);
    }
    summary.count += 1;
    summary.total += event.value;
}

fn userSummaryGreaterThan(_: void, left: UserSummary, right: UserSummary) bool {
    if (left.total == right.total) return left.user_id < right.user_id;
    return left.total > right.total;
}

pub fn summarizeEvents(
    allocator: std.mem.Allocator,
    events: []const Event,
    top_user_count: usize,
) !Report {
    var builder = SummaryBuilder.init(allocator);
    defer builder.deinit();

    for (events) |event| {
        try builder.addEvent(event);
    }
    return try builder.finish(top_user_count);
}

fn sampleEvents() []const Event {
    return &.{
        .{ .user_id = 10, .kind = .view, .value = 1, .timestamp_ms = 100, .source = "web", .campaign = "a" },
        .{ .user_id = 10, .kind = .click, .value = 3, .timestamp_ms = 120, .source = "web", .campaign = "a" },
        .{ .user_id = 20, .kind = .purchase, .value = 25, .timestamp_ms = 150, .source = "app", .campaign = "b" },
        .{ .user_id = 10, .kind = .purchase, .value = 11, .timestamp_ms = 210, .source = "web", .campaign = "a" },
        .{ .user_id = 30, .kind = .fault, .value = 1, .timestamp_ms = 230, .source = "worker", .campaign = "ops" },
        .{ .user_id = 20, .kind = .click, .value = 7, .timestamp_ms = 260, .source = "app", .campaign = "b" },
    };
}

fn makeBenchEvents(allocator: std.mem.Allocator, event_count: usize) ![]Event {
    const events = try allocator.alloc(Event, event_count);
    for (events, 0..) |*event, index| {
        event.* = .{
            .user_id = @intCast((index * 37) % 4096),
            .kind = @enumFromInt(index % @typeInfo(EventKind).@"enum".fields.len),
            .value = @as(f64, @floatFromInt((index * 17) % 1000)) / 10.0,
            .timestamp_ms = @intCast(1_700_000_000 + index),
            .source = switch (index % 4) {
                0 => "web",
                1 => "app",
                2 => "worker",
                else => "partner",
            },
            .campaign = switch (index % 3) {
                0 => "launch",
                1 => "retention",
                else => "ops",
            },
        };
    }
    return events;
}

fn bench(allocator: std.mem.Allocator) !void {
    const events = try makeBenchEvents(allocator, 80_000);
    defer allocator.free(events);

    var checksum: f64 = 0;
    const start = std.time.nanoTimestamp();
    for (0..24) |_| {
        const report = try summarizeEvents(allocator, events, 32);
        defer report.deinit(allocator);
        for (report.by_kind) |summary| checksum += summary.total + @as(f64, @floatFromInt(summary.count));
        for (report.top_users) |user| checksum += user.total + @as(f64, @floatFromInt(user.count));
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
        const report = try summarizeEvents(allocator, sampleEvents(), 3);
        defer report.deinit(allocator);
        std.debug.print("kinds={d} top_users={d}\n", .{ report.by_kind.len, report.top_users.len });
    }
}

test "summarizeEvents groups events by kind and top users" {
    const allocator = std.testing.allocator;
    const report = try summarizeEvents(allocator, sampleEvents(), 2);
    defer report.deinit(allocator);

    try std.testing.expectEqual(@as(usize, @typeInfo(EventKind).@"enum".fields.len), report.by_kind.len);
    try std.testing.expectEqual(@as(u64, 2), report.by_kind[@intFromEnum(EventKind.click)].count);
    try std.testing.expectEqual(@as(u64, 2), report.by_kind[@intFromEnum(EventKind.purchase)].count);
    try std.testing.expectEqual(@as(usize, 2), report.top_users.len);
    try std.testing.expectEqual(@as(u32, 20), report.top_users[0].user_id);
    try std.testing.expectEqual(@as(u32, 10), report.top_users[1].user_id);
}
