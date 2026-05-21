const std = @import("std");

pub const Role = enum(u8) {
    guest,
    user,
    operator,
    admin,
    service,
    auditor,
};

pub const Action = enum(u8) {
    read,
    write,
    deploy,
    purge,
    export_data,
    import_data,
    billing,
    audit,
};

pub const Rule = struct {
    role: Role,
    action: Action,
    min_level: u8,
    allow: bool,
    weight: u32,
};

pub const Event = struct {
    id: u32,
    role: Role,
    action: Action,
    level: u8,
    resource_cost: u32,
    label: [48]u8,
    provenance: [80]u8,
};

pub const AccessSummary = struct {
    allowed: usize = 0,
    denied: usize = 0,
    weighted_cost: u64 = 0,
    checksum: u64 = 0,
};

fn filled(comptime len: usize, value: u8) [len]u8 {
    var out: [len]u8 = undefined;
    @memset(out[0..], value);
    return out;
}

fn matchingRule(rules: []const Rule, event: Event) ?Rule {
    for (rules) |rule| {
        if (rule.role == event.role and rule.action == event.action and event.level >= rule.min_level) {
            return rule;
        }
    }
    return null;
}

pub fn evaluateAccess(rules: []const Rule, events: []const Event) AccessSummary {
    var summary = AccessSummary{};
    for (events) |event| {
        const rule = matchingRule(rules, event) orelse {
            summary.denied += 1;
            summary.checksum +%= @as(u64, event.id) * 17 + @intFromEnum(event.role);
            continue;
        };
        if (!rule.allow) {
            summary.denied += 1;
            summary.checksum +%= @as(u64, event.id) * 17 + @intFromEnum(event.role);
            continue;
        }
        summary.allowed += 1;
        summary.weighted_cost +%= @as(u64, event.resource_cost) * rule.weight;
        summary.checksum +%= @as(u64, event.id) * 131 + rule.weight + @intFromEnum(rule.action);
    }
    return summary;
}

fn makeRules() [48]Rule {
    var rules: [48]Rule = undefined;
    for (&rules, 0..) |*rule, index| {
        rule.* = .{
            .role = @enumFromInt(@as(u3, @intCast(index % 6))),
            .action = @enumFromInt(@as(u3, @intCast((index * 5) % 8))),
            .min_level = @intCast(index % 9),
            .allow = (index % 7) != 0,
            .weight = @intCast(1 + ((index * 11) % 29)),
        };
    }
    return rules;
}

fn makeEvents(allocator: std.mem.Allocator, count: usize) ![]Event {
    const events = try allocator.alloc(Event, count);
    for (events, 0..) |*event, index| {
        event.* = .{
            .id = @intCast(index + 1),
            .role = @enumFromInt(@as(u3, @intCast((index * 3 + 1) % 6))),
            .action = @enumFromInt(@as(u3, @intCast((index * 5 + 2) % 8))),
            .level = @intCast((index * 7) % 12),
            .resource_cost = @intCast(10 + ((index * 13) % 500)),
            .label = filled(48, 'A' + @as(u8, @intCast(index % 26))),
            .provenance = filled(80, 'a' + @as(u8, @intCast(index % 26))),
        };
    }
    return events;
}

fn demo() void {
    const rules = [_]Rule{
        .{ .role = .guest, .action = .read, .min_level = 0, .allow = true, .weight = 2 },
        .{ .role = .user, .action = .deploy, .min_level = 4, .allow = true, .weight = 7 },
    };
    const events = [_]Event{
        .{ .id = 1, .role = .guest, .action = .read, .level = 3, .resource_cost = 10, .label = filled(48, 'x'), .provenance = filled(80, 'y') },
        .{ .id = 2, .role = .user, .action = .deploy, .level = 1, .resource_cost = 10, .label = filled(48, 'x'), .provenance = filled(80, 'y') },
    };
    const summary = evaluateAccess(rules[0..], events[0..]);
    std.debug.print("allowed={d} denied={d} weighted={d}\n", .{ summary.allowed, summary.denied, summary.weighted_cost });
}

fn bench(allocator: std.mem.Allocator) !void {
    const rules = makeRules();
    const events = try makeEvents(allocator, 160_000);
    defer allocator.free(events);

    var checksum: u64 = 0;
    const warmup = 4;
    for (0..warmup) |_| {
        const summary = evaluateAccess(rules[0..], events);
        checksum +%= summary.checksum;
    }

    const iterations = 35;
    const start = std.time.nanoTimestamp();
    for (0..iterations) |_| {
        const summary = evaluateAccess(rules[0..], events);
        checksum +%= summary.checksum + summary.weighted_cost + summary.allowed + summary.denied;
    }
    const elapsed = std.time.nanoTimestamp() - start;
    std.debug.print(
        "bench boundary=evaluateAccess rules={d} events={d} iterations={d} warmup={d} elapsed_ns={d} checksum={d}\n",
        .{ rules.len, events.len, iterations, warmup, elapsed, checksum },
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
        demo();
    }
}

test "evaluateAccess keeps first matching rule semantics" {
    const rules = [_]Rule{
        .{ .role = .guest, .action = .read, .min_level = 0, .allow = true, .weight = 2 },
        .{ .role = .guest, .action = .read, .min_level = 3, .allow = false, .weight = 9 },
        .{ .role = .user, .action = .deploy, .min_level = 4, .allow = true, .weight = 7 },
        .{ .role = .admin, .action = .purge, .min_level = 8, .allow = true, .weight = 11 },
    };
    const events = [_]Event{
        .{ .id = 10, .role = .guest, .action = .read, .level = 5, .resource_cost = 100, .label = filled(48, 'x'), .provenance = filled(80, 'y') },
        .{ .id = 11, .role = .user, .action = .deploy, .level = 3, .resource_cost = 100, .label = filled(48, 'x'), .provenance = filled(80, 'y') },
        .{ .id = 12, .role = .user, .action = .deploy, .level = 4, .resource_cost = 50, .label = filled(48, 'x'), .provenance = filled(80, 'y') },
        .{ .id = 13, .role = .admin, .action = .purge, .level = 8, .resource_cost = 10, .label = filled(48, 'x'), .provenance = filled(80, 'y') },
        .{ .id = 14, .role = .auditor, .action = .read, .level = 9, .resource_cost = 1, .label = filled(48, 'x'), .provenance = filled(80, 'y') },
    };
    const summary = evaluateAccess(rules[0..], events[0..]);
    try std.testing.expectEqual(@as(usize, 3), summary.allowed);
    try std.testing.expectEqual(@as(usize, 2), summary.denied);
    try std.testing.expectEqual(@as(u64, 660), summary.weighted_cost);
    try std.testing.expectEqual(@as(u64, 5041), summary.checksum);
}
