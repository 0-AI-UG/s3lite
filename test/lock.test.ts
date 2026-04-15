import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { Store } from "../src/store";
import { FileLock } from "../src/lock";

const TEST_PATH = "/tmp/s3lite-lock-test.s3db";

function cleanup() {
  for (const suffix of ["", "-wal", "-blobs", ".lock"]) {
    try { unlinkSync(TEST_PATH + suffix); } catch {}
  }
}

afterEach(cleanup);

describe("FileLock", () => {
  test("two stores on same path throws", () => {
    cleanup();
    const store1 = new Store(TEST_PATH, "off");
    expect(() => new Store(TEST_PATH, "off")).toThrow("Database is locked");
    store1.close();
  });

  test("lock is released on close and can be reacquired", () => {
    cleanup();
    const store1 = new Store(TEST_PATH, "off");
    store1.put("b", "k", new Uint8Array([1]));
    store1.close();

    const store2 = new Store(TEST_PATH, "off");
    const obj = store2.get("b", "k");
    expect(obj).toBeDefined();
    expect(obj!.data).toEqual(new Uint8Array([1]));
    store2.close();
  });

  test("lock file is cleaned up on close", () => {
    cleanup();
    const store = new Store(TEST_PATH, "off");
    expect(existsSync(TEST_PATH + ".lock")).toBe(true);
    store.close();
    expect(existsSync(TEST_PATH + ".lock")).toBe(false);
  });

  test("stale lock from dead process is cleaned up", () => {
    cleanup();
    // Create a stale lock with a PID that doesn't exist
    const { writeFileSync, openSync, closeSync } = require("node:fs");
    const fd = openSync(TEST_PATH + ".lock", "w");
    writeFileSync(fd, "999999999"); // PID that almost certainly doesn't exist
    closeSync(fd);

    // Should succeed despite the stale lock
    const store = new Store(TEST_PATH, "off");
    store.put("b", "k", new Uint8Array([42]));
    store.close();
  });

  test("stale lock with reused PID but mismatched start time is cleaned up", () => {
    cleanup();
    // Simulate a lock file whose PID is live (our own) but whose start-time
    // fingerprint doesn't match — i.e. PID was reused by a new process.
    writeFileSync(
      TEST_PATH + ".lock",
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        startTime: "definitely-not-our-start-time-0000",
        createdAt: Date.now(),
      }),
    );

    const store = new Store(TEST_PATH, "off");
    store.put("b", "k", new Uint8Array([7]));
    store.close();
  });

  test("stale lock from a different host is cleaned up", () => {
    cleanup();
    writeFileSync(
      TEST_PATH + ".lock",
      JSON.stringify({
        pid: process.pid,
        hostname: "some-other-container-abc123",
        startTime: null,
        createdAt: Date.now(),
      }),
    );

    const store = new Store(TEST_PATH, "off");
    store.close();
  });

  test("staleAfterMs forces recovery of an old lock", () => {
    cleanup();
    // Write a lock claiming to be held by our own live PID, so PID check would pass.
    writeFileSync(
      TEST_PATH + ".lock",
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        startTime: null,
        createdAt: Date.now() - 60_000,
      }),
    );
    // Backdate mtime so the age-based check triggers.
    const { utimesSync } = require("node:fs");
    const past = (Date.now() - 60_000) / 1000;
    utimesSync(TEST_PATH + ".lock", past, past);

    const store = new Store(TEST_PATH, "off", "memory", false, 5_000);
    store.close();
  });

  test("FileLock.breakLock removes a lock file", () => {
    cleanup();
    writeFileSync(TEST_PATH + ".lock", "stuck");
    expect(FileLock.breakLock(TEST_PATH)).toBe(true);
    expect(existsSync(TEST_PATH + ".lock")).toBe(false);
    expect(FileLock.breakLock(TEST_PATH)).toBe(false);
  });
});
