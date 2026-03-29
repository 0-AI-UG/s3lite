import { expect, test, describe } from "bun:test";
import { SparseIndex } from "../../src/vectors/sparse";

describe("SparseIndex", () => {
  test("insert and search", () => {
    const idx = new SparseIndex();
    idx.insert("a", { indices: [0, 1, 2], values: [1, 0.5, 0.3] });
    idx.insert("b", { indices: [0, 3], values: [0.2, 0.9] });
    idx.insert("c", { indices: [1, 2], values: [0.8, 0.7] });

    // Query shares dims 0 and 1 with various docs
    const results = idx.search({ indices: [0, 1], values: [1, 1] }, 3);
    expect(results.length).toBeGreaterThan(0);
    // "a" has dot = 1*1 + 0.5*1 = 1.5
    // "b" has dot = 0.2*1 = 0.2
    // "c" has dot = 0.8*1 = 0.8
    // After negation and sort: a (best), c, b
    expect(results[0]!.key).toBe("a");
    expect(results[1]!.key).toBe("c");
    expect(results[2]!.key).toBe("b");
  });

  test("remove vector", () => {
    const idx = new SparseIndex();
    idx.insert("a", { indices: [0], values: [1] });
    idx.insert("b", { indices: [0], values: [0.5] });

    expect(idx.size).toBe(2);
    idx.remove("a");
    expect(idx.size).toBe(1);

    const results = idx.search({ indices: [0], values: [1] }, 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("b");
  });

  test("search with filter", () => {
    const idx = new SparseIndex();
    idx.insert("a", { indices: [0], values: [1] });
    idx.insert("b", { indices: [0], values: [0.9] });

    const results = idx.search({ indices: [0], values: [1] }, 5, (key) => key !== "a");
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("b");
  });

  test("no shared dimensions returns empty", () => {
    const idx = new SparseIndex();
    idx.insert("a", { indices: [0], values: [1] });

    const results = idx.search({ indices: [99], values: [1] }, 5);
    expect(results).toHaveLength(0);
  });

  test("topK limits results", () => {
    const idx = new SparseIndex();
    for (let i = 0; i < 10; i++) {
      idx.insert(`v${i}`, { indices: [0], values: [i + 1] });
    }

    const results = idx.search({ indices: [0], values: [1] }, 3);
    expect(results).toHaveLength(3);
  });

  test("overwrite existing key", () => {
    const idx = new SparseIndex();
    idx.insert("a", { indices: [0], values: [1] });
    idx.insert("a", { indices: [1], values: [2] });

    expect(idx.size).toBe(1);
    // Old dim 0 should be cleaned up
    const results = idx.search({ indices: [0], values: [1] }, 5);
    expect(results).toHaveLength(0);

    const results2 = idx.search({ indices: [1], values: [1] }, 5);
    expect(results2).toHaveLength(1);
    expect(results2[0]!.key).toBe("a");
  });

  test("getSparseVector", () => {
    const idx = new SparseIndex();
    idx.insert("a", { indices: [3, 7], values: [0.5, 0.9] });

    const sv = idx.getSparseVector("a");
    expect(sv).toBeDefined();
    expect(sv!.indices).toContain(3);
    expect(sv!.indices).toContain(7);
  });

  test("getSparseVector returns undefined for missing", () => {
    const idx = new SparseIndex();
    expect(idx.getSparseVector("missing")).toBeUndefined();
  });

  test("empty index returns empty", () => {
    const idx = new SparseIndex();
    expect(idx.search({ indices: [0], values: [1] }, 5)).toEqual([]);
  });
});
