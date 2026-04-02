import { test, expect, afterEach } from "bun:test";
import { S3Client } from "../src/client";
import { rmSync, existsSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-stress-test.s3db";
let client: S3Client | null = null;

function cleanup() {
  client?.close();
  client = null;
  for (const p of [TEST_PATH, TEST_PATH + "-wal", TEST_PATH + "-blobs"]) {
    if (existsSync(p)) rmSync(p);
  }
}

afterEach(cleanup);

test("stress: 10k objects in-memory", async () => {
  client = new S3Client({ bucket: "stress" });
  const count = 10_000;

  const start = performance.now();
  for (let i = 0; i < count; i++) {
    await client.write(`file-${i}.txt`, `content-${i}`);
  }
  const writeTime = performance.now() - start;

  // Verify count via pagination
  let total = 0;
  let token: string | undefined;
  do {
    const page = client.list({ prefix: "file-", maxKeys: 10_000, continuationToken: token });
    total += page.contents!.length;
    token = page.nextContinuationToken;
  } while (token);
  expect(total).toBe(count);

  // Spot-check random reads
  const readStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    const idx = Math.floor(Math.random() * count);
    const file = client.file(`file-${idx}.txt`);
    expect(await file.text()).toBe(`content-${idx}`);
  }
  const readTime = performance.now() - readStart;

  console.log(`[stress 10k in-memory] writes: ${writeTime.toFixed(0)}ms, 1k random reads: ${readTime.toFixed(0)}ms`);
});

test("stress: 10k objects persisted", async () => {
  client = new S3Client({ bucket: "stress", path: TEST_PATH });
  const count = 10_000;

  const start = performance.now();
  for (let i = 0; i < count; i++) {
    await client.write(`file-${i}.txt`, `content-${i}`);
  }
  const writeTime = performance.now() - start;

  // Checkpoint to flush WAL
  client.checkpoint();

  // Spot-check reads
  const readStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    const idx = Math.floor(Math.random() * count);
    const file = client.file(`file-${idx}.txt`);
    expect(await file.text()).toBe(`content-${idx}`);
  }
  const readTime = performance.now() - readStart;

  console.log(`[stress 10k persisted] writes: ${writeTime.toFixed(0)}ms, 1k random reads: ${readTime.toFixed(0)}ms`);
});

test("stress: 100k objects in-memory", async () => {
  client = new S3Client({ bucket: "stress" });
  const count = 100_000;

  const start = performance.now();
  for (let i = 0; i < count; i++) {
    await client.write(`obj-${i}`, `data-${i}`);
  }
  const writeTime = performance.now() - start;

  const listed = client.list({ prefix: "obj-", maxKeys: 1 });
  expect(listed.contents!.length).toBe(1);
  expect(listed.isTruncated).toBe(true);

  // Random reads
  const readStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    const idx = Math.floor(Math.random() * count);
    expect(await client.file(`obj-${idx}`).text()).toBe(`data-${idx}`);
  }
  const readTime = performance.now() - readStart;

  // Deletes
  const delStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    await client.delete(`obj-${i}`);
  }
  const delTime = performance.now() - delStart;

  expect(await client.exists("obj-0")).toBe(false);
  expect(await client.exists(`obj-${count - 1}`)).toBe(true);

  console.log(`[stress 100k in-memory] writes: ${writeTime.toFixed(0)}ms, 1k reads: ${readTime.toFixed(0)}ms, 1k deletes: ${delTime.toFixed(0)}ms`);
});

test("stress: 100k objects persisted with disk index", async () => {
  client = new S3Client({ bucket: "stress", path: TEST_PATH, indexMode: "disk" });
  const count = 100_000;

  const start = performance.now();
  for (let i = 0; i < count; i++) {
    await client.write(`obj-${i}`, `data-${i}`);
  }
  const writeTime = performance.now() - start;

  client.checkpoint();

  const readStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    const idx = Math.floor(Math.random() * count);
    expect(await client.file(`obj-${idx}`).text()).toBe(`data-${idx}`);
  }
  const readTime = performance.now() - readStart;

  console.log(`[stress 100k disk-index] writes: ${writeTime.toFixed(0)}ms, 1k reads: ${readTime.toFixed(0)}ms`);
});

test("stress: large objects (1MB each, 100 objects)", async () => {
  client = new S3Client({ bucket: "stress" });
  const size = 1024 * 1024; // 1MB
  const count = 100;
  const data = Buffer.alloc(size, 0x41); // 1MB of 'A'

  const start = performance.now();
  for (let i = 0; i < count; i++) {
    await client.write(`large-${i}.bin`, data);
  }
  const writeTime = performance.now() - start;

  // Verify size
  const stat = await client.stat("large-0.bin");
  expect(stat.size).toBe(size);

  // Read back
  const readStart = performance.now();
  for (let i = 0; i < 10; i++) {
    const bytes = await client.file(`large-${i}.bin`).bytes();
    expect(bytes.length).toBe(size);
  }
  const readTime = performance.now() - readStart;

  console.log(`[stress large 1MB x 100] writes: ${writeTime.toFixed(0)}ms, 10 reads: ${readTime.toFixed(0)}ms`);
});

test("stress: transaction with many operations", async () => {
  client = new S3Client({ bucket: "stress", path: TEST_PATH });
  const count = 5_000;
  const enc = new TextEncoder();

  const start = performance.now();
  client.transaction((txn) => {
    for (let i = 0; i < count; i++) {
      txn.put("stress", `txn-${i}`, enc.encode(`value-${i}`));
    }
  });
  const txnTime = performance.now() - start;

  // Verify all committed
  expect(await client.exists("txn-0")).toBe(true);
  expect(await client.exists(`txn-${count - 1}`)).toBe(true);
  expect(await client.file("txn-0").text()).toBe("value-0");

  console.log(`[stress transaction ${count} ops] time: ${txnTime.toFixed(0)}ms`);
});

test("stress: list performance with many keys", async () => {
  client = new S3Client({ bucket: "stress" });
  const count = 50_000;

  for (let i = 0; i < count; i++) {
    await client.write(`dir/sub/${String(i).padStart(6, "0")}.txt`, `v`);
  }

  // List with prefix
  const start = performance.now();
  const result = client.list({ prefix: "dir/sub/", maxKeys: 1000 });
  const listTime = performance.now() - start;

  expect(result.contents!.length).toBe(1000);
  expect(result.isTruncated).toBe(true);

  // Paginate through all
  let total = 0;
  let token: string | undefined;
  const fullStart = performance.now();
  do {
    const page = client.list({ prefix: "dir/sub/", maxKeys: 10_000, continuationToken: token });
    total += page.contents!.length;
    token = page.nextContinuationToken;
  } while (token);
  const fullListTime = performance.now() - fullStart;

  expect(total).toBe(count);

  console.log(`[stress list 50k] first page: ${listTime.toFixed(0)}ms, full pagination: ${fullListTime.toFixed(0)}ms`);
});
