import { test, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "../src/store";
import { rmSync, existsSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-sink-streaming-test.s3db";

function cleanup() {
  for (const p of [TEST_PATH, TEST_PATH + "-wal", TEST_PATH + "-blobs", TEST_PATH + "-blobs.compact", TEST_PATH + ".lock"]) {
    if (existsSync(p)) rmSync(p);
  }
}

beforeEach(cleanup);
afterEach(cleanup);

test("NetworkSink: streams large writes without buffering the whole file", async () => {
  const store = new Store(TEST_PATH);

  if (globalThis.gc) globalThis.gc();
  const baseline = process.memoryUsage().heapUsed;

  const { S3File } = await import("../src/file");
  const file = new S3File(store, "big", "huge.bin");
  const writer = file.writer();

  const chunk = new Uint8Array(1024 * 1024); // 1 MB
  for (let i = 0; i < chunk.length; i++) chunk[i] = i & 0xff;

  const totalMB = 200;
  let peakHeap = baseline;
  for (let i = 0; i < totalMB; i++) {
    writer.write(chunk);
    const cur = process.memoryUsage().heapUsed;
    if (cur > peakHeap) peakHeap = cur;
  }
  const written = await writer.end();

  expect(written).toBe(totalMB * chunk.length);

  // The buffered implementation would have held >=200 MB (+ concat copy)
  // of heap. Streaming should stay well under that; allow a generous
  // 80 MB ceiling to be resilient to allocator / GC noise.
  const peakDelta = peakHeap - baseline;
  expect(peakDelta).toBeLessThan(80 * 1024 * 1024);

  store.close();
});

test("NetworkSink: in-memory store still buffers (no regression)", async () => {
  const store = new Store();
  const { S3File } = await import("../src/file");
  const file = new S3File(store, "b", "mem.txt");
  const writer = file.writer();
  writer.write("hello ");
  writer.write("world");
  const n = await writer.end();
  expect(n).toBe(11);
  const obj = store.get("b", "mem.txt");
  expect(new TextDecoder().decode(obj!.data!)).toBe("hello world");
});
