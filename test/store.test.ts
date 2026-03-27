import { test, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "../src/store";
import { rmSync, existsSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-store-test.s3db";

function cleanup() {
  for (const p of [TEST_PATH, TEST_PATH + "-wal", TEST_PATH + "-blobs"]) {
    if (existsSync(p)) rmSync(p);
  }
}

beforeEach(cleanup);
afterEach(cleanup);

test("Store: in-memory put and get", () => {
  const store = new Store();
  const data = new TextEncoder().encode("hello");
  store.put("b", "key.txt", data, "text/plain");

  const obj = store.get("b", "key.txt");
  expect(obj).toBeDefined();
  expect(new TextDecoder().decode(obj!.data!)).toBe("hello");
  expect(obj!.contentType).toBe("text/plain");
  expect(obj!.etag).toMatch(/^"[a-f0-9]+"$/);
});

test("Store: exists and delete", () => {
  const store = new Store();
  const data = new TextEncoder().encode("data");
  store.put("b", "file.txt", data);

  expect(store.exists("b", "file.txt")).toBe(true);
  expect(store.exists("b", "nope.txt")).toBe(false);

  store.delete("b", "file.txt");
  expect(store.exists("b", "file.txt")).toBe(false);
});

test("Store: stat", () => {
  const store = new Store();
  const data = new TextEncoder().encode("test data");
  store.put("b", "stat.txt", data, "text/plain");

  const s = store.stat("b", "stat.txt");
  expect(s).toBeDefined();
  expect(s!.size).toBe(9);
  expect(s!.type).toBe("text/plain");
  expect(s!.lastModified).toBeInstanceOf(Date);
});

test("Store: getRange", () => {
  const store = new Store();
  const data = new TextEncoder().encode("hello world");
  store.put("b", "range.txt", data);

  const slice = store.getRange("b", "range.txt", 0, 5);
  expect(new TextDecoder().decode(slice!)).toBe("hello");
});

test("Store: list with prefix", () => {
  const store = new Store();
  store.put("b", "a/1.txt", new TextEncoder().encode("1"));
  store.put("b", "a/2.txt", new TextEncoder().encode("2"));
  store.put("b", "b/3.txt", new TextEncoder().encode("3"));

  const result = store.list("b", { prefix: "a/" });
  expect(result.contents).toHaveLength(2);
  expect(result.contents![0].key).toBe("a/1.txt");
  expect(result.contents![1].key).toBe("a/2.txt");
});

test("Store: list with delimiter", () => {
  const store = new Store();
  store.put("b", "photos/2024/a.jpg", new TextEncoder().encode("a"));
  store.put("b", "photos/2024/b.jpg", new TextEncoder().encode("b"));
  store.put("b", "photos/2025/c.jpg", new TextEncoder().encode("c"));

  const result = store.list("b", { prefix: "photos/", delimiter: "/" });
  expect(result.commonPrefixes).toBeDefined();
  expect(result.commonPrefixes!.map((p) => p.prefix).sort()).toEqual([
    "photos/2024/",
    "photos/2025/",
  ]);
  expect(result.contents).toBeUndefined();
});

test("Store: list with startAfter", () => {
  const store = new Store();
  store.put("b", "a.txt", new TextEncoder().encode("a"));
  store.put("b", "b.txt", new TextEncoder().encode("b"));
  store.put("b", "c.txt", new TextEncoder().encode("c"));

  const result = store.list("b", { startAfter: "a.txt" });
  expect(result.contents).toHaveLength(2);
  expect(result.contents![0].key).toBe("b.txt");
});

test("Store: list with maxKeys and isTruncated", () => {
  const store = new Store();
  store.put("b", "a.txt", new TextEncoder().encode("a"));
  store.put("b", "b.txt", new TextEncoder().encode("b"));
  store.put("b", "c.txt", new TextEncoder().encode("c"));

  const result = store.list("b", { maxKeys: 2 });
  expect(result.contents).toHaveLength(2);
  expect(result.isTruncated).toBe(true);
});

test("Store: persistence across close/reopen", () => {
  const store = new Store(TEST_PATH);
  const data = new TextEncoder().encode("persistent");
  store.put("b", "persist.txt", data, "text/plain");
  store.close();

  const store2 = new Store(TEST_PATH);
  const obj = store2.get("b", "persist.txt");
  expect(obj).toBeDefined();
  expect(new TextDecoder().decode(obj!.data!)).toBe("persistent");
  store2.close();
});

test("Store: mime type guessing", () => {
  const store = new Store();
  store.put("b", "image.png", new TextEncoder().encode("fake png"));

  const obj = store.get("b", "image.png");
  expect(obj!.contentType).toBe("image/png");
});
