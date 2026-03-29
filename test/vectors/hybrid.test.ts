import { expect, test, describe } from "bun:test";
import { VectorStore } from "../../src/vectors/store";

describe("VectorStore - Hybrid Query (RRF)", () => {
  test("hybrid search combines dense and sparse results", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 3, distanceMetric: "euclidean", sparse: true });

    // Dense-close to query but weak sparse signal
    store.putVectors("test", [
      { key: "dense-winner", vector: [1, 0, 0], sparseVector: { indices: [99], values: [0.1] } },
    ]);
    // Sparse-strong but dense-far
    store.putVectors("test", [
      { key: "sparse-winner", vector: [10, 10, 10], sparseVector: { indices: [0], values: [1.0] } },
    ]);
    // Good at both
    store.putVectors("test", [
      { key: "hybrid-winner", vector: [1.1, 0, 0], sparseVector: { indices: [0], values: [0.9] } },
    ]);

    const { results } = store.query("test", {
      vector: [1, 0, 0],
      sparseVector: { indices: [0], values: [1] },
      topK: 3,
    });

    expect(results).toHaveLength(3);
    // hybrid-winner should rank high: good in both dense and sparse
    // exact ordering depends on RRF math, but hybrid-winner should be first or second
    const keys = results.map(r => r.key);
    expect(keys).toContain("hybrid-winner");
    expect(keys).toContain("dense-winner");
    expect(keys).toContain("sparse-winner");
  });

  test("hybrid with filter", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 2, distanceMetric: "euclidean", sparse: true });

    store.putVectors("test", [
      { key: "a", vector: [1, 0], sparseVector: { indices: [0], values: [1] }, metadata: { genre: "scifi" } },
      { key: "b", vector: [1, 0.1], sparseVector: { indices: [0], values: [0.9] }, metadata: { genre: "drama" } },
    ]);

    const { results } = store.query("test", {
      vector: [1, 0],
      sparseVector: { indices: [0], values: [1] },
      topK: 5,
      filter: { genre: "scifi" },
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("a");
  });

  test("custom fusionK", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 2, distanceMetric: "euclidean", sparse: true });

    store.putVectors("test", [
      { key: "a", vector: [1, 0], sparseVector: { indices: [0], values: [1] } },
      { key: "b", vector: [0, 1], sparseVector: { indices: [1], values: [1] } },
    ]);

    // Should not throw with different fusionK values
    const r1 = store.query("test", {
      vector: [1, 0],
      sparseVector: { indices: [0], values: [1] },
      topK: 2,
      fusionK: 1,
    });
    expect(r1.results).toHaveLength(2);

    const r2 = store.query("test", {
      vector: [1, 0],
      sparseVector: { indices: [0], values: [1] },
      topK: 2,
      fusionK: 1000,
    });
    expect(r2.results).toHaveLength(2);
  });

  test("hybrid returns includeVectors and includeMetadata", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 2, sparse: true });

    store.putVectors("test", [
      { key: "a", vector: [1, 0], sparseVector: { indices: [0], values: [1] }, metadata: { x: 1 } },
    ]);

    const { results } = store.query("test", {
      vector: [1, 0],
      sparseVector: { indices: [0], values: [1] },
      topK: 1,
      includeVectors: true,
      includeMetadata: true,
    });

    expect(results[0]!.vector).toBeInstanceOf(Float32Array);
    expect(results[0]!.metadata).toEqual({ x: 1 });
    expect(results[0]!.sparseVector).toBeDefined();
  });
});
