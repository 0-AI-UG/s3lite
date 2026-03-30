import { test, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "../src/store";
import { rmSync, existsSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-backup-test.s3db";
const BACKUP_PATH = "/tmp/s3lite-backup-dest.s3db";

function cleanup() {
  for (const base of [TEST_PATH, BACKUP_PATH]) {
    for (const suffix of ["", "-wal", "-blobs", "-blobs.compact", ".lock"]) {
      const p = base + suffix;
      if (existsSync(p)) rmSync(p);
    }
  }
}

beforeEach(cleanup);
afterEach(cleanup);

test("backup: creates consistent snapshot", () => {
  const store = new Store(TEST_PATH, "off");
  store.put("b", "k1", new TextEncoder().encode("hello"));
  store.put("b", "k2", new TextEncoder().encode("world"));

  store.backup(BACKUP_PATH);
  store.close();

  // Open the backup and verify contents
  const backup = new Store(BACKUP_PATH, "off");
  const obj1 = backup.get("b", "k1");
  expect(obj1).toBeDefined();
  expect(new TextDecoder().decode(obj1!.data!)).toBe("hello");

  const obj2 = backup.get("b", "k2");
  expect(obj2).toBeDefined();
  expect(new TextDecoder().decode(obj2!.data!)).toBe("world");

  backup.close();
});

test("backup: backup is independent of source", () => {
  const store = new Store(TEST_PATH, "off");
  store.put("b", "k1", new TextEncoder().encode("original"));
  store.backup(BACKUP_PATH);

  // Modify source after backup
  store.put("b", "k1", new TextEncoder().encode("modified"));
  store.put("b", "k2", new TextEncoder().encode("new key"));
  store.close();

  // Backup should have original data only
  const backup = new Store(BACKUP_PATH, "off");
  const obj1 = backup.get("b", "k1");
  expect(new TextDecoder().decode(obj1!.data!)).toBe("original");
  expect(backup.exists("b", "k2")).toBe(false);
  backup.close();
});

test("backup: includes blob data", () => {
  const store = new Store(TEST_PATH, "off");
  const bigData = new Uint8Array(1024).fill(42);
  store.put("b", "big", bigData);
  store.backup(BACKUP_PATH);
  store.close();

  expect(existsSync(BACKUP_PATH + "-blobs")).toBe(true);

  const backup = new Store(BACKUP_PATH, "off");
  const obj = backup.get("b", "big");
  expect(obj).toBeDefined();
  expect(obj!.data!.byteLength).toBe(1024);
  expect(obj!.data![0]).toBe(42);
  backup.close();
});

test("backup: throws for in-memory store", () => {
  const store = new Store();
  expect(() => store.backup(BACKUP_PATH)).toThrow("Cannot backup an in-memory store");
});

test("backup: backup file has clean integrity", () => {
  const store = new Store(TEST_PATH, "off");
  store.put("b", "k1", new TextEncoder().encode("data"));
  store.put("b", "k2", new TextEncoder().encode("more data"));
  store.backup(BACKUP_PATH);
  store.close();

  const backup = new Store(BACKUP_PATH, "off");
  const report = backup.integrityCheck();
  expect(report.ok).toBe(true);
  expect(report.validRecords).toBe(2);
  backup.close();
});
