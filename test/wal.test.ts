import { test, expect, beforeEach, afterEach } from "bun:test";
import { WAL } from "../src/wal";
import { rmSync, existsSync } from "node:fs";
import type { StoredObject } from "../src/types";

const TEST_PATH = "/tmp/s3lite-wal-test.s3db";

function cleanup() {
  for (const p of [TEST_PATH, TEST_PATH + "-wal"]) {
    if (existsSync(p)) rmSync(p);
  }
}

beforeEach(cleanup);
afterEach(cleanup);

test("WAL: open creates WAL file", () => {
  const objects = new Map<string, Map<string, StoredObject>>();
  const wal = new WAL(TEST_PATH);
  wal.open(objects);
  expect(existsSync(TEST_PATH + "-wal")).toBe(true);
  wal.close(objects);
});

test("WAL: append and replay PUT", () => {
  const objects = new Map<string, Map<string, StoredObject>>();
  const wal = new WAL(TEST_PATH);
  wal.open(objects);

  const data = new TextEncoder().encode("hello world");
  const lastModified = new Date();
  wal.appendPut("mybucket", "test.txt", data, {
    contentType: "text/plain",
    etag: '"abc123"',
    lastModified: lastModified.toISOString(),
  });
  // Keep in-memory map in sync (as Store would do)
  const bm = new Map<string, StoredObject>();
  bm.set("test.txt", {
    data,
    size: data.byteLength,
    etag: '"abc123"',
    contentType: "text/plain",
    lastModified,
  });
  objects.set("mybucket", bm);
  wal.close(objects);

  // Reopen and verify replay from checkpointed main file
  const objects2 = new Map<string, Map<string, StoredObject>>();
  const wal2 = new WAL(TEST_PATH);
  wal2.open(objects2);

  expect(objects2.has("mybucket")).toBe(true);
  const obj = objects2.get("mybucket")!.get("test.txt")!;
  expect(new TextDecoder().decode(obj.data!)).toBe("hello world");
  expect(obj.contentType).toBe("text/plain");
  wal2.close(objects2);
});

test("WAL: append and replay DELETE", () => {
  const objects = new Map<string, Map<string, StoredObject>>();
  const wal = new WAL(TEST_PATH);
  wal.open(objects);

  const data = new TextEncoder().encode("hello");
  wal.appendPut("mybucket", "file.txt", data, {
    contentType: "text/plain",
    etag: '"abc"',
    lastModified: new Date().toISOString(),
  });
  // Update in-memory too
  const bucketMap = new Map<string, StoredObject>();
  bucketMap.set("file.txt", {
    data,
    size: data.byteLength,
    etag: '"abc"',
    contentType: "text/plain",
    lastModified: new Date(),
  });
  objects.set("mybucket", bucketMap);

  // Now delete
  wal.appendDelete("mybucket", "file.txt");
  bucketMap.delete("file.txt");
  objects.delete("mybucket");

  wal.close(objects);

  // Reopen: file should not exist
  const objects2 = new Map<string, Map<string, StoredObject>>();
  const wal2 = new WAL(TEST_PATH);
  wal2.open(objects2);
  expect(objects2.has("mybucket")).toBe(false);
  wal2.close(objects2);
});

test("WAL: checkpoint compacts main file", () => {
  const objects = new Map<string, Map<string, StoredObject>>();
  const wal = new WAL(TEST_PATH, "off", 1); // threshold of 1 byte to force checkpoint

  wal.open(objects);

  const data = new TextEncoder().encode("data");
  wal.appendPut("b", "k", data, {
    contentType: "text/plain",
    etag: '"e"',
    lastModified: new Date().toISOString(),
  });

  // Manually update in-memory and checkpoint
  let bm = objects.get("b");
  if (!bm) { bm = new Map(); objects.set("b", bm); }
  bm.set("k", {
    data,
    size: data.byteLength,
    etag: '"e"',
    contentType: "text/plain",
    lastModified: new Date(),
  });

  wal.checkpoint(objects);

  expect(existsSync(TEST_PATH)).toBe(true);
  // WAL should be truncated
  const walFile = Bun.file(TEST_PATH + "-wal");
  expect(walFile.size).toBe(0);

  wal.close(objects);
});

test("WAL: crash recovery - uncommitted WAL entries are replayed", () => {
  // Simulate crash: write to WAL but don't checkpoint
  const objects = new Map<string, Map<string, StoredObject>>();
  const wal = new WAL(TEST_PATH);
  wal.open(objects);

  const data = new TextEncoder().encode("crash test data");
  wal.appendPut("bucket", "crash.txt", data, {
    contentType: "text/plain",
    etag: '"ct"',
    lastModified: new Date().toISOString(),
  });

  // Don't call close() - simulate crash
  // WAL file has the entry but main file doesn't

  // Reopen
  const objects2 = new Map<string, Map<string, StoredObject>>();
  const wal2 = new WAL(TEST_PATH);
  wal2.open(objects2);

  expect(objects2.get("bucket")?.get("crash.txt")).toBeDefined();
  expect(new TextDecoder().decode(objects2.get("bucket")!.get("crash.txt")!.data!)).toBe("crash test data");
  wal2.close(objects2);
});
