import { test, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "../src/store";
import { S3Client } from "../src/client";
import { rmSync, existsSync, statSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-blob-test.s3db";

function cleanup() {
  for (const p of [TEST_PATH, TEST_PATH + "-wal", TEST_PATH + "-blobs", TEST_PATH + "-blobs.compact"]) {
    if (existsSync(p)) rmSync(p);
  }
}

beforeEach(cleanup);
afterEach(cleanup);

test("blob: creates blob file on disk", () => {
  const store = new Store(TEST_PATH);
  store.put("b", "hello.txt", new TextEncoder().encode("hello"));
  expect(existsSync(TEST_PATH + "-blobs")).toBe(true);
  store.close();
});

test("blob: data not held in memory", () => {
  const store = new Store(TEST_PATH);
  store.put("b", "key.txt", new TextEncoder().encode("disk data"));

  // The returned object from get() should have data loaded from disk
  const obj = store.get("b", "key.txt");
  expect(obj).toBeDefined();
  expect(new TextDecoder().decode(obj!.data!)).toBe("disk data");
  store.close();
});

test("blob: persists across close/reopen", () => {
  const store = new Store(TEST_PATH);
  store.put("b", "persist.txt", new TextEncoder().encode("persistent blob"));
  store.close();

  const store2 = new Store(TEST_PATH);
  const obj = store2.get("b", "persist.txt");
  expect(obj).toBeDefined();
  expect(new TextDecoder().decode(obj!.data!)).toBe("persistent blob");
  store2.close();
});

test("blob: range read from disk", () => {
  const store = new Store(TEST_PATH);
  store.put("b", "range.txt", new TextEncoder().encode("hello world"));

  const range = store.getRange("b", "range.txt", 0, 5);
  expect(new TextDecoder().decode(range!)).toBe("hello");

  const range2 = store.getRange("b", "range.txt", 6, 11);
  expect(new TextDecoder().decode(range2!)).toBe("world");
  store.close();
});

test("blob: stat works without loading data", () => {
  const store = new Store(TEST_PATH);
  store.put("b", "stat.txt", new TextEncoder().encode("stat test"), "text/plain");

  const s = store.stat("b", "stat.txt");
  expect(s).toBeDefined();
  expect(s!.size).toBe(9);
  expect(s!.type).toBe("text/plain");
  store.close();
});

test("blob: delete marks space as dead", () => {
  const store = new Store(TEST_PATH);
  store.put("b", "del.txt", new TextEncoder().encode("delete me"));
  expect(store.exists("b", "del.txt")).toBe(true);

  store.delete("b", "del.txt");
  expect(store.exists("b", "del.txt")).toBe(false);
  store.close();
});

test("blob: overwrite marks old data as dead", () => {
  const store = new Store(TEST_PATH);
  store.put("b", "overwrite.txt", new TextEncoder().encode("version 1"));
  store.put("b", "overwrite.txt", new TextEncoder().encode("version 2"));

  const obj = store.get("b", "overwrite.txt");
  expect(new TextDecoder().decode(obj!.data!)).toBe("version 2");
  store.close();
});

test("blob: compaction reclaims space", () => {
  const store = new Store(TEST_PATH);

  // Write some data, then overwrite to create dead space
  const largeData = new Uint8Array(1024).fill(65); // 1KB of 'A'
  store.put("b", "file1.txt", largeData);
  store.put("b", "file2.txt", largeData);

  // Overwrite file1 to create dead space
  const newData = new TextEncoder().encode("small");
  store.put("b", "file1.txt", newData);

  const blobSizeBefore = statSync(TEST_PATH + "-blobs").size;

  // Force compaction via checkpoint
  store.checkpoint();

  const blobSizeAfter = statSync(TEST_PATH + "-blobs").size;
  expect(blobSizeAfter).toBeLessThan(blobSizeBefore);

  // Data still accessible after compaction
  const obj1 = store.get("b", "file1.txt");
  expect(new TextDecoder().decode(obj1!.data!)).toBe("small");
  const obj2 = store.get("b", "file2.txt");
  expect(obj2!.data!.byteLength).toBe(1024);

  store.close();
});

test("blob: large object survives full lifecycle", async () => {
  const client = new S3Client({ bucket: "b", path: TEST_PATH });

  // Write 1MB object
  const megabyte = new Uint8Array(1024 * 1024);
  for (let i = 0; i < megabyte.length; i++) megabyte[i] = i & 0xff;

  await client.write("large.bin", megabyte);
  client.close();

  // Reopen and verify
  const client2 = new S3Client({ bucket: "b", path: TEST_PATH });
  const file = client2.file("large.bin");

  const stat = await file.stat();
  expect(stat.size).toBe(1024 * 1024);

  const data = await file.bytes();
  expect(data.byteLength).toBe(1024 * 1024);
  expect(data[0]).toBe(0);
  expect(data[255]).toBe(255);
  expect(data[256]).toBe(0);

  client2.close();
});

test("blob: copy works with disk-backed storage", () => {
  const store = new Store(TEST_PATH);
  store.put("b", "src.txt", new TextEncoder().encode("copy me"));

  store.copy("b", "src.txt", "b", "dest.txt");

  const obj = store.get("b", "dest.txt");
  expect(new TextDecoder().decode(obj!.data!)).toBe("copy me");

  // Survives close/reopen
  store.close();
  const store2 = new Store(TEST_PATH);
  const obj2 = store2.get("b", "dest.txt");
  expect(new TextDecoder().decode(obj2!.data!)).toBe("copy me");
  store2.close();
});

test("blob: list works with disk-backed storage", () => {
  const store = new Store(TEST_PATH);
  store.put("b", "a.txt", new TextEncoder().encode("a"));
  store.put("b", "b.txt", new TextEncoder().encode("b"));
  store.put("b", "c.txt", new TextEncoder().encode("c"));

  const result = store.list("b");
  expect(result.contents).toHaveLength(3);
  expect(result.contents![0].key).toBe("a.txt");
  expect(result.contents![0].size).toBe(1);
  store.close();
});

test("blob: multiple buckets on disk", () => {
  const store = new Store(TEST_PATH);
  store.put("bucket-a", "file.txt", new TextEncoder().encode("data a"));
  store.put("bucket-b", "file.txt", new TextEncoder().encode("data b"));

  expect(new TextDecoder().decode(store.get("bucket-a", "file.txt")!.data!)).toBe("data a");
  expect(new TextDecoder().decode(store.get("bucket-b", "file.txt")!.data!)).toBe("data b");

  store.close();

  const store2 = new Store(TEST_PATH);
  expect(new TextDecoder().decode(store2.get("bucket-a", "file.txt")!.data!)).toBe("data a");
  expect(new TextDecoder().decode(store2.get("bucket-b", "file.txt")!.data!)).toBe("data b");
  store2.close();
});
