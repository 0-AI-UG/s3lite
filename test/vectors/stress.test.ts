import { test, expect, afterEach } from "bun:test";
import { VectorClient } from "../../src/vectors/client";
import { rmSync, existsSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-vector-stress-test.s3db";
let client: VectorClient | null = null;

function cleanup() {
  client?.close();
  client = null;
  for (const p of [TEST_PATH, TEST_PATH + "-wal"]) {
    if (existsSync(p)) rmSync(p);
  }
}

afterEach(cleanup);

function randomVector(dim: number): number[] {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1;
  return v;
}

function normalizedVector(dim: number): number[] {
  const v = randomVector(dim);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

test("stress: 1k vectors, 128d, cosine", () => {
  client = new VectorClient();
  const dim = 128;
  const count = 1_000;

  client.createIndex({ name: "bench", dimension: dim, distanceMetric: "cosine" });

  const vectors = Array.from({ length: count }, (_, i) => ({
    key: `vec-${i}`,
    vector: normalizedVector(dim),
    metadata: { group: i % 10 },
  }));

  const start = performance.now();
  client.putVectors("bench", vectors);
  const insertTime = performance.now() - start;

  // Query
  const queryVec = normalizedVector(dim);
  const qStart = performance.now();
  const { results } = client.query("bench", { vector: queryVec, topK: 10 });
  const queryTime = performance.now() - qStart;

  expect(results.length).toBe(10);

  console.log(`[vectors 1k x 128d] insert: ${insertTime.toFixed(0)}ms, query top-10: ${queryTime.toFixed(2)}ms`);
});

test("stress: 10k vectors, 128d, cosine", () => {
  client = new VectorClient();
  const dim = 128;
  const count = 10_000;

  client.createIndex({ name: "bench", dimension: dim, distanceMetric: "cosine" });

  // Insert in batches
  const start = performance.now();
  const batchSize = 1000;
  for (let b = 0; b < count; b += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, count - b) }, (_, i) => ({
      key: `vec-${b + i}`,
      vector: normalizedVector(dim),
      metadata: { group: (b + i) % 100 },
    }));
    client.putVectors("bench", batch);
  }
  const insertTime = performance.now() - start;

  // Multiple queries
  const qStart = performance.now();
  const numQueries = 100;
  for (let i = 0; i < numQueries; i++) {
    const { results } = client.query("bench", { vector: normalizedVector(dim), topK: 10 });
    expect(results.length).toBe(10);
  }
  const queryTime = performance.now() - qStart;

  console.log(`[vectors 10k x 128d] insert: ${insertTime.toFixed(0)}ms, ${numQueries} queries: ${queryTime.toFixed(0)}ms (${(queryTime / numQueries).toFixed(2)}ms/query)`);
});

test("stress: 10k vectors, 768d (sentence-transformer size)", () => {
  client = new VectorClient();
  const dim = 768;
  const count = 10_000;

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

  const qStart = performance.now();
  for (let i = 0; i < 50; i++) {
    const { results } = client.query("bench", { vector: normalizedVector(dim), topK: 10 });
    expect(results.length).toBe(10);
  }
  const queryTime = performance.now() - qStart;

  console.log(`[vectors 10k x 768d] insert: ${insertTime.toFixed(0)}ms, 50 queries: ${queryTime.toFixed(0)}ms (${(queryTime / 50).toFixed(2)}ms/query)`);
}, 300_000);

test("stress: 50k vectors, 128d", () => {
  client = new VectorClient();
  const dim = 128;
  const count = 50_000;

  client.createIndex({ name: "bench", dimension: dim, distanceMetric: "cosine" });

  const start = performance.now();
  const batchSize = 2000;
  for (let b = 0; b < count; b += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, count - b) }, (_, i) => ({
      key: `vec-${b + i}`,
      vector: normalizedVector(dim),
    }));
    client.putVectors("bench", batch);
  }
  const insertTime = performance.now() - start;

  const qStart = performance.now();
  for (let i = 0; i < 50; i++) {
    const { results } = client.query("bench", { vector: normalizedVector(dim), topK: 10 });
    expect(results.length).toBe(10);
  }
  const queryTime = performance.now() - qStart;

  // Verify list via pagination
  let totalKeys = 0;
  let startAfter: string | undefined;
  do {
    const page = client.listVectors("bench", { maxKeys: 10_000, startAfter });
    totalKeys += page.keys.length;
    startAfter = page.nextStartAfter;
    if (!page.isTruncated) break;
  } while (startAfter);
  expect(totalKeys).toBe(count);

  console.log(`[vectors 50k x 128d] insert: ${insertTime.toFixed(0)}ms, 50 queries: ${queryTime.toFixed(0)}ms (${(queryTime / 50).toFixed(2)}ms/query)`);
}, 600_000);

test("stress: 1k vectors with metadata filtering", () => {
  client = new VectorClient();
  const dim = 128;
  const count = 1_000;

  client.createIndex({ name: "bench", dimension: dim, distanceMetric: "cosine" });

  const vectors = Array.from({ length: count }, (_, i) => ({
    key: `vec-${i}`,
    vector: normalizedVector(dim),
    metadata: {
      category: ["A", "B", "C", "D"][i % 4],
      score: Math.random() * 100,
      active: i % 2 === 0,
    },
  }));
  client.putVectors("bench", vectors);

  // Filtered query
  const qStart = performance.now();
  const { results } = client.query("bench", {
    vector: normalizedVector(dim),
    topK: 10,
    filter: { category: "A", score: { $gt: 50 } },
  });
  const queryTime = performance.now() - qStart;

  for (const r of results) {
    expect(r.metadata?.category).toBe("A");
    expect(r.metadata?.score as number).toBeGreaterThan(50);
  }

  console.log(`[vectors 1k filtered] query: ${queryTime.toFixed(2)}ms, results: ${results.length}`);
});

test("stress: vector persistence with 5k vectors", () => {
  client = new VectorClient({ path: TEST_PATH });
  const dim = 64;
  const count = 5_000;

  client.createIndex({ name: "bench", dimension: dim, distanceMetric: "cosine" });

  const vectors = Array.from({ length: count }, (_, i) => ({
    key: `vec-${i}`,
    vector: normalizedVector(dim),
  }));

  const start = performance.now();
  client.putVectors("bench", vectors);
  const insertTime = performance.now() - start;

  client.checkpoint();

  // Close and reopen
  client.close();
  client = new VectorClient({ path: TEST_PATH });

  const reopenStart = performance.now();
  const listed = client.listVectors("bench");
  const reopenTime = performance.now() - reopenStart;

  expect(listed.keys.length).toBe(Math.min(count, 1000));

  // Paginate to verify full count
  let totalKeys = 0;
  let startAfter: string | undefined;
  do {
    const page = client.listVectors("bench", { maxKeys: 5000, startAfter });
    totalKeys += page.keys.length;
    startAfter = page.nextStartAfter;
    if (!page.isTruncated) break;
  } while (startAfter);
  expect(totalKeys).toBe(count);

  // Query after reopen
  const { results } = client.query("bench", { vector: normalizedVector(dim), topK: 10 });
  expect(results.length).toBe(10);

  console.log(`[vectors 5k persisted] insert: ${insertTime.toFixed(0)}ms, reopen+list: ${reopenTime.toFixed(0)}ms`);
});

test("stress: hybrid query with 5k vectors", () => {
  client = new VectorClient();
  const dim = 128;
  const count = 5_000;

  client.createIndex({ name: "bench", dimension: dim, distanceMetric: "cosine", sparse: true });

  const vectors = Array.from({ length: count }, (_, i) => ({
    key: `vec-${i}`,
    vector: normalizedVector(dim),
    sparseVector: {
      indices: Array.from({ length: 20 }, (_, j) => i * 3 + j),
      values: Array.from({ length: 20 }, () => Math.random()),
    },
  }));

  const start = performance.now();
  const batchSize = 1000;
  for (let b = 0; b < count; b += batchSize) {
    client.putVectors("bench", vectors.slice(b, b + batchSize));
  }
  const insertTime = performance.now() - start;

  // Hybrid query
  const qStart = performance.now();
  for (let i = 0; i < 20; i++) {
    const { results } = client.query("bench", {
      vector: normalizedVector(dim),
      sparseVector: {
        indices: [0, 5, 10, 15, 20],
        values: [1, 0.8, 0.6, 0.4, 0.2],
      },
      topK: 10,
    });
    expect(results.length).toBe(10);
  }
  const queryTime = performance.now() - qStart;

  console.log(`[vectors 5k hybrid] insert: ${insertTime.toFixed(0)}ms, 20 queries: ${queryTime.toFixed(0)}ms (${(queryTime / 20).toFixed(2)}ms/query)`);
});

test("stress: delete and re-insert cycle", () => {
  client = new VectorClient();
  const dim = 64;
  const count = 2_000;

  client.createIndex({ name: "bench", dimension: dim, distanceMetric: "euclidean" });

  // Initial insert
  const vectors = Array.from({ length: count }, (_, i) => ({
    key: `vec-${i}`,
    vector: randomVector(dim),
  }));
  client.putVectors("bench", vectors);

  // Delete half
  const delStart = performance.now();
  const delKeys = Array.from({ length: count / 2 }, (_, i) => `vec-${i * 2}`);
  const deleted = client.deleteVectors("bench", delKeys);
  const delTime = performance.now() - delStart;
  expect(deleted).toBe(count / 2);

  // Re-insert
  const reinsert = Array.from({ length: count / 2 }, (_, i) => ({
    key: `vec-new-${i}`,
    vector: randomVector(dim),
  }));
  client.putVectors("bench", reinsert);

  // Query should still work
  const { results } = client.query("bench", { vector: randomVector(dim), topK: 10 });
  expect(results.length).toBe(10);

  let totalKeys = 0;
  let startAfter: string | undefined;
  do {
    const page = client.listVectors("bench", { maxKeys: 5000, startAfter });
    totalKeys += page.keys.length;
    startAfter = page.nextStartAfter;
    if (!page.isTruncated) break;
  } while (startAfter);
  expect(totalKeys).toBe(count); // half original + half new

  console.log(`[vectors delete/reinsert ${count}] delete ${count / 2}: ${delTime.toFixed(0)}ms`);
});
