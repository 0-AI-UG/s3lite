import { test, expect, afterEach } from "bun:test";
import { S3Client } from "../src/client";
import { Store } from "../src/store";
import { NetworkSink } from "../src/sink";

let client: S3Client | null = null;

afterEach(() => {
  client?.close();
  client = null;
});

// --- Store error handling ---

test("Store: get non-existent key returns undefined", () => {
  const store = new Store();
  expect(store.get("b", "nope")).toBeUndefined();
});

test("Store: get from non-existent bucket returns undefined", () => {
  const store = new Store();
  expect(store.get("no-bucket", "no-key")).toBeUndefined();
});

test("Store: delete non-existent key returns false", () => {
  const store = new Store();
  expect(store.delete("b", "nope")).toBe(false);
});

test("Store: delete from non-existent bucket returns false", () => {
  const store = new Store();
  expect(store.delete("no-bucket", "key")).toBe(false);
});

test("Store: stat non-existent key returns undefined", () => {
  const store = new Store();
  expect(store.stat("b", "nope")).toBeUndefined();
});

test("Store: exists non-existent bucket returns false", () => {
  const store = new Store();
  expect(store.exists("no-bucket", "key")).toBe(false);
});

test("Store: getRange non-existent key returns undefined", () => {
  const store = new Store();
  expect(store.getRange("b", "nope", 0, 5)).toBeUndefined();
});

test("Store: list empty bucket", () => {
  const store = new Store();
  const result = store.list("empty-bucket");
  expect(result.contents).toBeUndefined();
  expect(result.keyCount).toBe(0);
  expect(result.isTruncated).toBe(false);
});

// --- S3File error handling ---

test("S3File: text() throws for non-existent file", async () => {
  client = new S3Client({ bucket: "b" });
  const file = client.file("ghost.txt");
  expect(file.text()).rejects.toThrow("not found");
});

test("S3File: bytes() throws for non-existent file", async () => {
  client = new S3Client({ bucket: "b" });
  const file = client.file("ghost.txt");
  expect(file.bytes()).rejects.toThrow("not found");
});

test("S3File: json() throws for non-existent file", async () => {
  client = new S3Client({ bucket: "b" });
  const file = client.file("ghost.txt");
  expect(file.json()).rejects.toThrow();
});

test("S3File: stat() throws for non-existent file", () => {
  client = new S3Client({ bucket: "b" });
  const file = client.file("ghost.txt");
  expect(() => file.stat()).toThrow("not found");
});

test("S3File: exists() returns false for non-existent file", () => {
  client = new S3Client({ bucket: "b" });
  expect(client.file("ghost.txt").exists()).toBe(false);
});

test("S3File: size returns 0 for non-existent file", () => {
  client = new S3Client({ bucket: "b" });
  expect(client.file("ghost.txt").size).toBe(0);
});

test("S3File: delete non-existent file does not throw", () => {
  client = new S3Client({ bucket: "b" });
  client.file("ghost.txt").delete(); // should not throw
});

test("S3File: stream() throws for non-existent file", () => {
  client = new S3Client({ bucket: "b" });
  expect(() => client!.file("ghost.txt").stream()).toThrow("not found");
});

test("S3File: presign() always throws", () => {
  client = new S3Client({ bucket: "b" });
  expect(() => client!.file("test.txt").presign()).toThrow("not supported");
});

// --- NetworkSink error handling ---

test("NetworkSink: stat throws for non-existent file", async () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "missing.txt");
  expect(sink.stat()).rejects.toThrow("not found");
});

test("NetworkSink: end with no writes stores empty data", async () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "empty.txt");
  const size = await sink.end();
  expect(size).toBe(0);
  expect(store.exists("b", "empty.txt")).toBe(true);
  expect(store.get("b", "empty.txt")!.size).toBe(0);
});

// --- Client: unlink alias ---

test("S3Client: unlink is an alias for delete", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("alias.txt", "data");
  expect(client.exists("alias.txt")).toBe(true);
  client.unlink("alias.txt");
  expect(client.exists("alias.txt")).toBe(false);
});
