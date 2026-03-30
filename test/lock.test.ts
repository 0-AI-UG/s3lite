import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { Store } from "../src/store";

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
});
