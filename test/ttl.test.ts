import { test, expect, afterEach } from "bun:test";
import { S3Client } from "../src/client";
import { Store } from "../src/store";
import { rmSync, existsSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-ttl-test.s3db";
let client: S3Client | null = null;

function cleanup() {
  client?.close();
  client = null;
  for (const p of [TEST_PATH, TEST_PATH + "-wal", TEST_PATH + "-blobs"]) {
    if (existsSync(p)) rmSync(p);
  }
}

afterEach(cleanup);

test("TTL: object expires after duration", async () => {
  const store = new Store();
  // expire in 0.05 seconds
  store.put("b", "ephemeral.txt", new TextEncoder().encode("gone soon"), "text/plain", undefined, 0.05);
  expect(store.exists("b", "ephemeral.txt")).toBe(true);

  await Bun.sleep(60);

  expect(store.exists("b", "ephemeral.txt")).toBe(false);
  expect(store.get("b", "ephemeral.txt")).toBeUndefined();
});

test("TTL: object accessible before expiration", () => {
  const store = new Store();
  store.put("b", "long-lived.txt", new TextEncoder().encode("still here"), "text/plain", undefined, 3600);
  expect(store.exists("b", "long-lived.txt")).toBe(true);
  expect(new TextDecoder().decode(store.get("b", "long-lived.txt")!.data!)).toBe("still here");
});

test("TTL: expired objects filtered from list", async () => {
  const store = new Store();
  store.put("b", "a.txt", new TextEncoder().encode("a"), undefined, undefined, 0.05);
  store.put("b", "b.txt", new TextEncoder().encode("b"));

  await Bun.sleep(60);

  const result = store.list("b");
  expect(result.contents).toHaveLength(1);
  expect(result.contents![0].key).toBe("b.txt");
});

test("TTL: stat returns undefined for expired object", async () => {
  const store = new Store();
  store.put("b", "exp.txt", new TextEncoder().encode("x"), undefined, undefined, 0.05);

  await Bun.sleep(60);

  expect(store.stat("b", "exp.txt")).toBeUndefined();
});

test("TTL: via client write options", async () => {
  client = new S3Client({ bucket: "b" });
  await client.write("temp.txt", "temporary", { expires: 0.05 });

  expect(await client.exists("temp.txt")).toBe(true);

  await Bun.sleep(60);

  expect(await client.exists("temp.txt")).toBe(false);
});

test("TTL: persisted and restored from disk", async () => {
  client = new S3Client({ bucket: "b", path: TEST_PATH });
  await client.write("ttl-persist.txt", "data", { expires: 3600 });
  client.close();
  client = null;

  const client2 = new S3Client({ bucket: "b", path: TEST_PATH });
  expect(await client2.exists("ttl-persist.txt")).toBe(true);
  expect(await client2.file("ttl-persist.txt").text()).toBe("data");
  client2.close();
});
