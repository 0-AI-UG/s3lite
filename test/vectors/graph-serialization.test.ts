import { test, expect, afterEach } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { HNSWIndex } from "../../src/vectors/hnsw";
import { VectorStore } from "../../src/vectors/store";
import { computeNorm } from "../../src/vectors/distance";

const TEST_PATH = "/tmp/s3lite-graph-test";

function cleanup() {
  for (const suffix of ["", "-wal", ".tmp"]) {
    const p = TEST_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

afterEach(cleanup);

test("HNSWIndex serialize/deserialize round-trip preserves topology", () => {
  const index = new HNSWIndex(3, "cosine", 4, 50);
  const vectors = new Map<string, { vector: Float32Array; norm: number; metadata?: Record<string, unknown> }>();

  // Insert some vectors
  const data: [string, number[]][] = [
    ["a", [1, 0, 0]],
    ["b", [0, 1, 0]],
    ["c", [0, 0, 1]],
    ["d", [1, 1, 0]],
    ["e", [1, 0, 1]],
    ["f", [0, 1, 1]],
  ];

  for (const [key, vals] of data) {
    const vec = new Float32Array(vals);
    const meta = { label: key };
    index.insert(key, vec, meta);
    vectors.set(key, { vector: vec, norm: computeNorm(vec), metadata: meta });
  }

  // Serialize
  const serialized = index.serialize();
  expect(serialized.byteLength).toBeGreaterThan(0);

  // Deserialize
  const { index: restored, bytesRead } = HNSWIndex.deserialize(
    serialized, 0, vectors, 3, "cosine", 4, 50,
  );
  expect(bytesRead).toBe(serialized.byteLength);

  // Verify entry point and max layer match
  expect(restored.getEntryPoint()).toBe(index.getEntryPoint());
  expect(restored.getMaxLayer()).toBe(index.getMaxLayer());

  // Verify all nodes present
  expect(restored.size).toBe(index.size);

  // Verify search produces same results
  const query = new Float32Array([1, 0.5, 0]);
  const original = index.search(query, 3);
  const deserialized = restored.search(query, 3);
  expect(deserialized.map(r => r.key)).toEqual(original.map(r => r.key));
});

test("full checkpoint/recovery cycle preserves search results", () => {
  cleanup();

  // Create store with persistence, add vectors, close (triggers checkpoint)
  let store = new VectorStore(TEST_PATH, "off");
  store.createIndex({ name: "idx", dimension: 3, distanceMetric: "cosine" });
  store.putVectors("idx", [
    { key: "a", vector: [1, 0, 0], metadata: { label: "a" } },
    { key: "b", vector: [0, 1, 0], metadata: { label: "b" } },
    { key: "c", vector: [0, 0, 1], metadata: { label: "c" } },
    { key: "d", vector: [1, 1, 0], metadata: { label: "d" } },
    { key: "e", vector: [1, 0, 1], metadata: { label: "e" } },
  ]);

  // Search before close
  const queryVec = new Float32Array([1, 0.5, 0]);
  const beforeResults = store.query("idx", { vector: queryVec, topK: 3 });
  store.close();

  // Reopen — should use fast graph deserialization
  store = new VectorStore(TEST_PATH, "off");
  const afterResults = store.query("idx", { vector: queryVec, topK: 3 });

  expect(afterResults.results.map(r => r.key)).toEqual(beforeResults.results.map(r => r.key));
  // Scores may differ slightly due to float precision, so just check keys match
  store.close();
});

test("backward compatibility: v1 files (no graph) still load correctly", async () => {
  cleanup();

  let store = new VectorStore(TEST_PATH, "off");
  store.createIndex({ name: "idx", dimension: 3, distanceMetric: "cosine" });
  store.putVectors("idx", [
    { key: "a", vector: [1, 0, 0] },
    { key: "b", vector: [0, 1, 0] },
  ]);
  store.close();

  // Tamper with the file: overwrite version to 1 so it falls back to insert-based rebuild
  const fileData = await Bun.file(TEST_PATH).arrayBuffer();
  const buf = new Uint8Array(fileData);
  new DataView(buf.buffer).setUint32(4, 1, true);
  await Bun.write(TEST_PATH, buf);

  // Reopen — should fall back to insert-based rebuild
  store = new VectorStore(TEST_PATH, "off");
  const results = store.query("idx", { vector: new Float32Array([1, 0, 0]), topK: 2 });
  expect(results.results.length).toBe(2);
  expect(results.results[0]!.key).toBe("a");
  store.close();
});

test("mixed recovery: checkpoint with graph + WAL with new ops", () => {
  cleanup();

  // Create store, add initial vectors, checkpoint
  let store = new VectorStore(TEST_PATH, "off");
  store.createIndex({ name: "idx", dimension: 3, distanceMetric: "cosine" });
  store.putVectors("idx", [
    { key: "a", vector: [1, 0, 0] },
    { key: "b", vector: [0, 1, 0] },
    { key: "c", vector: [0, 0, 1] },
  ]);
  store.checkpoint(); // This writes the graph snapshot to main file

  // Add more vectors (these go to WAL only)
  store.putVectors("idx", [
    { key: "d", vector: [1, 1, 0] },
    { key: "e", vector: [1, 0, 1] },
  ]);

  // Simulate crash: close the fd without checkpointing
  const wal = (store as any).wal;
  if (wal?.walFd !== null) {
    const fs = require("node:fs");
    fs.closeSync(wal.walFd);
    wal.walFd = null;
  }

  // Reopen — should load graph from checkpoint + replay WAL for d and e
  store = new VectorStore(TEST_PATH, "off");

  const results = store.query("idx", { vector: new Float32Array([1, 0, 0]), topK: 5 });
  const keys = results.results.map(r => r.key);
  expect(keys).toContain("a");
  expect(keys).toContain("d");
  expect(keys).toContain("e");
  expect(results.results.length).toBe(5);

  store.close();
});

test("serialize/deserialize empty index", () => {
  const index = new HNSWIndex(3, "cosine");
  const serialized = index.serialize();

  const vectors = new Map<string, { vector: Float32Array; norm: number }>();
  const { index: restored } = HNSWIndex.deserialize(serialized, 0, vectors, 3, "cosine", 16, 200);

  expect(restored.size).toBe(0);
  expect(restored.getEntryPoint()).toBeNull();
  expect(restored.search(new Float32Array([1, 0, 0]), 5)).toEqual([]);
});
