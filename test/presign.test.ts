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

test("PresignHandler: generate GET url and handle request", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("download.txt", "file content", { type: "text/plain" });

  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("download.txt", { bucket: "b" });

  expect(url).toStartWith("http://localhost:3001/api/s3/");

  const req = new Request(url);
  const res = await handler.handleRequest(req);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("file content");
  expect(res.headers.get("Content-Type")).toBe("text/plain");
});

test("PresignHandler: generate PUT url and handle upload", async () => {
  client = new S3Client({ bucket: "b" });
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("upload.txt", { method: "PUT", bucket: "b" });

  const req = new Request(url, {
    method: "PUT",
    body: "uploaded data",
    headers: { "Content-Type": "text/plain" },
  });
  const res = await handler.handleRequest(req);
  expect(res.status).toBe(200);

  const file = client.file("upload.txt");
  expect(await file.text()).toBe("uploaded data");
});

test("PresignHandler: invalid token", async () => {
  client = new S3Client({ bucket: "b" });
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });

  const req = new Request("http://localhost:3001/api/s3/invalid-token");
  const res = await handler.handleRequest(req);
  expect(res.status).toBe(401);
});

test("PresignHandler: method mismatch", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("test.txt", "data");
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("test.txt", { bucket: "b" });

  const req = new Request(url, { method: "PUT", body: "nope" });
  const res = await handler.handleRequest(req);
  expect(res.status).toBe(405);
});

test("PresignHandler: content disposition header", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("doc.pdf", "pdf data", { type: "application/pdf" });

  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });
  const url = handler.presign("doc.pdf", {
    bucket: "b",
    contentDisposition: 'attachment; filename="doc.pdf"',
  });

  const req = new Request(url);
  const res = await handler.handleRequest(req);
  expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="doc.pdf"');
});

test("PresignHandler: CORS headers included in response", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("test.txt", "data", { type: "text/plain" });

  const cors = { "Access-Control-Allow-Origin": "*" };
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3", corsHeaders: cors });
  const url = handler.presign("test.txt", { bucket: "b" });

  const req = new Request(url);
  const res = await handler.handleRequest(req);
  expect(res.status).toBe(200);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
});
