import { test, expect, afterEach } from "bun:test";
import { S3Client } from "../src/client";
import { rmSync, existsSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-client-test.s3db";
let client: S3Client | null = null;

function cleanup() {
  client?.close();
  client = null;
  for (const p of [TEST_PATH, TEST_PATH + "-wal", TEST_PATH + "-blobs"]) {
    if (existsSync(p)) rmSync(p);
  }
}

afterEach(cleanup);

test("S3Client: file() returns S3File", () => {
  client = new S3Client({ bucket: "test" });
  const file = client.file("hello.txt");
  expect(file.name).toBe("hello.txt");
  expect(file.bucket).toBe("test");
});

test("S3Client: write and read", async () => {
  client = new S3Client({ bucket: "test" });
  await client.write("data.txt", "hello world");

  const file = client.file("data.txt");
  expect(await file.text()).toBe("hello world");
});

test("S3Client: delete", async () => {
  client = new S3Client({ bucket: "test" });
  await client.write("del.txt", "delete me");
  expect(await client.exists("del.txt")).toBe(true);

  await client.delete("del.txt");
  expect(await client.exists("del.txt")).toBe(false);
});

test("S3Client: size", async () => {
  client = new S3Client({ bucket: "test" });
  await client.write("size.txt", "12345");
  expect(await client.size("size.txt")).toBe(5);
});

test("S3Client: stat", async () => {
  client = new S3Client({ bucket: "test" });
  await client.write("stat.txt", "data", { type: "text/plain" });
  const s = await client.stat("stat.txt");
  expect(s.size).toBe(4);
  expect(s.type).toBe("text/plain");
});

test("S3Client: presign throws without PresignHandler", async () => {
  client = new S3Client({ bucket: "test" });
  await client.write("presign.txt", "presigned content");
  expect(() => client!.presign("presign.txt")).toThrow("not supported");
});

test("S3Client: persistence with path", async () => {
  client = new S3Client({ bucket: "test", path: TEST_PATH });
  await client.write("persist.txt", "persistent data");
  client.close();
  client = null;

  const client2 = new S3Client({ bucket: "test", path: TEST_PATH });
  const file = client2.file("persist.txt");
  expect(await file.text()).toBe("persistent data");
  client2.close();
});

test("S3Client: accepts S3-compat options without error", () => {
  client = new S3Client({
    bucket: "test",
    accessKeyId: "key",
    secretAccessKey: "secret",
    region: "us-east-1",
    endpoint: "http://localhost:9000",
  });
  expect(client).toBeDefined();
});

test("S3Client: writer()", async () => {
  client = new S3Client({ bucket: "test" });
  const file = client.file("writer.txt");
  const writer = file.writer({ type: "text/plain" });
  writer.write("part1 ");
  writer.write("part2");
  await writer.end();

  expect(await file.text()).toBe("part1 part2");
});
