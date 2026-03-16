import { test, expect, afterEach } from "bun:test";
import { S3Client } from "../src/client";

let client: S3Client | null = null;

afterEach(() => {
  client?.close();
  client = null;
});

test("list: all objects", async () => {
  client = new S3Client({ bucket: "test" });
  await client.write("a.txt", "a");
  await client.write("b.txt", "b");
  await client.write("c.txt", "c");

  const result = await client.list();
  expect(result.contents).toHaveLength(3);
  expect(result.contents!.map((c) => c.key)).toEqual(["a.txt", "b.txt", "c.txt"]);
});

test("list: prefix filter", async () => {
  client = new S3Client({ bucket: "test" });
  await client.write("projects/1/a.txt", "a");
  await client.write("projects/1/b.txt", "b");
  await client.write("projects/2/c.txt", "c");
  await client.write("other.txt", "d");

  const result = await client.list({ prefix: "projects/1/" });
  expect(result.contents).toHaveLength(2);
  expect(result.contents!.map((c) => c.key)).toEqual([
    "projects/1/a.txt",
    "projects/1/b.txt",
  ]);
});

test("list: startAfter pagination", async () => {
  client = new S3Client({ bucket: "test" });
  await client.write("a.txt", "a");
  await client.write("b.txt", "b");
  await client.write("c.txt", "c");

  const page1 = await client.list({ maxKeys: 1 });
  expect(page1.contents).toHaveLength(1);
  expect(page1.isTruncated).toBe(true);

  const page2 = await client.list({
    startAfter: page1.contents![0].key,
    maxKeys: 1,
  });
  expect(page2.contents).toHaveLength(1);
  expect(page2.contents![0].key).toBe("b.txt");
});

test("list: delimiter groups into commonPrefixes", async () => {
  client = new S3Client({ bucket: "test" });
  await client.write("photos/2024/jan.jpg", "j");
  await client.write("photos/2024/feb.jpg", "f");
  await client.write("photos/2025/mar.jpg", "m");
  await client.write("photos/top.jpg", "t");

  const result = await client.list({ prefix: "photos/", delimiter: "/" });
  expect(result.commonPrefixes).toHaveLength(2);
  expect(result.commonPrefixes!.map((p) => p.prefix).sort()).toEqual([
    "photos/2024/",
    "photos/2025/",
  ]);
  // top.jpg should be in contents (no nested delimiter)
  expect(result.contents).toHaveLength(1);
  expect(result.contents![0].key).toBe("photos/top.jpg");
});

test("list: empty bucket", async () => {
  client = new S3Client({ bucket: "test" });
  const result = await client.list();
  expect(result.contents).toBeUndefined();
  expect(result.isTruncated).toBe(false);
});
