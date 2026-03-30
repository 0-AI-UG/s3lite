import { test, expect, afterEach } from "bun:test";
import { S3Client } from "../src/client";

let client: S3Client | null = null;

afterEach(() => {
  client?.close();
  client = null;
});

test("events: put fires on write", async () => {
  client = new S3Client({ bucket: "b" });
  const events: string[] = [];
  client.on("put", (bucket, key) => events.push(`${bucket}/${key}`));

  await client.write("a.txt", "hello");
  await client.write("b.txt", "world");

  expect(events).toEqual(["b/a.txt", "b/b.txt"]);
});

test("events: delete fires on delete", async () => {
  client = new S3Client({ bucket: "b" });
  const events: string[] = [];
  client.on("delete", (bucket, key) => events.push(`${bucket}/${key}`));

  await client.write("del.txt", "data");
  await client.delete("del.txt");

  expect(events).toEqual(["b/del.txt"]);
});

test("events: copy fires on copy", async () => {
  client = new S3Client({ bucket: "b" });
  const events: string[] = [];
  client.on("copy", (bucket, key) => events.push(`${bucket}/${key}`));

  await client.write("src.txt", "data");
  await client.copy("src.txt", "dest.txt");

  expect(events).toEqual(["b/dest.txt"]);
});

test("events: off removes listener", async () => {
  client = new S3Client({ bucket: "b" });
  const events: string[] = [];
  const cb = (bucket: string, key: string) => events.push(`${bucket}/${key}`);

  client.on("put", cb);
  await client.write("a.txt", "1");
  client.off("put", cb);
  await client.write("b.txt", "2");

  expect(events).toEqual(["b/a.txt"]);
});

test("events: multiple listeners", async () => {
  client = new S3Client({ bucket: "b" });
  const events1: string[] = [];
  const events2: string[] = [];

  client.on("put", (_b, k) => events1.push(k));
  client.on("put", (_b, k) => events2.push(k));

  await client.write("x.txt", "data");

  expect(events1).toEqual(["x.txt"]);
  expect(events2).toEqual(["x.txt"]);
});
