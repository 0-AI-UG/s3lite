import { expect, test, describe } from "bun:test";
import { HNSWIndex } from "../../src/vectors/hnsw";

function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1;
  return v;
}

describe("HNSWIndex", () => {
  test("insert and search single vector", () => {
    const idx = new HNSWIndex(3, "euclidean", 4, 16);
    idx.insert("a", new Float32Array([1, 0, 0]));

    const results = idx.search(new Float32Array([1, 0, 0]), 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("a");
    expect(results[0]!.score).toBeCloseTo(0);
  });

  test("nearest neighbor is correct (euclidean)", () => {
    const idx = new HNSWIndex(2, "euclidean", 4, 16);
    idx.insert("a", new Float32Array([0, 0]));
    idx.insert("b", new Float32Array([10, 10]));
    idx.insert("c", new Float32Array([1, 0.1]));

    const results = idx.search(new Float32Array([1, 0]), 1);
    expect(results[0]!.key).toBe("c");
  });

  test("nearest neighbor is correct (cosine)", () => {
    const idx = new HNSWIndex(3, "cosine", 4, 16);
    idx.insert("a", new Float32Array([1, 0, 0]));
    idx.insert("b", new Float32Array([0, 1, 0]));
    idx.insert("c", new Float32Array([0.9, 0.1, 0]));

    const results = idx.search(new Float32Array([1, 0, 0]), 1);
    expect(results[0]!.key).toBe("a");
  });

  test("topK returns correct count", () => {
    const idx = new HNSWIndex(2, "euclidean", 4, 16);
    for (let i = 0; i < 20; i++) {
      idx.insert(`v${i}`, new Float32Array([i, 0]));
    }

    const results = idx.search(new Float32Array([5, 0]), 3);
    expect(results).toHaveLength(3);
    expect(results[0]!.key).toBe("v5");
  });

  test("remove vector", () => {
    const idx = new HNSWIndex(2, "euclidean", 4, 16);
    idx.insert("a", new Float32Array([0, 0]));
    idx.insert("b", new Float32Array([1, 1]));

    expect(idx.size).toBe(2);
    idx.remove("a");
    expect(idx.size).toBe(1);

    const results = idx.search(new Float32Array([0, 0]), 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("b");
  });

  test("re-insert after remove", () => {
    const idx = new HNSWIndex(2, "euclidean", 4, 16);
    idx.insert("a", new Float32Array([0, 0]));
    idx.remove("a");
    idx.insert("a", new Float32Array([5, 5]));

    const results = idx.search(new Float32Array([5, 5]), 1);
    expect(results[0]!.key).toBe("a");
    expect(results[0]!.score).toBeCloseTo(0);
  });

  test("search with metadata filter", () => {
    const idx = new HNSWIndex(2, "euclidean", 4, 16);
    idx.insert("a", new Float32Array([0, 0]), { genre: "scifi" });
    idx.insert("b", new Float32Array([1, 0]), { genre: "drama" });
    idx.insert("c", new Float32Array([2, 0]), { genre: "scifi" });

    const results = idx.search(new Float32Array([0, 0]), 5, 16, { genre: "scifi" });
    expect(results).toHaveLength(2);
    expect(results[0]!.key).toBe("a");
    expect(results[1]!.key).toBe("c");
  });

  test("empty index returns empty results", () => {
    const idx = new HNSWIndex(3, "cosine");
    expect(idx.search(new Float32Array([1, 0, 0]), 5)).toEqual([]);
  });

  test("dimension mismatch throws on insert", () => {
    const idx = new HNSWIndex(3);
    expect(() => idx.insert("a", new Float32Array([1, 0]))).toThrow(/dimension/i);
  });

  test("dimension mismatch throws on search", () => {
    const idx = new HNSWIndex(3);
    idx.insert("a", new Float32Array([1, 0, 0]));
    expect(() => idx.search(new Float32Array([1, 0]), 1)).toThrow(/dimension/i);
  });

  test("larger dataset recall", () => {
    const dim = 32;
    const n = 500;
    const idx = new HNSWIndex(dim, "euclidean", 16, 200);

    const vectors: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      const v = randomVector(dim);
      vectors.push(v);
      idx.insert(`v${i}`, v);
    }

    // Query with one of the inserted vectors — it should be the top result
    const queryIdx = Math.floor(Math.random() * n);
    const results = idx.search(vectors[queryIdx]!, 1, 128);
    expect(results[0]!.key).toBe(`v${queryIdx}`);
    expect(results[0]!.score).toBeCloseTo(0, 1);
  });

  test("dotproduct metric", () => {
    const idx = new HNSWIndex(3, "dotproduct", 4, 16);
    idx.insert("a", new Float32Array([1, 0, 0]));
    idx.insert("b", new Float32Array([0, 1, 0]));
    idx.insert("c", new Float32Array([0.5, 0.5, 0]));

    // Query [1,0,0]: dot with a=1, c=0.5, b=0. Negated: a=-1, c=-0.5, b=0
    const results = idx.search(new Float32Array([1, 0, 0]), 3);
    expect(results[0]!.key).toBe("a");
  });

  test("overwrite existing key", () => {
    const idx = new HNSWIndex(2, "euclidean", 4, 16);
    idx.insert("a", new Float32Array([0, 0]));
    idx.insert("a", new Float32Array([10, 10]));

    expect(idx.size).toBe(1);
    const results = idx.search(new Float32Array([10, 10]), 1);
    expect(results[0]!.key).toBe("a");
    expect(results[0]!.score).toBeCloseTo(0);
  });
});
