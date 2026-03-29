import { expect, test, describe } from "bun:test";
import { VectorStore } from "../../src/vectors/store";

describe("VectorStore - Index Management", () => {
  test("createIndex and getIndex", () => {
    const store = new VectorStore();
    const config = store.createIndex({ name: "test", dimension: 128 });

    expect(config.name).toBe("test");
    expect(config.dimension).toBe(128);
    expect(config.distanceMetric).toBe("cosine");
    expect(config.sparse).toBe(false);

    const retrieved = store.getIndex("test");
    expect(retrieved).toEqual(config);
  });

  test("createIndex with all options", () => {
    const store = new VectorStore();
    const config = store.createIndex({
      name: "full",
      dimension: 256,
      distanceMetric: "euclidean",
      sparse: true,
      hnswConfig: { M: 32, efConstruction: 400 },
    });

    expect(config.distanceMetric).toBe("euclidean");
    expect(config.sparse).toBe(true);
    expect(config.hnswConfig.M).toBe(32);
    expect(config.hnswConfig.efConstruction).toBe(400);
  });

  test("duplicate index throws", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 128 });
    expect(() => store.createIndex({ name: "test", dimension: 128 })).toThrow(/already exists/i);
  });

  test("deleteIndex", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 128 });
    expect(store.deleteIndex("test")).toBe(true);
    expect(store.getIndex("test")).toBeUndefined();
    expect(store.deleteIndex("test")).toBe(false);
  });

  test("listIndexes", () => {
    const store = new VectorStore();
    store.createIndex({ name: "a", dimension: 64 });
    store.createIndex({ name: "b", dimension: 128 });

    const { indexes } = store.listIndexes();
    expect(indexes).toHaveLength(2);
    expect(indexes.map(i => i.name).sort()).toEqual(["a", "b"]);
  });
});

describe("VectorStore - Vector CRUD", () => {
  test("putVectors and getVectors", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 3 });

    store.putVectors("test", [
      { key: "a", vector: [1, 0, 0], metadata: { label: "x" } },
      { key: "b", vector: [0, 1, 0] },
    ]);

    const results = store.getVectors("test", ["a", "b", "missing"]);
    expect(results).toHaveLength(2);
    expect(results[0]!.key).toBe("a");
    expect(results[0]!.metadata).toEqual({ label: "x" });
    expect(results[0]!.vector).toBeInstanceOf(Float32Array);
  });

  test("dimension mismatch throws", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 3 });
    expect(() => store.putVectors("test", [{ key: "a", vector: [1, 0] }])).toThrow(/dimension/i);
  });

  test("sparse without sparse index throws", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 3, sparse: false });
    expect(() =>
      store.putVectors("test", [{ key: "a", vector: [1, 0, 0], sparseVector: { indices: [0], values: [1] } }])
    ).toThrow(/sparse/i);
  });

  test("deleteVectors", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 3 });
    store.putVectors("test", [{ key: "a", vector: [1, 0, 0] }]);

    expect(store.deleteVectors("test", ["a"])).toBe(1);
    expect(store.getVectors("test", ["a"])).toHaveLength(0);
    expect(store.deleteVectors("test", ["a"])).toBe(0);
  });

  test("listVectors", () => {
    const store = new VectorStore();
    store.createIndex({ name: "test", dimension: 2 });
    store.putVectors("test", [
      { key: "alpha", vector: [1, 0] },
      { key: "beta", vector: [0, 1] },
      { key: "alpha2", vector: [1, 1] },
    ]);

    const all = store.listVectors("test");
    expect(all.keys).toHaveLength(3);

    const filtered = store.listVectors("test", { prefix: "alpha" });
    expect(filtered.keys).toHaveLength(2);

    const limited = store.listVectors("test", { maxKeys: 2 });
    expect(limited.keys).toHaveLength(2);
    expect(limited.isTruncated).toBe(true);
    expect(limited.nextStartAfter).toBeDefined();
  });

  test("index not found throws", () => {
    const store = new VectorStore();
    expect(() => store.putVectors("missing", [{ key: "a", vector: [1] }])).toThrow(/not found/i);
  });
});

describe("VectorStore - Events", () => {
  test("emits events", () => {
    const store = new VectorStore();
    const events: string[] = [];

    store.on("createIndex", (name) => events.push(`create:${name}`));
    store.on("putVectors", (name, keys) => events.push(`put:${name}:${keys?.join(",")}`));
    store.on("deleteVectors", (name) => events.push(`delete:${name}`));
    store.on("deleteIndex", (name) => events.push(`deleteIdx:${name}`));

    store.createIndex({ name: "test", dimension: 2 });
    store.putVectors("test", [{ key: "a", vector: [1, 0] }]);
    store.deleteVectors("test", ["a"]);
    store.deleteIndex("test");

    expect(events).toEqual(["create:test", "put:test:a", "delete:test", "deleteIdx:test"]);
  });

  test("off removes listener", () => {
    const store = new VectorStore();
    const events: string[] = [];
    const cb = (name: string) => events.push(name);

    store.on("createIndex", cb);
    store.createIndex({ name: "a", dimension: 2 });
    store.off("createIndex", cb);
    store.createIndex({ name: "b", dimension: 2 });

    expect(events).toEqual(["a"]);
  });
});
