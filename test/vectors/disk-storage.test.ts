import { test, expect, afterEach, describe } from "bun:test";
import { VectorClient } from "../../src/vectors/client";
import { rmSync, existsSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-vector-disk-test.s3db";
let client: VectorClient | null = null;

function cleanup() {
  try { client?.close(); } catch {}
  client = null;
  // Clean up all related files
  for (const p of [
    TEST_PATH, TEST_PATH + "-wal",
    TEST_PATH + "-vdata", TEST_PATH + "-vdata-blobs",
    TEST_PATH + "-vdata.lock",
  ]) {
    try { if (existsSync(p)) rmSync(p); } catch {}
  }
}

afterEach(cleanup);

function normalizedVector(dim: number): number[] {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

describe("disk storage", () => {
  test("basic insert and query", () => {
    client = new VectorClient({ path: TEST_PATH, storage: "disk" });
    const dim = 64;

    client.createIndex({ name: "test", dimension: dim, distanceMetric: "cosine" });

    const vectors = Array.from({ length: 100 }, (_, i) => ({
      key: `vec-${i}`,
      vector: normalizedVector(dim),
      metadata: { group: i % 5 },
    }));
    client.putVectors("test", vectors);

    const queryVec = normalizedVector(dim);
    const { results } = client.query("test", { vector: queryVec, topK: 10 });
    expect(results.length).toBe(10);
  });

  test("getVectors returns correct data from disk", () => {
    client = new VectorClient({ path: TEST_PATH, storage: "disk" });
    const dim = 16;

    client.createIndex({ name: "test", dimension: dim, distanceMetric: "cosine" });

    const inputVec = normalizedVector(dim);
    client.putVectors("test", [{ key: "my-vec", vector: inputVec, metadata: { label: "hello" } }]);

    const [result] = client.getVectors("test", ["my-vec"]);
    expect(result).toBeDefined();
    expect(result!.key).toBe("my-vec");
    expect(result!.metadata).toEqual({ label: "hello" });
    expect(result!.vector).toBeDefined();
    // Compare values (may be slightly different due to Float32 precision)
    for (let i = 0; i < dim; i++) {
      expect(result!.vector![i]).toBeCloseTo(inputVec[i]!, 5);
    }
  });

  test("persistence: close and reopen", () => {
    client = new VectorClient({ path: TEST_PATH, storage: "disk" });
    const dim = 64;
    const count = 500;

    client.createIndex({ name: "bench", dimension: dim, distanceMetric: "cosine" });

    const vectors = Array.from({ length: count }, (_, i) => ({
      key: `vec-${i}`,
      vector: normalizedVector(dim),
    }));
    client.putVectors("bench", vectors);
    client.close();

    // Reopen
    client = new VectorClient({ path: TEST_PATH, storage: "disk" });

    // Verify all vectors are present
    let totalKeys = 0;
    let startAfter: string | undefined;
    do {
      const page = client.listVectors("bench", { maxKeys: 1000, startAfter });
      totalKeys += page.keys.length;
      startAfter = page.nextStartAfter;
      if (!page.isTruncated) break;
    } while (startAfter);
    expect(totalKeys).toBe(count);

    // Query should work
    const { results } = client.query("bench", { vector: normalizedVector(dim), topK: 10 });
    expect(results.length).toBe(10);
  });

  test("delete vectors from disk", () => {
    client = new VectorClient({ path: TEST_PATH, storage: "disk" });
    const dim = 32;

    client.createIndex({ name: "test", dimension: dim, distanceMetric: "cosine" });

    const vectors = Array.from({ length: 50 }, (_, i) => ({
      key: `vec-${i}`,
      vector: normalizedVector(dim),
    }));
    client.putVectors("test", vectors);

    const deleted = client.deleteVectors("test", ["vec-0", "vec-1", "vec-2"]);
    expect(deleted).toBe(3);

    const listed = client.listVectors("test");
    expect(listed.keys.length).toBe(47);

    // Query should still work
    const { results } = client.query("test", { vector: normalizedVector(dim), topK: 10 });
    expect(results.length).toBe(10);
  });

  test("metadata filtering in disk mode", () => {
    client = new VectorClient({ path: TEST_PATH, storage: "disk" });
    const dim = 64;

    client.createIndex({ name: "test", dimension: dim, distanceMetric: "cosine" });

    const vectors = Array.from({ length: 200 }, (_, i) => ({
      key: `vec-${i}`,
      vector: normalizedVector(dim),
      metadata: { category: i % 2 === 0 ? "even" : "odd" },
    }));
    client.putVectors("test", vectors);

    const { results } = client.query("test", {
      vector: normalizedVector(dim),
      topK: 10,
      filter: { category: "even" },
    });
    for (const r of results) {
      expect(r.metadata?.category).toBe("even");
    }
  });

  test("includeVectors in query results", () => {
    client = new VectorClient({ path: TEST_PATH, storage: "disk" });
    const dim = 16;

    client.createIndex({ name: "test", dimension: dim, distanceMetric: "cosine" });

    client.putVectors("test", [
      { key: "a", vector: normalizedVector(dim) },
      { key: "b", vector: normalizedVector(dim) },
    ]);

    const { results } = client.query("test", {
      vector: normalizedVector(dim),
      topK: 2,
      includeVectors: true,
    });

    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.vector).toBeDefined();
      expect(r.vector!.length).toBe(dim);
    }
  });

  test("disk mode requires path", () => {
    expect(() => {
      new VectorClient({ storage: "disk" });
    }).toThrow("storage: 'disk' requires a path");
  });

  test("1k vectors disk mode performance", () => {
    client = new VectorClient({ path: TEST_PATH, storage: "disk" });
    const dim = 128;
    const count = 1_000;

    client.createIndex({ name: "bench", dimension: dim, distanceMetric: "cosine" });

    const vectors = Array.from({ length: count }, (_, i) => ({
      key: `vec-${i}`,
      vector: normalizedVector(dim),
    }));

    const start = performance.now();
    client.putVectors("bench", vectors);
    const insertTime = performance.now() - start;

    const qStart = performance.now();
    for (let i = 0; i < 50; i++) {
      const { results } = client.query("bench", { vector: normalizedVector(dim), topK: 10 });
      expect(results.length).toBe(10);
    }
    const queryTime = performance.now() - qStart;

    console.log(`[disk 1k x 128d] insert: ${insertTime.toFixed(0)}ms, 50 queries: ${queryTime.toFixed(0)}ms (${(queryTime / 50).toFixed(2)}ms/query)`);
  });

  test("5k vectors disk mode with persistence", { timeout: 30_000 }, () => {
    client = new VectorClient({ path: TEST_PATH, storage: "disk" });
    const dim = 128;
    const count = 5_000;

    client.createIndex({ name: "bench", dimension: dim, distanceMetric: "cosine" });

    const start = performance.now();
    const batchSize = 500;
    for (let b = 0; b < count; b += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, count - b) }, (_, i) => ({
        key: `vec-${b + i}`,
        vector: normalizedVector(dim),
      }));
      client.putVectors("bench", batch);
    }
    const insertTime = performance.now() - start;

    // Close and reopen
    client.close();
    const reopenStart = performance.now();
    client = new VectorClient({ path: TEST_PATH, storage: "disk" });
    const reopenTime = performance.now() - reopenStart;

    // Query after reopen
    const qStart = performance.now();
    for (let i = 0; i < 20; i++) {
      const { results } = client.query("bench", { vector: normalizedVector(dim), topK: 10 });
      expect(results.length).toBe(10);
    }
    const queryTime = performance.now() - qStart;

    console.log(`[disk 5k x 128d] insert: ${insertTime.toFixed(0)}ms, reopen: ${reopenTime.toFixed(0)}ms, 20 queries: ${queryTime.toFixed(0)}ms (${(queryTime / 20).toFixed(2)}ms/query)`);
  });

  test("hybrid query in disk mode", () => {
    client = new VectorClient({ path: TEST_PATH, storage: "disk" });
    const dim = 64;
    const count = 500;

    client.createIndex({ name: "bench", dimension: dim, distanceMetric: "cosine", sparse: true });

    const vectors = Array.from({ length: count }, (_, i) => ({
      key: `vec-${i}`,
      vector: normalizedVector(dim),
      sparseVector: {
        indices: Array.from({ length: 10 }, (_, j) => i * 3 + j),
        values: Array.from({ length: 10 }, () => Math.random()),
      },
    }));
    client.putVectors("bench", vectors);

    const { results } = client.query("bench", {
      vector: normalizedVector(dim),
      sparseVector: { indices: [0, 5, 10], values: [1, 0.5, 0.2] },
      topK: 10,
    });
    expect(results.length).toBe(10);
  });
});
