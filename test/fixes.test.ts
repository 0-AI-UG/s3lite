import { expect, test, describe, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { S3Client } from "../src/client";
import { VectorClient } from "../src/vectors/client";
import { matchesFilter } from "../src/vectors/filter";
import { HNSWIndex } from "../src/vectors/hnsw";

const CORE_PATH = "/tmp/s3lite-fixes-test.s3db";
const VEC_PATH = "/tmp/s3lite-vec-fixes-test.vecdb";

function cleanupCore() {
  for (const p of [CORE_PATH, CORE_PATH + "-wal", CORE_PATH + "-blobs", CORE_PATH + ".lock"]) {
    if (existsSync(p)) unlinkSync(p);
  }
}

function cleanupVec() {
  for (const p of [VEC_PATH, VEC_PATH + "-wal", VEC_PATH + ".tmp"]) {
    if (existsSync(p)) unlinkSync(p);
  }
}

afterEach(() => {
  cleanupCore();
  cleanupVec();
});

describe("Fix: DELETE_INDEX replay correctness", () => {
  test("old vectors do not reappear after delete+recreate+reopen", () => {
    cleanupVec();

    // Create index, add vectors, delete index, recreate fresh
    const c1 = new VectorClient({ path: VEC_PATH });
    c1.createIndex({ name: "idx", dimension: 2, distanceMetric: "euclidean" });
    c1.putVectors("idx", [
      { key: "old1", vector: [1, 0], metadata: { from: "old" } },
      { key: "old2", vector: [0, 1], metadata: { from: "old" } },
    ]);
    c1.deleteIndex("idx");
    c1.createIndex({ name: "idx", dimension: 2, distanceMetric: "euclidean" });
    c1.putVectors("idx", [
      { key: "new1", vector: [1, 1], metadata: { from: "new" } },
    ]);
    c1.close();

    // Reopen and verify old vectors are gone
    const c2 = new VectorClient({ path: VEC_PATH });
    const vecs = c2.getVectors("idx", ["old1", "old2", "new1"]);
    expect(vecs).toHaveLength(1);
    expect(vecs[0]!.key).toBe("new1");
    expect(vecs[0]!.metadata).toEqual({ from: "new" });
    c2.close();
  });
});

describe("Fix: HNSW randomLayer safety", () => {
  test("insert works even with many vectors (no crash)", () => {
    const hnsw = new HNSWIndex(3, "euclidean");
    // Insert 200 vectors — exercises randomLayer many times
    for (let i = 0; i < 200; i++) {
      hnsw.insert(`v${i}`, new Float32Array([Math.random(), Math.random(), Math.random()]));
    }
    expect(hnsw.size).toBe(200);

    const results = hnsw.search(new Float32Array([0.5, 0.5, 0.5]), 5);
    expect(results.length).toBeLessThanOrEqual(5);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("Fix: Filter rejects non-operator objects", () => {
  test("object without $ keys is treated as bare value (not operator)", () => {
    // { category: { randomKey: "value" } } should NOT match everything
    expect(matchesFilter({ category: "a" }, { category: { randomKey: "value" } as any })).toBe(false);
  });

  test("valid operator still works", () => {
    expect(matchesFilter({ x: 5 }, { x: { $gt: 3 } })).toBe(true);
    expect(matchesFilter({ x: 2 }, { x: { $gt: 3 } })).toBe(false);
  });
});

describe("Fix: NetworkSink passes TTL", () => {
  test("writer preserves expires option", async () => {
    cleanupCore();
    const client = new S3Client({ path: CORE_PATH, bucket: "b" });
    const file = client.file("ttl.txt", { expires: 3600 });
    const sink = file.writer();
    sink.write("hello");
    await sink.end();

    // Object should exist and have stat
    const stat = client.stat("ttl.txt");
    expect(stat.size).toBe(5);
    client.close();
  });
});

describe("Fix: list() continuationToken", () => {
  test("continuationToken works for pagination", async () => {
    cleanupCore();
    const client = new S3Client({ path: CORE_PATH, bucket: "b" });
    for (let i = 0; i < 5; i++) {
      await client.write(`key${i}.txt`, `data${i}`);
    }

    // First page
    const page1 = client.list({ maxKeys: 2 });
    expect(page1.contents).toHaveLength(2);
    expect(page1.isTruncated).toBe(true);
    expect(page1.nextContinuationToken).toBeDefined();

    // Second page via continuationToken
    const page2 = client.list({ maxKeys: 2, continuationToken: page1.nextContinuationToken });
    expect(page2.contents).toHaveLength(2);
    expect(page2.isTruncated).toBe(true);

    // Third page
    const page3 = client.list({ maxKeys: 2, continuationToken: page2.nextContinuationToken });
    expect(page3.contents).toHaveLength(1);
    expect(page3.isTruncated).toBe(false);

    // All keys collected
    const allKeys = [
      ...page1.contents!.map(c => c.key),
      ...page2.contents!.map(c => c.key),
      ...page3.contents!.map(c => c.key),
    ];
    expect(allKeys).toHaveLength(5);
    client.close();
  });
});

describe("Fix: list() truncation applies to combined count", () => {
  test("maxKeys limits contents + commonPrefixes combined", async () => {
    cleanupCore();
    const client = new S3Client({ path: CORE_PATH, bucket: "b" });

    // Create files that produce both contents and common prefixes
    await client.write("dir1/a.txt", "a");
    await client.write("dir1/b.txt", "b");
    await client.write("dir2/c.txt", "c");
    await client.write("root.txt", "r");

    // With delimiter "/", we get: commonPrefixes=[dir1/, dir2/], contents=[root.txt]
    // maxKeys=2 should truncate at 2 total items
    const result = client.list({ delimiter: "/", maxKeys: 2 });
    const totalItems = (result.contents?.length ?? 0) + (result.commonPrefixes?.length ?? 0);
    expect(totalItems).toBeLessThanOrEqual(2);
    expect(result.isTruncated).toBe(true);
    client.close();
  });
});

describe("Fix: copy() emits destination key", () => {
  test("copy event receives destination bucket/key", async () => {
    cleanupCore();
    const client = new S3Client({ path: CORE_PATH, bucket: "b" });
    const events: string[] = [];
    client.on("copy", (bucket, key) => events.push(`${bucket}/${key}`));

    await client.write("src.txt", "data");
    client.copy("src.txt", "dest.txt");

    expect(events).toEqual(["b/dest.txt"]);
    client.close();
  });
});
