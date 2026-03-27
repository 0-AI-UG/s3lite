import { test, expect, afterEach } from "bun:test";
import { S3Client } from "../src/client";
import { rmSync, existsSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-copy-test.s3db";
let client: S3Client | null = null;

function cleanup() {
  client?.close();
  client = null;
  for (const p of [TEST_PATH, TEST_PATH + "-wal", TEST_PATH + "-blobs"]) {
    if (existsSync(p)) rmSync(p);
  }
}

afterEach(cleanup);

test("copy: same bucket", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("src.txt", "hello", { type: "text/plain" });

  const ok = await client.copy("src.txt", "dest.txt");
  expect(ok).toBe(true);

  const dest = client.file("dest.txt");
  expect(await dest.text()).toBe("hello");
  expect((await dest.stat()).type).toBe("text/plain");

  // source still exists
  expect(await client.exists("src.txt")).toBe(true);
});

test("copy: cross bucket", async () => {
  client = new S3Client({ bucket: "a" });
  await client.write("file.txt", "data");

  const ok = await client.copy("file.txt", "file.txt", {
    srcBucket: "a",
    destBucket: "b",
  });
  expect(ok).toBe(true);

  const dest = client.file("file.txt", { bucket: "b" });
  expect(await dest.text()).toBe("data");
});

test("copy: non-existent source returns false", async () => {
  client = new S3Client({ bucket: "b" });
  const ok = await client.copy("nope.txt", "dest.txt");
  expect(ok).toBe(false);
});

test("copy: persists across close/reopen", async () => {
  client = new S3Client({ bucket: "b", path: TEST_PATH });
  await client.write("src.txt", "persistent copy");
  await client.copy("src.txt", "dest.txt");
  client.close();
  client = null;

  const client2 = new S3Client({ bucket: "b", path: TEST_PATH });
  expect(await client2.file("dest.txt").text()).toBe("persistent copy");
  client2.close();
});
