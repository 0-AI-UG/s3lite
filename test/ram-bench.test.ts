// RAM benchmarks. Run with: bun --expose-gc test test/ram-bench.test.ts
// Measures steady-state / peak heap for specific workloads.
// Output is printed; compare across code versions by eye.

import { test, beforeEach, afterEach } from "bun:test";
import { rmSync, existsSync } from "node:fs";
import { Store } from "../src/store";
import { S3File } from "../src/file";
import { VectorClient } from "../src/vectors/client";

const TMP = "/tmp/s3lite-ram-bench";
const TIMEOUT = 600_000;

function paths() {
  return [
    TMP, TMP + "-wal", TMP + "-blobs", TMP + "-blobs.compact", TMP + ".lock",
    TMP + "-vec", TMP + "-vec-wal", TMP + "-vec-graph",
    TMP + "-vec-vdata", TMP + "-vec-vdata-wal", TMP + "-vec-vdata-blobs",
    TMP + "-vec-vdata-blobs.compact", TMP + "-vec-vdata.lock",
  ];
}

function cleanup() {
  for (const p of paths()) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

beforeEach(cleanup);
afterEach(cleanup);

function mb(n: number): string {
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

function gc(): void {
  // @ts-ignore - bun exposes Bun.gc
  if (typeof Bun !== "undefined" && Bun.gc) { Bun.gc(true); return; }
  if (globalThis.gc) globalThis.gc();
}

function heap(): number {
  gc();
  return process.memoryUsage().heapUsed;
}

test("ram: large write through NetworkSink (200 MB)", async () => {
  const store = new Store(TMP);
  const file = new S3File(store, "b", "huge.bin");
  const chunkSize = 1024 * 1024;

  const baseline = heap();
  let peak = baseline;

  const writer = file.writer();
  for (let i = 0; i < 200; i++) {
    const chunk = new Uint8Array(chunkSize);
    chunk[0] = i & 0xff;
    writer.write(chunk);
    // Sample raw (no GC) inside the loop to catch transient growth.
    const cur = process.memoryUsage().heapUsed;
    if (cur > peak) peak = cur;
  }
  await writer.end();
  const after = heap();

  console.log(`[ram:sink.write.200MB] peak-delta=${mb(peak - baseline)}  steady-delta=${mb(after - baseline)}`);
  store.close();
}, TIMEOUT);

test("ram: HNSW graph 20k x 128d (memory mode)", () => {
  const client = new VectorClient({ path: TMP + "-vec" });
  client.createIndex({ name: "idx", dimension: 128 });

  const baseline = heap();

  // Generate in small batches inside the loop so batch objects are ephemeral;
  // only the Float32Arrays held by HNSW remain.
  for (let b = 0; b < 40; b++) {
    const batch: { key: string; vector: Float32Array }[] = new Array(500);
    for (let i = 0; i < 500; i++) {
      const v = new Float32Array(128);
      for (let j = 0; j < 128; j++) v[j] = Math.random();
      batch[i] = { key: "k" + (b * 500 + i), vector: v };
    }
    client.putVectors("idx", batch);
  }

  const after = heap();
  // Raw float data baseline: 20_000 * 128 * 4 bytes = 9.77 MB.
  console.log(`[ram:hnsw.20k.128d] steady-delta=${mb(after - baseline)}  (float-data-alone=${mb(20_000 * 128 * 4)})`);
  client.close();
}, TIMEOUT);

test("ram: listVectors over 50k keys", () => {
  const client = new VectorClient({ path: TMP + "-vec" });
  client.createIndex({ name: "idx", dimension: 4 });

  for (let b = 0; b < 50; b++) {
    const batch: { key: string; vector: Float32Array }[] = new Array(1000);
    for (let i = 0; i < 1000; i++) {
      const idx = b * 1000 + i;
      batch[i] = { key: "k" + idx.toString().padStart(6, "0"), vector: new Float32Array([idx, 0, 0, 0]) };
    }
    client.putVectors("idx", batch);
  }

  const baseline = heap();
  let peak = baseline;

  let after: string | undefined = undefined;
  let total = 0;
  for (;;) {
    const r = client.listVectors("idx", { maxKeys: 1000, startAfter: after });
    total += r.keys.length;
    const cur = process.memoryUsage().heapUsed;
    if (cur > peak) peak = cur;
    if (!r.isTruncated) break;
    after = r.nextStartAfter;
  }
  if (total !== 50_000) throw new Error("unexpected count: " + total);

  const post = heap();
  console.log(`[ram:list.50k] peak-delta=${mb(peak - baseline)}  steady-delta=${mb(post - baseline)}`);
  client.close();
}, TIMEOUT);
