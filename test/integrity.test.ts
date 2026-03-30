import { test, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "../src/store";
import { rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const TEST_PATH = "/tmp/s3lite-integrity-test.s3db";

function cleanup() {
  for (const suffix of ["", "-wal", "-blobs", "-blobs.compact", ".lock"]) {
    const p = TEST_PATH + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

beforeEach(cleanup);
afterEach(cleanup);

test("integrityCheck: clean database reports ok", () => {
  const store = new Store(TEST_PATH, "off");
  store.put("b", "k1", new TextEncoder().encode("hello"));
  store.put("b", "k2", new TextEncoder().encode("world"));
  store.checkpoint();

  const report = store.integrityCheck();
  expect(report.ok).toBe(true);
  expect(report.validRecords).toBe(2);
  expect(report.corruptRecords).toHaveLength(0);
  store.close();
});

test("integrityCheck: detects corrupt main file", () => {
  const store = new Store(TEST_PATH, "off");
  store.put("b", "k1", new TextEncoder().encode("hello"));
  store.checkpoint();
  store.close();

  // Corrupt a byte in the main file (after the 8-byte header)
  const buf = readFileSync(TEST_PATH);
  buf[12] = 0xff;
  buf[13] = 0xff;
  writeFileSync(TEST_PATH, buf);

  const store2 = new Store(TEST_PATH, "off");
  const report = store2.integrityCheck();
  expect(report.ok).toBe(false);
  expect(report.corruptRecords.length).toBeGreaterThan(0);
  store2.close();
});

test("integrityCheck: detects corrupt WAL", () => {
  const store = new Store(TEST_PATH, "off");
  store.put("b", "k1", new TextEncoder().encode("hello"));
  // Don't checkpoint — data stays in WAL
  store.close();

  // Re-open to get clean state, then corrupt the WAL
  const walPath = TEST_PATH + "-wal";
  // WAL was truncated on close. Write data then corrupt it.
  const store2 = new Store(TEST_PATH, "off");
  store2.put("b", "k2", new TextEncoder().encode("corrupt me"));

  // Corrupt the WAL file directly
  const walBuf = readFileSync(walPath);
  if (walBuf.length > 5) {
    walBuf[4] = 0xff;
    walBuf[5] = 0xff;
    writeFileSync(walPath, walBuf);
  }

  const report = store2.integrityCheck();
  expect(report.ok).toBe(false);
  store2.close();
});

test("repair: recovers valid records from corrupt main file", () => {
  const store = new Store(TEST_PATH, "off");
  store.put("b", "k1", new TextEncoder().encode("first"));
  store.put("b", "k2", new TextEncoder().encode("second"));
  store.checkpoint();
  store.close();

  // Corrupt middle of main file — break second record but keep first
  const buf = readFileSync(TEST_PATH);
  // Find a spot well into the file to corrupt (targeting second record area)
  const corruptOffset = Math.min(buf.length - 5, Math.floor(buf.length * 0.6));
  buf[corruptOffset] = 0xff;
  buf[corruptOffset + 1] = 0xff;
  buf[corruptOffset + 2] = 0xff;
  writeFileSync(TEST_PATH, buf);

  const store2 = new Store(TEST_PATH, "off");
  const report = store2.repair();
  expect(report.ok).toBe(false);
  expect(report.corruptRecords.length).toBeGreaterThan(0);
  // At least the first record should survive
  expect(report.validRecords).toBeGreaterThanOrEqual(1);
  store2.close();

  // Verify repaired file is clean
  const store3 = new Store(TEST_PATH, "off");
  const checkReport = store3.integrityCheck();
  expect(checkReport.ok).toBe(true);
  store3.close();
});

test("repair: no-op on clean database", () => {
  const store = new Store(TEST_PATH, "off");
  store.put("b", "k1", new TextEncoder().encode("hello"));
  store.checkpoint();

  const report = store.repair();
  expect(report.ok).toBe(true);
  expect(report.corruptRecords).toHaveLength(0);
  store.close();
});

test("integrityCheck: in-memory store returns ok", () => {
  const store = new Store();
  const report = store.integrityCheck();
  expect(report.ok).toBe(true);
  store.close();
});
