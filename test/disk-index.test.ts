import { test, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "../src/store";
import { rmSync, existsSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-diskidx-test.s3db";

function cleanup() {
  for (const p of [TEST_PATH, TEST_PATH + "-wal", TEST_PATH + "-blobs", TEST_PATH + "-blobs.compact", TEST_PATH + ".lock"]) {
    try { if (existsSync(p)) rmSync(p); } catch {}
  }
}

beforeEach(cleanup);
afterEach(cleanup);

const enc = new TextEncoder();
const dec = new TextDecoder();

test("disk index: basic put and get", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "hello", enc.encode("world"));
  const obj = store.get("b", "hello");
  expect(obj).toBeDefined();
  expect(dec.decode(obj!.data!)).toBe("world");
  store.close();
});

test("disk index: persistence across close/reopen", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "key1", enc.encode("val1"));
  store.put("b", "key2", enc.encode("val2"));
  store.close();

  const store2 = new Store(TEST_PATH, "off", "disk");
  expect(dec.decode(store2.get("b", "key1")!.data!)).toBe("val1");
  expect(dec.decode(store2.get("b", "key2")!.data!)).toBe("val2");
  store2.close();
});

test("disk index: delete removes key", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "x", enc.encode("y"));
  expect(store.exists("b", "x")).toBe(true);
  store.delete("b", "x");
  expect(store.exists("b", "x")).toBe(false);
  expect(store.get("b", "x")).toBeUndefined();
  store.close();
});

test("disk index: delete persists after close/reopen", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "a", enc.encode("1"));
  store.put("b", "b", enc.encode("2"));
  store.close();

  const store2 = new Store(TEST_PATH, "off", "disk");
  store2.delete("b", "a");
  store2.close();

  const store3 = new Store(TEST_PATH, "off", "disk");
  expect(store3.get("b", "a")).toBeUndefined();
  expect(dec.decode(store3.get("b", "b")!.data!)).toBe("2");
  store3.close();
});

test("disk index: list returns sorted keys", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "c", enc.encode("3"));
  store.put("b", "a", enc.encode("1"));
  store.put("b", "b", enc.encode("2"));

  const result = store.list("b");
  expect(result.contents).toBeDefined();
  expect(result.contents!.map(c => c.key)).toEqual(["a", "b", "c"]);
  store.close();
});

test("disk index: list with prefix", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "photos/a.jpg", enc.encode("1"));
  store.put("b", "photos/b.jpg", enc.encode("2"));
  store.put("b", "docs/c.txt", enc.encode("3"));

  const result = store.list("b", { prefix: "photos/" });
  expect(result.contents).toBeDefined();
  expect(result.contents!.length).toBe(2);
  store.close();
});

test("disk index: overwrite key", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "key", enc.encode("v1"));
  store.put("b", "key", enc.encode("v2"));
  expect(dec.decode(store.get("b", "key")!.data!)).toBe("v2");
  store.close();
});

test("disk index: many keys (sparse index coverage)", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  const N = 200; // More than SPARSE_INTERVAL (64)
  for (let i = 0; i < N; i++) {
    store.put("b", `key-${String(i).padStart(4, "0")}`, enc.encode(`val-${i}`));
  }
  store.close();

  // Reopen and verify random access works through sparse index
  const store2 = new Store(TEST_PATH, "off", "disk");
  expect(dec.decode(store2.get("b", "key-0000")!.data!)).toBe("val-0");
  expect(dec.decode(store2.get("b", "key-0100")!.data!)).toBe("val-100");
  expect(dec.decode(store2.get("b", "key-0199")!.data!)).toBe("val-199");
  expect(store2.get("b", "key-9999")).toBeUndefined();

  const result = store2.list("b");
  expect(result.keyCount).toBe(200);
  store2.close();
});

test("disk index: works with transactions", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "existing", enc.encode("keep"));

  store.transaction((txn) => {
    txn.put("b", "new1", enc.encode("v1"));
    txn.put("b", "new2", enc.encode("v2"));
    txn.delete("b", "existing");
  });

  expect(store.get("b", "existing")).toBeUndefined();
  expect(dec.decode(store.get("b", "new1")!.data!)).toBe("v1");
  expect(dec.decode(store.get("b", "new2")!.data!)).toBe("v2");
  store.close();
});

test("disk index: transaction rollback", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "safe", enc.encode("original"));

  expect(() => {
    store.transaction((txn) => {
      txn.put("b", "bad", enc.encode("x"));
      txn.delete("b", "safe");
      throw new Error("rollback");
    });
  }).toThrow("rollback");

  expect(dec.decode(store.get("b", "safe")!.data!)).toBe("original");
  expect(store.get("b", "bad")).toBeUndefined();
  store.close();
});

test("disk index: checkpoint and reopen", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "a", enc.encode("1"));
  store.put("b", "b", enc.encode("2"));
  store.checkpoint();
  store.put("b", "c", enc.encode("3"));
  store.close();

  const store2 = new Store(TEST_PATH, "off", "disk");
  expect(dec.decode(store2.get("b", "a")!.data!)).toBe("1");
  expect(dec.decode(store2.get("b", "b")!.data!)).toBe("2");
  expect(dec.decode(store2.get("b", "c")!.data!)).toBe("3");
  store2.close();
});

test("disk index: stat returns metadata", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "file.txt", enc.encode("hello"), "text/plain");
  const s = store.stat("b", "file.txt");
  expect(s).toBeDefined();
  expect(s!.size).toBe(5);
  expect(s!.type).toBe("text/plain");
  store.close();
});

test("disk index: copy works", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  store.put("b", "src", enc.encode("data"));
  store.copy("b", "src", "b", "dst");
  expect(dec.decode(store.get("b", "dst")!.data!)).toBe("data");
  store.close();
});

test("disk index: events fire correctly", () => {
  const store = new Store(TEST_PATH, "off", "disk");
  const events: string[] = [];
  store.on("put", (_b, k) => events.push(`put:${k}`));
  store.on("delete", (_b, k) => events.push(`del:${k}`));

  store.put("b", "a", enc.encode("1"));
  store.delete("b", "a");

  expect(events).toEqual(["put:a", "del:a"]);
  store.close();
});
