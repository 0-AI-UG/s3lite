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

test("Range: partial content with byte range", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("video.mp4", "0123456789", { type: "video/mp4" });

  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("video.mp4", { bucket: "b" });

  const req = new Request(url, {
    headers: { Range: "bytes=0-4" },
  });
  const res = await handler.handleRequest(req);

  expect(res.status).toBe(206);
  expect(await res.text()).toBe("01234");
  expect(res.headers.get("Content-Range")).toBe("bytes 0-4/10");
  expect(res.headers.get("Content-Length")).toBe("5");
});

test("Range: open-ended range", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("data.bin", "abcdefghij");

  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("data.bin", { bucket: "b" });

  const req = new Request(url, {
    headers: { Range: "bytes=5-" },
  });
  const res = await handler.handleRequest(req);

  expect(res.status).toBe(206);
  expect(await res.text()).toBe("fghij");
  expect(res.headers.get("Content-Range")).toBe("bytes 5-9/10");
});

test("Range: out of range returns 416", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("small.txt", "hi");

  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("small.txt", { bucket: "b" });

  const req = new Request(url, {
    headers: { Range: "bytes=100-200" },
  });
  const res = await handler.handleRequest(req);

  expect(res.status).toBe(416);
  expect(res.headers.get("Content-Range")).toBe("bytes */2");
});

test("Range: no Range header returns full content with Accept-Ranges", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("full.txt", "all of it", { type: "text/plain" });

  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("full.txt", { bucket: "b" });

  const req = new Request(url);
  const res = await handler.handleRequest(req);

  expect(res.status).toBe(200);
  expect(await res.text()).toBe("all of it");
  expect(res.headers.get("Accept-Ranges")).toBe("bytes");
});

test("Range: clamps end to file size", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("clip.txt", "short");

  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("clip.txt", { bucket: "b" });

  const req = new Request(url, {
    headers: { Range: "bytes=0-999" },
  });
  const res = await handler.handleRequest(req);

  expect(res.status).toBe(206);
  expect(await res.text()).toBe("short");
  expect(res.headers.get("Content-Range")).toBe("bytes 0-4/5");
});
