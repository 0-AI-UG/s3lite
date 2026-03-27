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

test("token cleanup: expired tokens pruned on handleRequest", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("test.txt", "data");

  handler = new PresignHandler(client, { baseUrl: "http://localhost:3001/api/s3" });

  // Create a token that expires almost instantly
  const url1 = handler.presign("test.txt", { bucket: "b", expiresIn: 0.01 });

  await Bun.sleep(20);

  // This request should trigger pruning and fail with 401
  const req = new Request(url1);
  const res = await handler.handleRequest(req);
  expect(res.status).toBe(401);

  // Create a valid token and verify it still works after pruning
  const url2 = handler.presign("test.txt", { bucket: "b", expiresIn: 3600 });
  const req2 = new Request(url2);
  const res2 = await handler.handleRequest(req2);
  expect(res2.status).toBe(200);
});
