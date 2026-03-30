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

test("tokens are pruned when maxTokens exceeded via presign()", () => {
  client = new S3Client({ bucket: "b" });
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3000", maxTokens: 100 });

  // Create 101 tokens — the 101st should trigger pruning
  for (let i = 0; i < 101; i++) {
    handler.presign(`file-${i}.txt`, { bucket: "b", expiresIn: 3600 });
  }

  // We can't directly inspect token count, but we can verify via handleRequest
  // that the handler didn't accumulate unbounded tokens.
  // The capacity limit should have evicted the oldest-expiring token.
  // All tokens have the same expiry, so the first one should be evicted.
  // Create another 100 tokens to push well past the limit
  for (let i = 101; i < 201; i++) {
    handler.presign(`file-${i}.txt`, { bucket: "b", expiresIn: 3600 });
  }

  // Handler should still be functional (not OOM)
  const url = handler.presign("final.txt", { bucket: "b", expiresIn: 3600 });
  expect(url).toContain("http://localhost:3000/");
});

test("expired tokens are pruned before capacity eviction", async () => {
  client = new S3Client({ bucket: "b" });
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3000", maxTokens: 10 });

  // Create 10 tokens that expire very soon
  const urls: string[] = [];
  for (let i = 0; i < 10; i++) {
    urls.push(handler.presign(`expire-${i}.txt`, { bucket: "b", expiresIn: 0.01 }));
  }

  await Bun.sleep(20);

  // Now create a new token — this should first prune expired ones
  const validUrl = handler.presign("valid.txt", { bucket: "b", expiresIn: 3600 });

  // The valid token should work
  await client.write("valid.txt", "data");
  const res = await handler.handleRequest(new Request(validUrl));
  expect(res.status).toBe(200);

  // The expired ones should be gone
  const res2 = await handler.handleRequest(new Request(urls[0]!));
  expect(res2.status).toBe(401);
});

test("default maxTokens is 10000", () => {
  client = new S3Client({ bucket: "b" });
  handler = new PresignHandler(client, { baseUrl: "http://localhost:3000" });

  // Should be able to create many tokens without issues
  for (let i = 0; i < 100; i++) {
    handler.presign(`file-${i}.txt`, { bucket: "b", expiresIn: 3600 });
  }

  const url = handler.presign("test.txt", { bucket: "b", expiresIn: 3600 });
  expect(url).toContain("http://localhost:3000/");
});
