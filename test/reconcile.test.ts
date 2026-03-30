import { test, expect, afterEach } from "bun:test";
import { Store } from "../src/store";
import { VectorStore } from "../src/vectors/store";
import { reconcile } from "../src/reconcile";

let s3Store: Store | null = null;
let vectorStore: VectorStore | null = null;

afterEach(() => {
  s3Store?.close();
  s3Store = null;
  vectorStore?.close();
  vectorStore = null;
});

test("reconcile detects orphaned vectors", () => {
  s3Store = new Store();
  vectorStore = new VectorStore();

  vectorStore.createIndex({ name: "idx", dimension: 3, distanceMetric: "cosine" });

  // Put objects and matching vectors
  s3Store.put("default", "a.txt", new Uint8Array([1]), "text/plain");
  s3Store.put("default", "b.txt", new Uint8Array([2]), "text/plain");
  vectorStore.putVectors("idx", [
    { key: "a.txt", vector: [1, 0, 0] },
    { key: "b.txt", vector: [0, 1, 0] },
    { key: "c.txt", vector: [0, 0, 1] }, // orphaned — no S3 object
  ]);

  const report = reconcile(s3Store, vectorStore, { indexName: "idx" });

  expect(report.orphanedVectors).toEqual(["c.txt"]);
  expect(report.orphanedObjects).toEqual([]);
  expect(report.removedVectors).toBe(0); // dryRun by default
});

test("reconcile detects orphaned S3 objects", () => {
  s3Store = new Store();
  vectorStore = new VectorStore();

  vectorStore.createIndex({ name: "idx", dimension: 3, distanceMetric: "cosine" });

  s3Store.put("default", "a.txt", new Uint8Array([1]), "text/plain");
  s3Store.put("default", "b.txt", new Uint8Array([2]), "text/plain"); // orphaned — no vector
  vectorStore.putVectors("idx", [
    { key: "a.txt", vector: [1, 0, 0] },
  ]);

  const report = reconcile(s3Store, vectorStore, { indexName: "idx" });

  expect(report.orphanedVectors).toEqual([]);
  expect(report.orphanedObjects).toEqual(["b.txt"]);
});

test("reconcile removes orphaned vectors when dryRun=false", () => {
  s3Store = new Store();
  vectorStore = new VectorStore();

  vectorStore.createIndex({ name: "idx", dimension: 3, distanceMetric: "cosine" });

  s3Store.put("default", "a.txt", new Uint8Array([1]), "text/plain");
  vectorStore.putVectors("idx", [
    { key: "a.txt", vector: [1, 0, 0] },
    { key: "orphan.txt", vector: [0, 1, 0] },
  ]);

  const report = reconcile(s3Store, vectorStore, { indexName: "idx", dryRun: false });

  expect(report.orphanedVectors).toEqual(["orphan.txt"]);
  expect(report.removedVectors).toBe(1);

  // Verify the vector was actually removed
  const vectors = vectorStore.getVectors("idx", ["orphan.txt"]);
  expect(vectors).toEqual([]);
});

test("reconcile with keyMapper", () => {
  s3Store = new Store();
  vectorStore = new VectorStore();

  vectorStore.createIndex({ name: "idx", dimension: 3, distanceMetric: "cosine" });

  // S3 keys have "docs/" prefix, vector keys don't
  s3Store.put("default", "docs/a.txt", new Uint8Array([1]), "text/plain");
  s3Store.put("default", "docs/b.txt", new Uint8Array([2]), "text/plain");
  vectorStore.putVectors("idx", [
    { key: "a.txt", vector: [1, 0, 0] },
    { key: "b.txt", vector: [0, 1, 0] },
  ]);

  const report = reconcile(s3Store, vectorStore, {
    indexName: "idx",
    keyMapper: (vectorKey) => `docs/${vectorKey}`,
  });

  expect(report.orphanedVectors).toEqual([]);
  expect(report.orphanedObjects).toEqual([]);
});

test("reconcile with custom bucket", () => {
  s3Store = new Store();
  vectorStore = new VectorStore();

  vectorStore.createIndex({ name: "idx", dimension: 3, distanceMetric: "cosine" });

  s3Store.put("mybucket", "a.txt", new Uint8Array([1]), "text/plain");
  vectorStore.putVectors("idx", [
    { key: "a.txt", vector: [1, 0, 0] },
  ]);

  const report = reconcile(s3Store, vectorStore, { indexName: "idx", bucket: "mybucket" });

  expect(report.orphanedVectors).toEqual([]);
  expect(report.orphanedObjects).toEqual([]);
});

test("reconcile with empty stores", () => {
  s3Store = new Store();
  vectorStore = new VectorStore();

  vectorStore.createIndex({ name: "idx", dimension: 3, distanceMetric: "cosine" });

  const report = reconcile(s3Store, vectorStore, { indexName: "idx" });

  expect(report.orphanedVectors).toEqual([]);
  expect(report.orphanedObjects).toEqual([]);
  expect(report.removedVectors).toBe(0);
});
