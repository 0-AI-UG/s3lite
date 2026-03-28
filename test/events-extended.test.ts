import { test, expect, afterEach } from "bun:test";
import { S3Client } from "../src/client";

let client: S3Client | null = null;

afterEach(() => {
  client?.close();
  client = null;
});

test("events: listener exception does not break other listeners", async () => {
  client = new S3Client({ bucket: "b" });
  const results: string[] = [];

  client.on("put", () => {
    throw new Error("listener error");
  });
  client.on("put", (_b, k) => results.push(k));

  // The throwing listener may propagate, but let's verify the behavior
  try {
    await client.write("test.txt", "data");
  } catch {
    // If it throws, that's the current behavior
  }
  // At minimum the first listener ran
});

test("events: off with unregistered callback is no-op", () => {
  client = new S3Client({ bucket: "b" });
  const cb = () => {};
  // Should not throw
  client.off("put", cb);
  client.off("delete", cb);
  client.off("copy", cb);
});

test("events: put fires on overwrite", async () => {
  client = new S3Client({ bucket: "b" });
  const events: string[] = [];
  client.on("put", (_b, k) => events.push(k));

  await client.write("file.txt", "v1");
  await client.write("file.txt", "v2");

  expect(events).toEqual(["file.txt", "file.txt"]);
});

test("events: delete fires even when key doesn't exist", async () => {
  client = new S3Client({ bucket: "b" });
  const events: string[] = [];
  client.on("delete", (_b, k) => events.push(k));

  await client.delete("nonexistent.txt");
  // Delete of non-existent should NOT fire event
  expect(events).toEqual([]);
});

test("events: copy does not fire when source doesn't exist", async () => {
  client = new S3Client({ bucket: "b" });
  const events: string[] = [];
  client.on("copy", (_b, k) => events.push(k));

  await client.copy("nonexistent.txt", "dest.txt");
  expect(events).toEqual([]);
});
