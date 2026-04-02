import { test, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "../src/store";
import { S3Client } from "../src/client";
import { ReadonlyError } from "../src/types";
import { rmSync, existsSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-readonly-test.s3db";
const enc = new TextEncoder();
const dec = new TextDecoder();

function cleanup() {
  for (const suffix of ["", "-wal", "-blobs", "-blobs.compact", ".lock", ".lock.tmp"]) {
    const p = TEST_PATH + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

function seedStore() {
  const store = new Store(TEST_PATH, "off");
  store.put("b", "key1", enc.encode("hello"));
  store.put("b", "key2", enc.encode("world"));
  store.put("b", "prefix/a", enc.encode("aaa"));
  store.close();
}

beforeEach(() => {
  cleanup();
  seedStore();
});
afterEach(cleanup);

// --- Read operations work ---

test("readonly: get returns stored data", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  const obj = ro.get("b", "key1");
  expect(obj).toBeDefined();
  expect(dec.decode(obj!.data!)).toBe("hello");
  ro.close();
});

test("readonly: exists returns true for existing keys", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  expect(ro.exists("b", "key1")).toBe(true);
  expect(ro.exists("b", "nonexistent")).toBe(false);
  ro.close();
});

test("readonly: stat returns metadata", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  const stat = ro.stat("b", "key1");
  expect(stat).toBeDefined();
  expect(stat!.size).toBe(5);
  expect(stat!.etag).toBeTruthy();
  ro.close();
});

test("readonly: list returns entries", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  const result = ro.list("b", { prefix: "key" });
  expect(result.contents).toHaveLength(2);
  ro.close();
});

test("readonly: list with prefix filtering", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  const result = ro.list("b", { prefix: "prefix/" });
  expect(result.contents).toHaveLength(1);
  expect(result.contents![0]!.key).toBe("prefix/a");
  ro.close();
});

// --- Write operations throw ReadonlyError ---

test("readonly: put throws ReadonlyError", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  expect(() => ro.put("b", "new", enc.encode("data"))).toThrow(ReadonlyError);
  ro.close();
});

test("readonly: delete throws ReadonlyError", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  expect(() => ro.delete("b", "key1")).toThrow(ReadonlyError);
  ro.close();
});

test("readonly: copy throws ReadonlyError", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  expect(() => ro.copy("b", "key1", "b", "key3")).toThrow(ReadonlyError);
  ro.close();
});

test("readonly: transaction throws ReadonlyError", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  expect(() => ro.transaction((txn) => txn.put("b", "k", enc.encode("v")))).toThrow(ReadonlyError);
  ro.close();
});

test("readonly: checkpoint throws ReadonlyError", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  expect(() => ro.checkpoint()).toThrow(ReadonlyError);
  ro.close();
});

test("readonly: repair throws ReadonlyError", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  expect(() => ro.repair()).toThrow(ReadonlyError);
  ro.close();
});

test("readonly: backup throws ReadonlyError", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  expect(() => ro.backup("/tmp/s3lite-readonly-backup.s3db")).toThrow(ReadonlyError);
  ro.close();
});

// --- Concurrent access ---

test("readonly: opens alongside a writer without deadlock", () => {
  const writer = new Store(TEST_PATH, "off");
  const reader = new Store(TEST_PATH, "off", "memory", true);

  // Writer can still write
  writer.put("b", "new", enc.encode("written"));

  // Reader sees snapshot from open time (doesn't see the new write)
  const obj = reader.get("b", "key1");
  expect(obj).toBeDefined();
  expect(dec.decode(obj!.data!)).toBe("hello");

  reader.close();
  writer.close();
});

test("readonly: multiple readers can coexist", () => {
  const r1 = new Store(TEST_PATH, "off", "memory", true);
  const r2 = new Store(TEST_PATH, "off", "memory", true);
  const r3 = new Store(TEST_PATH, "off", "memory", true);

  expect(r1.exists("b", "key1")).toBe(true);
  expect(r2.exists("b", "key1")).toBe(true);
  expect(r3.exists("b", "key1")).toBe(true);

  r1.close();
  r2.close();
  r3.close();
});

// --- Close is clean ---

test("readonly: close does not checkpoint or compact", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  ro.get("b", "key1");
  // Should not throw and should not modify files
  ro.close();

  // Re-open writable to verify files are intact
  const writer = new Store(TEST_PATH, "off");
  expect(writer.exists("b", "key1")).toBe(true);
  writer.close();
});

// --- TTL / expired objects ---

test("readonly: expired objects return undefined without throwing", () => {
  cleanup();
  // Create store with an expired object
  const writer = new Store(TEST_PATH, "off");
  // Set expires to 1 second
  writer.put("b", "ephemeral", enc.encode("temp"), undefined, undefined, -1);
  writer.close();

  const ro = new Store(TEST_PATH, "off", "memory", true);
  // Should return undefined (expired) without throwing
  expect(ro.get("b", "ephemeral")).toBeUndefined();
  expect(ro.exists("b", "ephemeral")).toBe(false);
  ro.close();
});

// --- integrityCheck works in readonly ---

test("readonly: integrityCheck works", () => {
  const ro = new Store(TEST_PATH, "off", "memory", true);
  const report = ro.integrityCheck();
  expect(report.ok).toBe(true);
  ro.close();
});

// --- S3Client readonly ---

test("readonly: S3Client readonly mode", () => {
  const client = new S3Client({ path: TEST_PATH, readonly: true, syncMode: "off" });
  // The store is readonly — close should work cleanly
  client.close();
});

// --- ReadonlyError properties ---

test("ReadonlyError has correct name and message", () => {
  const err = new ReadonlyError("put");
  expect(err.name).toBe("ReadonlyError");
  expect(err.message).toBe("Cannot put on a read-only database");
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(ReadonlyError);
});
