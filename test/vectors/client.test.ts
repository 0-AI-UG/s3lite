import { expect, test, describe } from "bun:test";
import { VectorClient } from "../../src/vectors/client";

describe("VectorClient", () => {
  test("full workflow", () => {
    const client = new VectorClient();

    // Create index
    const config = client.createIndex({ name: "movies", dimension: 3, distanceMetric: "euclidean" });
    expect(config.name).toBe("movies");

    // List indexes
    expect(client.listIndexes().indexes).toHaveLength(1);

    // Put vectors
    client.putVectors("movies", [
      { key: "star-wars", vector: [1, 0, 0], metadata: { genre: "scifi" } },
      { key: "titanic", vector: [0, 1, 0], metadata: { genre: "drama" } },
      { key: "alien", vector: [0.9, 0.1, 0], metadata: { genre: "scifi" } },
    ]);

    // Get vectors
    const vecs = client.getVectors("movies", ["star-wars", "titanic"]);
    expect(vecs).toHaveLength(2);

    // Query
    const { results } = client.query("movies", { vector: [1, 0, 0], topK: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]!.key).toBe("star-wars");

    // List vectors
    const list = client.listVectors("movies");
    expect(list.keys).toHaveLength(3);

    // Delete vectors
    expect(client.deleteVectors("movies", ["titanic"])).toBe(1);
    expect(client.listVectors("movies").keys).toHaveLength(2);

    // Delete index
    expect(client.deleteIndex("movies")).toBe(true);
    expect(client.listIndexes().indexes).toHaveLength(0);
  });

  test("events work through client", () => {
    const client = new VectorClient();
    const events: string[] = [];
    client.on("createIndex", (name) => events.push(name));
    client.createIndex({ name: "test", dimension: 2 });
    expect(events).toEqual(["test"]);

    client.off("createIndex", () => {});
  });

  test("get index returns undefined for missing", () => {
    const client = new VectorClient();
    expect(client.getIndex("nope")).toBeUndefined();
  });
});
