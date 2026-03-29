import { expect, test, describe } from "bun:test";
import { VectorStore } from "../../src/vectors/store";

describe("VectorStore - Dense Query", () => {
  test("basic similarity search", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 3, distanceMetric: "euclidean" });
    store.putVectors("test", [
      { key: "a", vector: [0, 0, 0] },
      { key: "b", vector: [10, 10, 10] },
      { key: "c", vector: [1, 0.1, 0] },
    ]);

    const { results } = store.query("test", { vector: [1, 0, 0], topK: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]!.key).toBe("c");
    expect(results[1]!.key).toBe("a");
  });

  test("query with metadata filter", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 2, distanceMetric: "euclidean" });
    store.putVectors("test", [
      { key: "a", vector: [0, 0], metadata: { genre: "scifi" } },
      { key: "b", vector: [1, 0], metadata: { genre: "drama" } },
      { key: "c", vector: [2, 0], metadata: { genre: "scifi" } },
    ]);

    const { results } = store.query("test", {
      vector: [0, 0],
      topK: 5,
      filter: { genre: "scifi" },
    });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.metadata?.genre === "scifi")).toBe(true);
  });

  test("includeVectors option", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 2 });
    store.putVectors("test", [{ key: "a", vector: [1, 0] }]);

    const without = store.query("test", { vector: [1, 0], topK: 1 });
    expect(without.results[0]!.vector).toBeUndefined();

    const with_ = store.query("test", { vector: [1, 0], topK: 1, includeVectors: true });
    expect(with_.results[0]!.vector).toBeInstanceOf(Float32Array);
  });

  test("includeMetadata false", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 2 });
    store.putVectors("test", [{ key: "a", vector: [1, 0], metadata: { x: 1 } }]);

    const { results } = store.query("test", { vector: [1, 0], topK: 1, includeMetadata: false });
    expect(results[0]!.metadata).toBeUndefined();
  });

  test("no query vector or sparse vector throws", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 2 });
    expect(() => store.query("test", { topK: 1 })).toThrow(/at least one/i);
  });
});

describe("VectorStore - Sparse Query", () => {
  test("basic sparse search", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 3, sparse: true });
    store.putVectors("test", [
      { key: "a", vector: [1, 0, 0], sparseVector: { indices: [0, 1], values: [1, 0.5] } },
      { key: "b", vector: [0, 1, 0], sparseVector: { indices: [0, 2], values: [0.2, 0.9] } },
      { key: "c", vector: [0, 0, 1], sparseVector: { indices: [1], values: [0.8] } },
    ]);

    const { results } = store.query("test", {
      sparseVector: { indices: [0], values: [1] },
      topK: 2,
    });
    expect(results).toHaveLength(2);
    expect(results[0]!.key).toBe("a"); // dot = 1
    expect(results[1]!.key).toBe("b"); // dot = 0.2
  });

  test("sparse query without sparse index throws", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 2, sparse: false });
    expect(() =>
      store.query("test", { sparseVector: { indices: [0], values: [1] }, topK: 1 })
    ).toThrow(/sparse/i);
  });
});
