import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { Store } from "../src/store";

const BASE = "/tmp/s3lite-fsync-test";

function cleanup(path: string) {
  for (const suffix of ["", "-wal", "-blobs", ".lock"]) {
    try { unlinkSync(path + suffix); } catch {}
  }
}

describe("syncMode", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) cleanup(p);
    paths.length = 0;
  });

  function makePath() {
    const p = `${BASE}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    paths.push(p);
    return p;
  }

  test("syncMode 'off' works (current behavior)", () => {
    const path = makePath();
    const store = new Store(path, "off");
    store.put("b", "key1", new Uint8Array([1, 2, 3]));
    store.close();

    const store2 = new Store(path, "off");
    const obj = store2.get("b", "key1");
    expect(obj).toBeDefined();
    expect(obj!.data).toEqual(new Uint8Array([1, 2, 3]));
    store2.close();
  });

  test("syncMode 'normal' works", () => {
    const path = makePath();
    const store = new Store(path, "normal");
    store.put("b", "key1", new Uint8Array([10, 20]));
    store.put("b", "key2", new Uint8Array([30, 40]));
    store.close();

    const store2 = new Store(path, "normal");
    expect(store2.get("b", "key1")!.data).toEqual(new Uint8Array([10, 20]));
    expect(store2.get("b", "key2")!.data).toEqual(new Uint8Array([30, 40]));
    store2.close();
  });

  test("syncMode 'full' works", () => {
    const path = makePath();
    const store = new Store(path, "full");
    store.put("b", "key1", new Uint8Array([99]));
    store.close();

    const store2 = new Store(path, "full");
    expect(store2.get("b", "key1")!.data).toEqual(new Uint8Array([99]));
    store2.close();
  });

  test("checkpoint produces valid main file in all sync modes", () => {
    for (const mode of ["off", "normal", "full"] as const) {
      const path = makePath();
      const store = new Store(path, mode);
      store.put("b", "a", new Uint8Array([1]));
      store.put("b", "b", new Uint8Array([2]));
      store.checkpoint();

      // Main file should exist and start with magic bytes
      const mainData = readFileSync(path);
      expect(mainData[0]).toBe(0x53); // 'S'
      expect(mainData[1]).toBe(0x33); // '3'
      expect(mainData[2]).toBe(0x4c); // 'L'
      expect(mainData[3]).toBe(0x54); // 'T'

      store.close();

      // Verify data survives reopen
      const store2 = new Store(path, mode);
      expect(store2.get("b", "a")!.data).toEqual(new Uint8Array([1]));
      expect(store2.get("b", "b")!.data).toEqual(new Uint8Array([2]));
      store2.close();
    }
  });

  test("delete + reopen works with all sync modes", () => {
    for (const mode of ["off", "normal", "full"] as const) {
      const path = makePath();
      const store = new Store(path, mode);
      store.put("b", "keep", new Uint8Array([1]));
      store.put("b", "remove", new Uint8Array([2]));
      store.delete("b", "remove");
      store.close();

      const store2 = new Store(path, mode);
      expect(store2.get("b", "keep")!.data).toEqual(new Uint8Array([1]));
      expect(store2.get("b", "remove")).toBeUndefined();
      store2.close();
    }
  });

  test("defaults to 'normal' when no syncMode specified", () => {
    const path = makePath();
    const store = new Store(path);
    store.put("b", "k", new Uint8Array([5]));
    store.close();

    const store2 = new Store(path);
    expect(store2.get("b", "k")!.data).toEqual(new Uint8Array([5]));
    store2.close();
  });
});
