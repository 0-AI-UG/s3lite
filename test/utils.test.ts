import { test, expect } from "bun:test";
import { guessMimeType, computeETag, normalizeToBytes, concatUint8Arrays, crc32 } from "../src/utils";

// --- guessMimeType ---

test("guessMimeType: known extensions", () => {
  expect(guessMimeType("file.html")).toBe("text/html");
  expect(guessMimeType("file.json")).toBe("application/json");
  expect(guessMimeType("file.png")).toBe("image/png");
  expect(guessMimeType("file.wasm")).toBe("application/wasm");
});

test("guessMimeType: case insensitive", () => {
  expect(guessMimeType("FILE.PNG")).toBe("image/png");
  expect(guessMimeType("readme.MD")).toBe("text/markdown");
});

test("guessMimeType: no extension returns octet-stream", () => {
  expect(guessMimeType("Makefile")).toBe("application/octet-stream");
  expect(guessMimeType("LICENSE")).toBe("application/octet-stream");
});

test("guessMimeType: unknown extension returns octet-stream", () => {
  expect(guessMimeType("data.xyz123")).toBe("application/octet-stream");
});

test("guessMimeType: dotfiles", () => {
  expect(guessMimeType(".gitignore")).toBe("application/octet-stream");
});

test("guessMimeType: multiple dots uses last extension", () => {
  expect(guessMimeType("archive.tar.gz")).toBe("application/gzip");
  expect(guessMimeType("app.config.json")).toBe("application/json");
});

// --- computeETag ---

test("computeETag: returns quoted md5 hex", () => {
  const data = new TextEncoder().encode("hello");
  const etag = computeETag(data);
  expect(etag).toMatch(/^"[a-f0-9]{32}"$/);
});

test("computeETag: same data produces same etag", () => {
  const data = new TextEncoder().encode("deterministic");
  expect(computeETag(data)).toBe(computeETag(data));
});

test("computeETag: different data produces different etag", () => {
  const a = computeETag(new TextEncoder().encode("aaa"));
  const b = computeETag(new TextEncoder().encode("bbb"));
  expect(a).not.toBe(b);
});

test("computeETag: empty data", () => {
  const etag = computeETag(new Uint8Array(0));
  expect(etag).toMatch(/^"[a-f0-9]{32}"$/);
});

// --- normalizeToBytes ---

test("normalizeToBytes: string", async () => {
  const result = await normalizeToBytes("hello");
  expect(new TextDecoder().decode(result)).toBe("hello");
});

test("normalizeToBytes: Uint8Array passthrough", async () => {
  const input = new Uint8Array([1, 2, 3]);
  const result = await normalizeToBytes(input);
  expect(result).toBe(input);
});

test("normalizeToBytes: ArrayBuffer", async () => {
  const buf = new ArrayBuffer(3);
  new Uint8Array(buf).set([10, 20, 30]);
  const result = await normalizeToBytes(buf);
  expect(result).toEqual(new Uint8Array([10, 20, 30]));
});

test("normalizeToBytes: Blob", async () => {
  const blob = new Blob(["blob data"]);
  const result = await normalizeToBytes(blob);
  expect(new TextDecoder().decode(result)).toBe("blob data");
});

test("normalizeToBytes: Response", async () => {
  const res = new Response("response body");
  const result = await normalizeToBytes(res);
  expect(new TextDecoder().decode(result)).toBe("response body");
});

test("normalizeToBytes: Request", async () => {
  const req = new Request("http://localhost", { method: "POST", body: "req body" });
  const result = await normalizeToBytes(req);
  expect(new TextDecoder().decode(result)).toBe("req body");
});

test("normalizeToBytes: DataView", async () => {
  const buf = new ArrayBuffer(4);
  new Uint8Array(buf).set([1, 2, 3, 4]);
  const view = new DataView(buf, 1, 2);
  const result = await normalizeToBytes(view);
  expect(result).toEqual(new Uint8Array([2, 3]));
});

// --- concatUint8Arrays ---

test("concatUint8Arrays: multiple arrays", () => {
  const result = concatUint8Arrays([
    new Uint8Array([1, 2]),
    new Uint8Array([3]),
    new Uint8Array([4, 5, 6]),
  ]);
  expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
});

test("concatUint8Arrays: empty input", () => {
  expect(concatUint8Arrays([])).toEqual(new Uint8Array(0));
});

test("concatUint8Arrays: single array", () => {
  const input = new Uint8Array([7, 8, 9]);
  expect(concatUint8Arrays([input])).toEqual(input);
});

// --- crc32 ---

test("crc32: deterministic", () => {
  const data = new TextEncoder().encode("test");
  expect(crc32(data)).toBe(crc32(data));
});

test("crc32: different data produces different checksums", () => {
  const a = crc32(new TextEncoder().encode("aaa"));
  const b = crc32(new TextEncoder().encode("bbb"));
  expect(a).not.toBe(b);
});

test("crc32: empty data returns valid number", () => {
  const result = crc32(new Uint8Array(0));
  expect(typeof result).toBe("number");
  expect(result).toBeGreaterThanOrEqual(0);
});

test("crc32: known value", () => {
  // CRC32 of "123456789" is 0xCBF43926
  const data = new TextEncoder().encode("123456789");
  expect(crc32(data)).toBe(0xcbf43926);
});
