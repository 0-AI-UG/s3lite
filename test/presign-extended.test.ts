import { test, expect, afterEach } from "bun:test";
import { S3Client } from "../src/client";
import { PresignHandler } from "../src/presign";

let client: S3Client | null = null;
let handler: PresignHandler | null = null;

afterEach(() => {
  handler?.stop();
  handler = null;
  client?.close();
  client = null;
});

test("PresignHandler: GET non-existent file returns 404", async () => {
  client = new S3Client({ bucket: "b" });
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("ghost.txt", { bucket: "b" });

  const res = await handler.handleRequest(new Request(url));
  expect(res.status).toBe(404);
});

test("PresignHandler: PUT without Content-Type defaults to octet-stream", async () => {
  client = new S3Client({ bucket: "b" });
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("upload.bin", { method: "PUT", bucket: "b" });

  const res = await handler.handleRequest(
    new Request(url, { method: "PUT", body: new Uint8Array([1, 2, 3]) }),
  );
  expect(res.status).toBe(200);

  const stat = await client.stat("upload.bin");
  expect(stat.size).toBe(3);
});

test("PresignHandler: expired token returns 401", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("test.txt", "data");
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });

  const url = handler.presign("test.txt", { bucket: "b", expiresIn: 0.01 });
  await Bun.sleep(20);

  const res = await handler.handleRequest(new Request(url));
  expect(res.status).toBe(401);
});

test("PresignHandler: POST method returns 405", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("test.txt", "data");
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("test.txt", { bucket: "b" });

  const res = await handler.handleRequest(new Request(url, { method: "POST", body: "x" }));
  expect(res.status).toBe(405);
});

test("PresignHandler: unsupported method on PUT token returns 405", async () => {
  client = new S3Client({ bucket: "b" });
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("file.txt", { method: "PUT", bucket: "b" });

  const res = await handler.handleRequest(new Request(url)); // GET on a PUT token
  expect(res.status).toBe(405);
});

test("PresignHandler: stop() clears all tokens", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("test.txt", "data");
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });

  const url = handler.presign("test.txt", { bucket: "b" });
  handler.stop();

  const res = await handler.handleRequest(new Request(url));
  expect(res.status).toBe(401);
});

test("PresignHandler: multiple CORS headers", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("test.txt", "data");

  const cors = {
    "Access-Control-Allow-Origin": "https://example.com",
    "Access-Control-Allow-Methods": "GET, PUT",
  };
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3", corsHeaders: cors });
  const url = handler.presign("test.txt", { bucket: "b" });

  const res = await handler.handleRequest(new Request(url));
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
  expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, PUT");
});

test("PresignHandler: invalid range syntax returns full content", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("range.txt", "hello world");
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("range.txt", { bucket: "b" });

  const res = await handler.handleRequest(
    new Request(url, { headers: { Range: "bytes=invalid" } }),
  );
  // Invalid range syntax should be ignored, return full content
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hello world");
});

test("PresignHandler: baseUrl trailing slashes are normalized", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("test.txt", "data");
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3///" });
  const url = handler.presign("test.txt", { bucket: "b" });
  expect(url).toContain("http://localhost:3001/api/s3/");
  expect(url).not.toContain("////");
});

test("PresignHandler: ETag header present in GET response", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("etag.txt", "data");
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("etag.txt", { bucket: "b" });

  const res = await handler.handleRequest(new Request(url));
  expect(res.headers.get("ETag")).toMatch(/^"[a-f0-9]+"$/);
});

test("PresignHandler: Content-Length header in GET response", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("len.txt", "12345");
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("len.txt", { bucket: "b" });

  const res = await handler.handleRequest(new Request(url));
  expect(res.headers.get("Content-Length")).toBe("5");
});
