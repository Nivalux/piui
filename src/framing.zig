const std = @import("std");
const Io = std.Io;

pub const max_record = 64 << 20;

pub const Error = Io.Reader.Error || error{RecordTooLong} || std.mem.Allocator.Error;

/// Splits a byte stream into JSONL records. Records end at LF only: U+2028, U+2029 and friends are
/// legal inside JSON strings. A CR directly before the LF is dropped.
pub const Records = struct {
    allocator: std.mem.Allocator,
    source: *Io.Reader,
    pending: std.ArrayList(u8) = .empty,
    chunk: [64 * 1024]u8 = undefined,

    pub fn init(allocator: std.mem.Allocator, source: *Io.Reader) Records {
        return .{ .allocator = allocator, .source = source };
    }

    pub fn deinit(self: *Records) void {
        self.pending.deinit(self.allocator);
    }

    pub fn next(self: *Records) Error!?[]u8 {
        while (true) {
            if (std.mem.indexOfScalar(u8, self.pending.items, '\n')) |cut| {
                const record = trimCr(self.pending.items[0..cut]);
                const owned = try self.allocator.dupe(u8, record);
                self.consume(cut + 1);
                if (owned.len > 0) return owned;
                self.allocator.free(owned);
                continue;
            }

            var slot = [1][]u8{&self.chunk};
            const read = self.source.readVec(&slot) catch |err| switch (err) {
                error.EndOfStream => return self.flush(),
                else => return err,
            };
            if (read == 0) continue;

            try self.pending.appendSlice(self.allocator, self.chunk[0..read]);
            if (self.pending.items.len > max_record) return error.RecordTooLong;
        }
    }

    /// Hands out whatever is left when the stream ends without a final LF.
    fn flush(self: *Records) Error!?[]u8 {
        if (self.pending.items.len == 0) return null;
        const owned = try self.allocator.dupe(u8, trimCr(self.pending.items));
        self.pending.clearRetainingCapacity();
        if (owned.len == 0) {
            self.allocator.free(owned);
            return null;
        }
        return owned;
    }

    fn consume(self: *Records, taken: usize) void {
        const rest = self.pending.items.len - taken;
        std.mem.copyForwards(u8, self.pending.items[0..rest], self.pending.items[taken..]);
        self.pending.shrinkRetainingCapacity(rest);
    }
};

fn trimCr(record: []const u8) []const u8 {
    if (record.len > 0 and record[record.len - 1] == '\r') return record[0 .. record.len - 1];
    return record;
}
