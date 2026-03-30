import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WAL } from "../src/wal";
import { rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { StoredObject } from "../src/types";

const TEST_PATH = "/tmp/s3lite-wal-corruption-test.s3db";

type ObjectMap = Map<string, Map<string, StoredObject>>;

function cleanup() {
  for (const p of [TEST_PATH, TEST_PATH + "-wal"]) {
    if (existsSync(p)) rmSync(p);
  }
}

function putAndSync(wal: WAL, objects: ObjectMap, bucket: string, key: string, text: string) {
  const data = new TextEncoder().encode(text);
  const lastModified = new Date();
  wal.appendPut(bucket, key, data, {
    contentType: "text/plain",
    etag: `"${key}"`,
    lastModified: lastModified.toISOString(),
  });
  let bm = objects.get(bucket);
  if (!bm) { bm = new Map(); objects.set(bucket, bm); }
  bm.set(key, {
    data,
    size: data.byteLength,
    etag: `"${key}"`,
    contentType: "text/plain",
    lastModified,
  });
}

beforeEach(cleanup);
afterEach(cleanup);

describe("WAL corruption recovery", () => {
  test("truncated WAL: partial record is ignored on replay", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);

    putAndSync(wal, objects, "b", "k1", "good");
    putAndSync(wal, objects, "b", "k2", "will-truncate");
    wal.close(objects);

    // Truncate the main file to cut off the second record
    const buf = readFileSync(TEST_PATH);
    const truncated = buf.subarray(0, buf.length - 10);
    writeFileSync(TEST_PATH, truncated);

    // Replay — should recover k1 but not k2
    const objects2: ObjectMap = new Map();
    const wal2 = new WAL(TEST_PATH, "off");
    wal2.open(objects2);

    expect(objects2.get("b")?.get("k1")).toBeDefined();
    expect(new TextDecoder().decode(objects2.get("b")!.get("k1")!.data!)).toBe("good");
    // k2 may or may not survive depending on where we truncated, but no crash
    wal2.close(objects2);
  });

  test("CRC mismatch in main file stops replay at corrupt record", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);

    putAndSync(wal, objects, "b", "k1", "first");
    putAndSync(wal, objects, "b", "k2", "second");
    putAndSync(wal, objects, "b", "k3", "third");
    wal.close(objects);

    // Corrupt a byte in the middle of the main file (targeting second record)
    const buf = readFileSync(TEST_PATH);
    // Find approximate location of second record (after header + first record)
    const corruptIdx = Math.floor(buf.length * 0.5);
    buf[corruptIdx] = buf[corruptIdx]! ^ 0xff;
    writeFileSync(TEST_PATH, buf);

    const objects2: ObjectMap = new Map();
    const wal2 = new WAL(TEST_PATH, "off");
    wal2.open(objects2);

    // First record should survive, replay stops at corruption
    expect(objects2.get("b")?.get("k1")).toBeDefined();
    wal2.close(objects2);
  });

  test("CRC mismatch in WAL stops replay at corrupt record", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);

    putAndSync(wal, objects, "b", "k1", "in-wal");
    // Don't close — leave data in WAL
    wal.closeFd();

    // Corrupt the WAL
    const walBuf = readFileSync(TEST_PATH + "-wal");
    walBuf[walBuf.length - 2] = walBuf[walBuf.length - 2]! ^ 0xff;
    writeFileSync(TEST_PATH + "-wal", walBuf);

    // Replay — corrupt record should be skipped
    const objects2: ObjectMap = new Map();
    const wal2 = new WAL(TEST_PATH, "off");
    wal2.open(objects2);

    // The single record was corrupted, so nothing should load
    expect(objects2.get("b")?.get("k1")).toBeUndefined();
    wal2.close(objects2);
  });

  test("completely garbage WAL is ignored", () => {
    // Write a valid main file first
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);
    putAndSync(wal, objects, "b", "k1", "safe");
    wal.close(objects);

    // Replace WAL with garbage
    writeFileSync(TEST_PATH + "-wal", Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01]));

    const objects2: ObjectMap = new Map();
    const wal2 = new WAL(TEST_PATH, "off");
    wal2.open(objects2);

    // Main file data should survive
    expect(objects2.get("b")?.get("k1")).toBeDefined();
    expect(new TextDecoder().decode(objects2.get("b")!.get("k1")!.data!)).toBe("safe");
    wal2.close(objects2);
  });

  test("empty WAL file is handled gracefully", () => {
    writeFileSync(TEST_PATH + "-wal", Buffer.alloc(0));

    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);
    expect(objects.size).toBe(0);
    wal.close(objects);
  });

  test("main file with bad magic is treated as empty", () => {
    writeFileSync(TEST_PATH, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]));

    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);
    expect(objects.size).toBe(0);
    wal.close(objects);
  });

  test("main file too short for header is treated as empty", () => {
    writeFileSync(TEST_PATH, Buffer.from([0x53, 0x33])); // only 2 bytes

    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);
    expect(objects.size).toBe(0);
    wal.close(objects);
  });

  test("uncommitted transaction in WAL is discarded", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);

    // Write a committed record
    putAndSync(wal, objects, "b", "committed", "yes");
    wal.close(objects);

    // Reopen and start a transaction, then "crash"
    const objects2: ObjectMap = new Map();
    const wal2 = new WAL(TEST_PATH, "off");
    wal2.open(objects2);

    wal2.appendTxnBegin();
    wal2.appendPut("b", "uncommitted", new TextEncoder().encode("no"), {
      contentType: "text/plain",
      etag: '"u"',
      lastModified: new Date().toISOString(),
    });
    // No TXN_COMMIT — simulate crash
    wal2.closeFd();

    // Reopen — committed data should be there, uncommitted should not
    const objects3: ObjectMap = new Map();
    const wal3 = new WAL(TEST_PATH, "off");
    wal3.open(objects3);

    expect(objects3.get("b")?.get("committed")).toBeDefined();
    expect(objects3.get("b")?.get("uncommitted")).toBeUndefined();
    wal3.close(objects3);
  });
});

describe("WAL checkpoint heuristics", () => {
  test("shouldCheckpoint respects threshold", () => {
    const objects: ObjectMap = new Map();
    // Very small threshold
    const wal = new WAL(TEST_PATH, "off", 50);
    wal.open(objects);

    expect(wal.shouldCheckpoint()).toBe(false);

    // Write enough data to exceed 50 byte threshold
    putAndSync(wal, objects, "b", "k1", "x".repeat(100));

    expect(wal.shouldCheckpoint()).toBe(true);
    wal.close(objects);
  });

  test("shouldCheckpoint is false after checkpoint", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off", 50);
    wal.open(objects);

    putAndSync(wal, objects, "b", "k1", "x".repeat(100));
    expect(wal.shouldCheckpoint()).toBe(true);

    wal.checkpoint(objects);
    expect(wal.shouldCheckpoint()).toBe(false);
    wal.close(objects);
  });

  test("shouldFullCompact triggers when main file doubles from incremental appends", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off", 50);
    wal.open(objects);

    // Write some data and do a full checkpoint to set cleanMainSize
    putAndSync(wal, objects, "b", "k", "initial");
    wal.checkpoint(objects);

    expect(wal.shouldFullCompact()).toBe(false);

    // Do incremental checkpoints to grow mainFileSize without updating cleanMainSize
    for (let i = 0; i < 20; i++) {
      putAndSync(wal, objects, "b", `key${i}`, "x".repeat(50));
      wal.incrementalCheckpoint();
    }

    expect(wal.shouldFullCompact()).toBe(true);

    // Full checkpoint should reset it
    wal.checkpoint(objects);
    expect(wal.shouldFullCompact()).toBe(false);

    wal.close(objects);
  });

  test("incrementalCheckpoint appends WAL to main and truncates WAL", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);

    putAndSync(wal, objects, "b", "k1", "data1");

    wal.incrementalCheckpoint();

    // WAL should be empty after incremental checkpoint
    const walStat = Bun.file(TEST_PATH + "-wal");
    expect(walStat.size).toBe(0);

    // Main file should exist
    expect(existsSync(TEST_PATH)).toBe(true);

    // Data should survive full reopen
    const objects2: ObjectMap = new Map();
    const wal2 = new WAL(TEST_PATH, "off");
    wal2.open(objects2);

    expect(objects2.get("b")?.get("k1")).toBeDefined();
    expect(new TextDecoder().decode(objects2.get("b")!.get("k1")!.data!)).toBe("data1");
    wal2.close(objects2);
  });

  test("incrementalCheckpoint is no-op when WAL is empty", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);

    // No writes — incremental checkpoint should be a no-op
    wal.incrementalCheckpoint();
    expect(existsSync(TEST_PATH)).toBe(false);
    wal.close(objects);
  });

  test("multiple incremental checkpoints accumulate correctly", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);

    putAndSync(wal, objects, "b", "k1", "v1");
    wal.incrementalCheckpoint();

    putAndSync(wal, objects, "b", "k2", "v2");
    wal.incrementalCheckpoint();

    putAndSync(wal, objects, "b", "k3", "v3");
    wal.incrementalCheckpoint();

    // Close properly (checkpoint flattens everything)
    wal.close(objects);

    // All data should survive reopen
    const objects2: ObjectMap = new Map();
    const wal2 = new WAL(TEST_PATH, "off");
    wal2.open(objects2);

    expect(new TextDecoder().decode(objects2.get("b")!.get("k1")!.data!)).toBe("v1");
    expect(new TextDecoder().decode(objects2.get("b")!.get("k2")!.data!)).toBe("v2");
    expect(new TextDecoder().decode(objects2.get("b")!.get("k3")!.data!)).toBe("v3");
    wal2.close(objects2);
  });
});

describe("WAL integrityCheck and repair", () => {
  test("integrityCheck reports CRC corruption", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);
    putAndSync(wal, objects, "b", "k1", "data");
    wal.close(objects);

    // Corrupt the CRC in the main file
    const buf = readFileSync(TEST_PATH);
    // Flip a byte near the end of the first record (CRC area)
    buf[buf.length - 2] = buf[buf.length - 2]! ^ 0xff;
    writeFileSync(TEST_PATH, buf);

    const objects2: ObjectMap = new Map();
    const wal2 = new WAL(TEST_PATH, "off");
    wal2.open(objects2);

    const report = wal2.integrityCheck();
    expect(report.ok).toBe(false);
    expect(report.corruptRecords.length).toBeGreaterThan(0);
    wal2.close(objects2);
  });

  test("repair skips corrupt records and rewrites clean file", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);
    putAndSync(wal, objects, "b", "k1", "first");
    putAndSync(wal, objects, "b", "k2", "second");
    wal.close(objects);

    // Corrupt bytes in the middle (targeting second record)
    const buf = readFileSync(TEST_PATH);
    const mid = Math.floor(buf.length * 0.65);
    buf[mid] = buf[mid]! ^ 0xff;
    buf[mid + 1] = buf[mid + 1]! ^ 0xff;
    writeFileSync(TEST_PATH, buf);

    const objects2: ObjectMap = new Map();
    const wal2 = new WAL(TEST_PATH, "off");
    wal2.open(objects2);

    const report = wal2.repair();
    expect(report.ok).toBe(false);
    expect(report.validRecords).toBeGreaterThanOrEqual(1);

    // After repair, integrity should be clean
    const checkReport = wal2.integrityCheck();
    expect(checkReport.ok).toBe(true);
    wal2.close(objects2);
  });

  test("repair is no-op on clean data", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);
    putAndSync(wal, objects, "b", "k1", "clean");
    wal.close(objects);

    const objects2: ObjectMap = new Map();
    const wal2 = new WAL(TEST_PATH, "off");
    wal2.open(objects2);

    const report = wal2.repair();
    expect(report.ok).toBe(true);
    expect(report.corruptRecords).toHaveLength(0);
    wal2.close(objects2);
  });

  test("integrityCheck on non-existent files returns ok", () => {
    const objects: ObjectMap = new Map();
    const wal = new WAL(TEST_PATH, "off");
    wal.open(objects);

    const report = wal.integrityCheck();
    expect(report.ok).toBe(true);
    wal.close(objects);
  });
});
