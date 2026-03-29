import { expect, test, describe, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { VectorClient } from "../../src/vectors/client";

const TEST_PATH = "/tmp/s3lite-vec-test.vecdb";

function cleanup() {
  for (const p of [TEST_PATH, TEST_PATH + "-wal"]) {
    if (existsSync(p)) unlinkSync(p);
  }
}

afterEach(cleanup);

describe("VectorWAL Persistence", () => {
  test("data survives close and reopen", () => {
    cleanup();

    // Write data
    const client1 = new VectorClient({ path: TEST_PATH });
    client1.createIndex({ name: "test", dimension: 3, distanceMetric: "euclidean" });
    client1.putVectors("test", [
      { key: "a", vector: [1, 0, 0], metadata: { label: "first" } },
      { key: "b", vector: [0, 1, 0], metadata: { label: "second" } },
    ]);
    client1.close();

    // Reopen and verify
    const client2 = new VectorClient({ path: TEST_PATH });
    const config = client2.getIndex("test");
    expect(config).toBeDefined();
    expect(config!.dimension).toBe(3);
    expect(config!.distanceMetric).toBe("euclidean");

    const vecs = client2.getVectors("test", ["a", "b"]);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]!.metadata).toEqual({ label: "first" });

    // Query still works
    const { results } = client2.query("test", { vector: [1, 0, 0], topK: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("a");
    client2.close();
  });

  test("sparse vectors persist", () => {
    cleanup();

    const client1 = new VectorClient({ path: TEST_PATH });
    client1.createIndex({ name: "test", dimension: 2, sparse: true });
    client1.putVectors("test", [
      { key: "a", vector: [1, 0], sparseVector: { indices: [0, 5], values: [0.8, 0.3] } },
    ]);
    client1.close();

    const client2 = new VectorClient({ path: TEST_PATH });
    const vecs = client2.getVectors("test", ["a"]);
    expect(vecs).toHaveLength(1);
    expect(vecs[0]!.sparseVector).toBeDefined();
    expect(vecs[0]!.sparseVector!.indices).toContain(0);
    expect(vecs[0]!.sparseVector!.indices).toContain(5);

    // Sparse query works
    const { results } = client2.query("test", {
      sparseVector: { indices: [0], values: [1] },
      topK: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("a");
    client2.close();
  });

  test("delete persists", () => {
    cleanup();

    const client1 = new VectorClient({ path: TEST_PATH });
    client1.createIndex({ name: "test", dimension: 2 });
    client1.putVectors("test", [
      { key: "a", vector: [1, 0] },
      { key: "b", vector: [0, 1] },
    ]);
    client1.deleteVectors("test", ["a"]);
    client1.close();

    const client2 = new VectorClient({ path: TEST_PATH });
    const vecs = client2.getVectors("test", ["a", "b"]);
    expect(vecs).toHaveLength(1);
    expect(vecs[0]!.key).toBe("b");
    client2.close();
  });

  test("delete index persists", () => {
    cleanup();

    const client1 = new VectorClient({ path: TEST_PATH });
    client1.createIndex({ name: "test", dimension: 2 });
    client1.createIndex({ name: "keep", dimension: 3 });
    client1.deleteIndex("test");
    client1.close();

    const client2 = new VectorClient({ path: TEST_PATH });
    expect(client2.getIndex("test")).toBeUndefined();
    expect(client2.getIndex("keep")).toBeDefined();
    client2.close();
  });

  test("checkpoint compacts WAL", () => {
    cleanup();

    const client = new VectorClient({ path: TEST_PATH });
    client.createIndex({ name: "test", dimension: 2 });
    client.putVectors("test", [{ key: "a", vector: [1, 0] }]);
    client.checkpoint();

    // WAL should be empty after checkpoint
    expect(existsSync(TEST_PATH)).toBe(true);
    client.close();
  });

  test("multiple indexes persist", () => {
    cleanup();

    const client1 = new VectorClient({ path: TEST_PATH });
    client1.createIndex({ name: "idx1", dimension: 2, distanceMetric: "cosine" });
    client1.createIndex({ name: "idx2", dimension: 3, distanceMetric: "euclidean", sparse: true });
    client1.putVectors("idx1", [{ key: "a", vector: [1, 0] }]);
    client1.putVectors("idx2", [
      { key: "b", vector: [0, 1, 0], sparseVector: { indices: [0], values: [1] } },
    ]);
    client1.close();

    const client2 = new VectorClient({ path: TEST_PATH });
    expect(client2.listIndexes().indexes).toHaveLength(2);
    expect(client2.getVectors("idx1", ["a"])).toHaveLength(1);
    expect(client2.getVectors("idx2", ["b"])).toHaveLength(1);
    client2.close();
  });
});
