import { test, expect, afterEach } from "bun:test";
import { S3Client } from "../src/client";
import { Store } from "../src/store";

let client: S3Client | null = null;

afterEach(() => {
  client?.close();
  client = null;
});

// --- Empty data ---

test("Store: put and get empty data", () => {
  const store = new Store();
  store.put("b", "empty.txt", new Uint8Array(0));
  const obj = store.get("b", "empty.txt");
  expect(obj).toBeDefined();
  expect(obj!.size).toBe(0);
  expect(obj!.data!.byteLength).toBe(0);
});

test("Client: write and read empty string", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("empty.txt", "");
  const file = client.file("empty.txt");
  expect(await file.text()).toBe("");
  expect(file.size).toBe(0);
});

// --- Special characters in keys ---

test("Store: keys with special characters", () => {
  const store = new Store();
  const data = new TextEncoder().encode("data");

  const specialKeys = [
    "path/with spaces/file.txt",
    "emoji-🎉-key.txt",
    "dots...in...name.txt",
    "key-with-üñíçödé.txt",
    "very/deep/nested/path/to/file.txt",
    "key with=equals&ampersand?query",
  ];

  for (const key of specialKeys) {
    store.put("b", key, data);
    expect(store.exists("b", key)).toBe(true);
    expect(new TextDecoder().decode(store.get("b", key)!.data!)).toBe("data");
  }
});

test("Store: empty string key", () => {
  const store = new Store();
  store.put("b", "", new TextEncoder().encode("empty key"));
  expect(store.exists("b", "")).toBe(true);
  expect(new TextDecoder().decode(store.get("b", "")!.data!)).toBe("empty key");
});

// --- Long keys ---

test("Store: very long key", () => {
  const store = new Store();
  const longKey = "a".repeat(10000);
  store.put("b", longKey, new TextEncoder().encode("long"));
  expect(store.exists("b", longKey)).toBe(true);
  expect(new TextDecoder().decode(store.get("b", longKey)!.data!)).toBe("long");
});

// --- Binary data ---

test("Store: binary data with all byte values", () => {
  const store = new Store();
  const data = new Uint8Array(256);
  for (let i = 0; i < 256; i++) data[i] = i;
  store.put("b", "binary.dat", data);
  const obj = store.get("b", "binary.dat");
  expect(obj!.data).toEqual(data);
});

test("Store: binary data with null bytes", () => {
  const store = new Store();
  const data = new Uint8Array([0, 0, 0, 0, 0]);
  store.put("b", "nulls.dat", data);
  expect(store.get("b", "nulls.dat")!.data).toEqual(data);
});

// --- Overwrite behavior ---

test("Store: overwrite updates data and metadata", () => {
  const store = new Store();
  store.put("b", "file.txt", new TextEncoder().encode("v1"), "text/plain");
  const stat1 = store.stat("b", "file.txt")!;

  store.put("b", "file.txt", new TextEncoder().encode("version2"), "text/html");
  const stat2 = store.stat("b", "file.txt")!;

  expect(new TextDecoder().decode(store.get("b", "file.txt")!.data!)).toBe("version2");
  expect(stat2.size).toBe(8);
  expect(stat2.type).toBe("text/html");
  expect(stat2.etag).not.toBe(stat1.etag);
});

// --- getRange edge cases ---

test("Store: getRange with end beyond data length", () => {
  const store = new Store();
  store.put("b", "short.txt", new TextEncoder().encode("abc"));
  const result = store.getRange("b", "short.txt", 0, 100);
  expect(new TextDecoder().decode(result!)).toBe("abc");
});

test("Store: getRange with start at 0 end at 0", () => {
  const store = new Store();
  store.put("b", "range.txt", new TextEncoder().encode("hello"));
  const result = store.getRange("b", "range.txt", 0, 0);
  expect(result!.byteLength).toBe(0);
});

// --- List edge cases ---

test("Store: list with empty prefix returns all", () => {
  const store = new Store();
  store.put("b", "a.txt", new TextEncoder().encode("a"));
  store.put("b", "b.txt", new TextEncoder().encode("b"));
  const result = store.list("b", { prefix: "" });
  expect(result.contents).toHaveLength(2);
});

test("Store: list returns sorted keys", () => {
  const store = new Store();
  store.put("b", "c.txt", new TextEncoder().encode("c"));
  store.put("b", "a.txt", new TextEncoder().encode("a"));
  store.put("b", "b.txt", new TextEncoder().encode("b"));
  const result = store.list("b");
  const keys = result.contents!.map((c) => c.key);
  expect(keys).toEqual(["a.txt", "b.txt", "c.txt"]);
});

test("Store: list with maxKeys=0 returns empty", () => {
  const store = new Store();
  store.put("b", "a.txt", new TextEncoder().encode("a"));
  const result = store.list("b", { maxKeys: 0 });
  expect(result.contents).toBeUndefined();
  expect(result.isTruncated).toBe(true);
});

test("Store: list with prefix that matches nothing", () => {
  const store = new Store();
  store.put("b", "a.txt", new TextEncoder().encode("a"));
  const result = store.list("b", { prefix: "zzz/" });
  expect(result.contents).toBeUndefined();
  expect(result.keyCount).toBe(0);
});

test("Store: list nextContinuationToken for pagination", () => {
  const store = new Store();
  store.put("b", "a.txt", new TextEncoder().encode("a"));
  store.put("b", "b.txt", new TextEncoder().encode("b"));
  store.put("b", "c.txt", new TextEncoder().encode("c"));

  const page1 = store.list("b", { maxKeys: 1 });
  expect(page1.contents).toHaveLength(1);
  expect(page1.isTruncated).toBe(true);
  expect(page1.nextContinuationToken).toBeDefined();

  const page2 = store.list("b", { maxKeys: 1, startAfter: page1.nextContinuationToken! });
  expect(page2.contents).toHaveLength(1);
  expect(page2.contents![0].key).toBe("b.txt");
});

test("Store: list with delimiter and prefix shows both contents and commonPrefixes", () => {
  const store = new Store();
  store.put("b", "docs/readme.txt", new TextEncoder().encode("r"));
  store.put("b", "docs/sub/a.txt", new TextEncoder().encode("a"));
  store.put("b", "docs/sub/b.txt", new TextEncoder().encode("b"));

  const result = store.list("b", { prefix: "docs/", delimiter: "/" });
  expect(result.contents).toHaveLength(1);
  expect(result.contents![0].key).toBe("docs/readme.txt");
  expect(result.commonPrefixes).toHaveLength(1);
  expect(result.commonPrefixes![0].prefix).toBe("docs/sub/");
});

// --- Copy edge cases ---

test("Store: copy preserves content type and disposition", () => {
  const store = new Store();
  store.put("b", "src.txt", new TextEncoder().encode("data"), "text/plain", "inline");
  store.copy("b", "src.txt", "b", "dest.txt");

  const obj = store.get("b", "dest.txt")!;
  expect(obj.contentType).toBe("text/plain");
  expect(obj.contentDisposition).toBe("inline");
});

test("Store: copy to same key overwrites", () => {
  const store = new Store();
  store.put("b", "file.txt", new TextEncoder().encode("original"), "text/plain");
  store.put("b", "other.txt", new TextEncoder().encode("other"), "text/html");
  store.copy("b", "other.txt", "b", "file.txt");

  expect(new TextDecoder().decode(store.get("b", "file.txt")!.data!)).toBe("other");
  expect(store.get("b", "file.txt")!.contentType).toBe("text/html");
});

// --- Multiple buckets ---

test("Store: same key in different buckets are independent", () => {
  const store = new Store();
  store.put("bucket1", "file.txt", new TextEncoder().encode("from bucket1"));
  store.put("bucket2", "file.txt", new TextEncoder().encode("from bucket2"));

  expect(new TextDecoder().decode(store.get("bucket1", "file.txt")!.data!)).toBe("from bucket1");
  expect(new TextDecoder().decode(store.get("bucket2", "file.txt")!.data!)).toBe("from bucket2");

  store.delete("bucket1", "file.txt");
  expect(store.exists("bucket1", "file.txt")).toBe(false);
  expect(store.exists("bucket2", "file.txt")).toBe(true);
});

// --- Client: write various data types ---

test("Client: write Blob", async () => {
  client = new S3Client({ bucket: "b" });
  const blob = new Blob(["blob content"], { type: "text/plain" });
  await client.write("blob.txt", blob);
  expect(await client.file("blob.txt").text()).toBe("blob content");
});

test("Client: write ArrayBuffer", async () => {
  client = new S3Client({ bucket: "b" });
  const buf = new TextEncoder().encode("arraybuffer").buffer;
  await client.write("buf.txt", buf);
  expect(await client.file("buf.txt").text()).toBe("arraybuffer");
});

test("Client: write Uint8Array", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("bytes.txt", new TextEncoder().encode("bytes"));
  expect(await client.file("bytes.txt").text()).toBe("bytes");
});

// --- S3File: arrayBuffer roundtrip ---

test("S3File: arrayBuffer() returns valid ArrayBuffer", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("ab.txt", "arraybuffer test");
  const ab = await client.file("ab.txt").arrayBuffer();
  expect(ab).toBeInstanceOf(ArrayBuffer);
  expect(new TextDecoder().decode(ab)).toBe("arraybuffer test");
});

// --- S3File: json roundtrip ---

test("S3File: json() parses stored JSON", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("data.json", JSON.stringify({ key: "value", num: 42 }));
  const data = await client.file("data.json").json();
  expect(data).toEqual({ key: "value", num: 42 });
});

// --- S3File: stream consumption ---

test("S3File: stream() can be fully consumed", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("stream.txt", "stream content");
  const stream = client.file("stream.txt").stream();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const text = new TextDecoder().decode(chunks[0]);
  expect(text).toBe("stream content");
});
