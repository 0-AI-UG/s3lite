import { test, expect } from "bun:test";
import { Store } from "../src/store";
import { S3File } from "../src/file";

function makeFile(key: string, content: string, contentType?: string) {
  const store = new Store();
  const data = new TextEncoder().encode(content);
  store.put("test-bucket", key, data, contentType);
  return { store, file: new S3File(store, "test-bucket", key) };
}

test("S3File: text()", async () => {
  const { file } = makeFile("hello.txt", "hello world", "text/plain");
  expect(await file.text()).toBe("hello world");
});

test("S3File: json()", async () => {
  const { file } = makeFile("data.json", '{"a":1}', "application/json");
  expect(await file.json()).toEqual({ a: 1 });
});

test("S3File: bytes()", async () => {
  const { file } = makeFile("bin.dat", "bytes");
  const bytes = await file.bytes();
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(new TextDecoder().decode(bytes)).toBe("bytes");
});

test("S3File: arrayBuffer()", async () => {
  const { file } = makeFile("buf.dat", "buffer");
  const buf = await file.arrayBuffer();
  expect(buf).toBeInstanceOf(ArrayBuffer);
  expect(new TextDecoder().decode(new Uint8Array(buf))).toBe("buffer");
});

test("S3File: stream()", async () => {
  const { file } = makeFile("stream.txt", "streaming");
  const reader = file.stream().getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value!)).toBe("streaming");
});

test("S3File: write()", async () => {
  const store = new Store();
  const file = new S3File(store, "b", "new.txt");
  await file.write("new content");
  expect(await file.text()).toBe("new content");
});

test("S3File: exists()", async () => {
  const store = new Store();
  const file = new S3File(store, "b", "missing.txt");
  expect(await file.exists()).toBe(false);
  await file.write("exists now");
  expect(await file.exists()).toBe(true);
});

test("S3File: delete()", async () => {
  const { store, file } = makeFile("del.txt", "delete me");
  expect(await file.exists()).toBe(true);
  await file.delete();
  expect(await file.exists()).toBe(false);
});

test("S3File: stat()", async () => {
  const { file } = makeFile("stat.txt", "stat data", "text/plain");
  const s = await file.stat();
  expect(s.size).toBe(9);
  expect(s.type).toBe("text/plain");
  expect(s.etag).toBeDefined();
  expect(s.lastModified).toBeInstanceOf(Date);
});

test("S3File: slice()", async () => {
  const { file } = makeFile("slice.txt", "hello world");
  const sliced = file.slice(0, 5);
  expect(await sliced.text()).toBe("hello");
});

test("S3File: size property", () => {
  const { file } = makeFile("size.txt", "12345");
  expect(file.size).toBe(5);
});

test("S3File: type property", () => {
  const { file } = makeFile("type.json", "{}", "application/json");
  expect(file.type).toBe("application/json");
});
