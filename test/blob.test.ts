import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BlobLog } from "../src/blob";
import { Store } from "../src/store";
import { S3Client } from "../src/client";
import { rmSync, existsSync, statSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-blob-test.s3db";
const BLOB_UNIT_PATH = "/tmp/s3lite-bloblog-unit.blobs";

function cleanup() {
  for (const p of [TEST_PATH, TEST_PATH + "-wal", TEST_PATH + "-blobs", TEST_PATH + "-blobs.compact", BLOB_UNIT_PATH, BLOB_UNIT_PATH + ".compact"]) {
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

// ── BlobLog unit tests ──────────────────────────────────────────────

describe("BlobLog unit", () => {
  test("append returns correct offset and length", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const d1 = new TextEncoder().encode("hello");
    const d2 = new TextEncoder().encode("world!");

    const r1 = blob.append(d1);
    expect(r1.offset).toBe(0);
    expect(r1.length).toBe(5);

    const r2 = blob.append(d2);
    expect(r2.offset).toBe(5);
    expect(r2.length).toBe(6);
    blob.close();
  });

  test("read round-trips appended data", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const data = new TextEncoder().encode("test data here");
    const { offset, length } = blob.append(data);

    const result = blob.read(offset, length);
    expect(new TextDecoder().decode(result)).toBe("test data here");
    blob.close();
  });

  test("multiple appends read in any order", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const entries: { offset: number; length: number; text: string }[] = [];

    for (let i = 0; i < 10; i++) {
      const text = `entry-${i}`;
      const data = new TextEncoder().encode(text);
      const { offset, length } = blob.append(data);
      entries.push({ offset, length, text });
    }

    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      const result = blob.read(e.offset, e.length);
      expect(new TextDecoder().decode(result)).toBe(e.text);
    }
    blob.close();
  });

  test("readRange returns correct slice", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const data = new TextEncoder().encode("abcdefghij");
    const { offset } = blob.append(data);

    const slice = blob.readRange(offset, 10, 2, 5);
    expect(new TextDecoder().decode(slice)).toBe("cde");
    blob.close();
  });

  test("readRange clamps to blob length", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const data = new TextEncoder().encode("short");
    const { offset } = blob.append(data);

    const slice = blob.readRange(offset, 5, 2, 100);
    expect(new TextDecoder().decode(slice)).toBe("ort");
    blob.close();
  });

  test("readRange returns empty for zero-length or inverted range", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const data = new TextEncoder().encode("data");
    const { offset } = blob.append(data);

    expect(blob.readRange(offset, 4, 3, 3).byteLength).toBe(0);
    expect(blob.readRange(offset, 4, 5, 2).byteLength).toBe(0);
    blob.close();
  });

  test("markDead and shouldCompact threshold", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    blob.append(new TextEncoder().encode("x".repeat(100)));

    expect(blob.shouldCompact()).toBe(false);
    blob.markDead(40);
    expect(blob.shouldCompact()).toBe(false);
    blob.markDead(20);
    expect(blob.shouldCompact()).toBe(true);
    blob.close();
  });

  test("shouldCompact is false on empty log", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    blob.markDead(100);
    expect(blob.shouldCompact()).toBe(false);
    blob.close();
  });

  test("compact remaps offsets and shrinks file", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const r1 = blob.append(new TextEncoder().encode("AAAA"));
    const r2 = blob.append(new TextEncoder().encode("BBBB"));
    const r3 = blob.append(new TextEncoder().encode("CCCC"));

    blob.markDead(r2.length);

    const offsetMap = blob.compact([
      { oldOffset: r1.offset, length: r1.length },
      { oldOffset: r3.offset, length: r3.length },
    ]);

    expect(offsetMap.get(r1.offset)).toBe(0);
    expect(offsetMap.get(r3.offset)).toBe(4);

    expect(new TextDecoder().decode(blob.read(0, 4))).toBe("AAAA");
    expect(new TextDecoder().decode(blob.read(4, 4))).toBe("CCCC");
    expect(statSync(BLOB_UNIT_PATH).size).toBe(8);
    blob.close();
  });

  test("compact with no live entries empties the file", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    blob.append(new TextEncoder().encode("dead"));
    blob.markDead(4);

    const offsetMap = blob.compact([]);
    expect(offsetMap.size).toBe(0);
    expect(statSync(BLOB_UNIT_PATH).size).toBe(0);
    blob.close();
  });

  test("compact resets dead bytes", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const r1 = blob.append(new TextEncoder().encode("li"));
    blob.append(new TextEncoder().encode("deaddd"));
    blob.markDead(6);

    // 6 dead out of 8 total = 75% > 50%
    expect(blob.shouldCompact()).toBe(true);
    blob.compact([{ oldOffset: r1.offset, length: r1.length }]);
    expect(blob.shouldCompact()).toBe(false);
    blob.close();
  });

  test("append after compact starts at correct offset", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const r1 = blob.append(new TextEncoder().encode("keep"));
    blob.append(new TextEncoder().encode("remove"));
    blob.markDead(6);

    blob.compact([{ oldOffset: r1.offset, length: r1.length }]);

    const r3 = blob.append(new TextEncoder().encode("new!"));
    expect(r3.offset).toBe(4);
    expect(new TextDecoder().decode(blob.read(r3.offset, r3.length))).toBe("new!");
    blob.close();
  });

  test("reopening preserves data and resumes offset", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const { offset, length } = blob.append(new TextEncoder().encode("persistent"));
    blob.close();

    const blob2 = new BlobLog(BLOB_UNIT_PATH, "off");
    expect(new TextDecoder().decode(blob2.read(offset, length))).toBe("persistent");

    const r2 = blob2.append(new TextEncoder().encode("more"));
    expect(r2.offset).toBe(10);
    blob2.close();
  });

  test("binary data round-trips", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const data = new Uint8Array([0, 1, 2, 255, 254, 128, 0, 0]);
    const { offset, length } = blob.append(data);

    expect(blob.read(offset, length)).toEqual(data);
    blob.close();
  });

  test("single-byte operations", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "off");
    const r = blob.append(new Uint8Array([42]));
    expect(r.length).toBe(1);
    expect(blob.read(0, 1)[0]).toBe(42);
    expect(blob.readRange(0, 1, 0, 1)[0]).toBe(42);
    blob.close();
  });

  test("syncMode full does not error", () => {
    const blob = new BlobLog(BLOB_UNIT_PATH, "full");
    const { offset, length } = blob.append(new TextEncoder().encode("synced"));
    expect(new TextDecoder().decode(blob.read(offset, length))).toBe("synced");
    blob.close();
  });
});
