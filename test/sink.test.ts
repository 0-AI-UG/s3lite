import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { Store } from "../src/store";
import { NetworkSink } from "../src/sink";

const TEST_PATH = "/tmp/s3lite-sink-unit.s3db";

function cleanup() {
  for (const suffix of ["", "-wal", "-blobs", ".lock"]) {
    const p = TEST_PATH + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

beforeEach(cleanup);
afterEach(cleanup);

test("NetworkSink: write chunks and end", async () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "sink.txt", { type: "text/plain" });

  sink.write("hello ");
  sink.write("world");
  const bytes = await sink.end();

  expect(bytes).toBe(11);
  const obj = store.get("b", "sink.txt");
  expect(new TextDecoder().decode(obj!.data!)).toBe("hello world");
});

test("NetworkSink: write Uint8Array", async () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "binary.dat");

  sink.write(new Uint8Array([1, 2, 3]));
  sink.write(new Uint8Array([4, 5]));
  await sink.end();

  const obj = store.get("b", "binary.dat");
  expect(obj!.data).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
});

test("NetworkSink: flush is no-op", () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "flush.txt");
  expect(sink.flush()).toBe(0);
});

test("NetworkSink: start/ref/unref are no-ops", () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "noop.txt");
  sink.start({ highWaterMark: 1024 });
  sink.ref();
  sink.unref();
  // Should not throw
});

describe("NetworkSink extended", () => {
  test("write returns byte length for each type", () => {
    const store = new Store();
    const sink = new NetworkSink(store, "b", "f.txt");

    expect(sink.write("abc")).toBe(3);
    expect(sink.write(new Uint8Array([1, 2, 3, 4]))).toBe(4);

    const buf = new ArrayBuffer(2);
    expect(sink.write(buf)).toBe(2);
  });

  test("write accepts ArrayBuffer", async () => {
    const store = new Store();
    const sink = new NetworkSink(store, "b", "f.bin");

    const buf = new ArrayBuffer(3);
    new Uint8Array(buf).set([1, 2, 3]);
    sink.write(buf);
    await sink.end();

    expect(store.get("b", "f.bin")!.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("write accepts DataView", async () => {
    const store = new Store();
    const sink = new NetworkSink(store, "b", "f.bin");

    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([5, 6, 7, 8]);
    sink.write(new DataView(buf));
    await sink.end();

    expect(store.get("b", "f.bin")!.data).toEqual(new Uint8Array([5, 6, 7, 8]));
  });

  test("end clears chunks allowing reuse", async () => {
    const store = new Store();
    const sink = new NetworkSink(store, "b", "f.txt");

    sink.write("first");
    await sink.end();

    sink.write("second");
    await sink.end();

    expect(new TextDecoder().decode(store.get("b", "f.txt")!.data!)).toBe("second");
  });

  test("empty end writes zero-byte object", async () => {
    const store = new Store();
    const sink = new NetworkSink(store, "b", "empty.txt");

    const size = await sink.end();
    expect(size).toBe(0);

    const obj = store.get("b", "empty.txt");
    expect(obj).toBeDefined();
    expect(obj!.size).toBe(0);
  });

  test("stat returns file stats after end", async () => {
    const store = new Store();
    const sink = new NetworkSink(store, "b", "f.txt");

    sink.write("hello");
    await sink.end();

    const stat = await sink.stat();
    expect(stat.size).toBe(5);
    expect(stat.type).toBe("text/plain");
  });

  test("stat throws for non-existent file", async () => {
    const store = new Store();
    const sink = new NetworkSink(store, "b", "missing.txt");

    expect(sink.stat()).rejects.toThrow("File not found");
  });

  test("respects content type option", async () => {
    const store = new Store();
    const sink = new NetworkSink(store, "b", "data.bin", { type: "application/json" });

    sink.write('{"key":"value"}');
    await sink.end();

    expect(store.get("b", "data.bin")!.contentType).toBe("application/json");
  });

  test("respects contentDisposition option", async () => {
    const store = new Store();
    const sink = new NetworkSink(store, "b", "f.pdf", {
      contentDisposition: 'attachment; filename="doc.pdf"',
    });

    sink.write("pdf-data");
    await sink.end();

    expect(store.get("b", "f.pdf")!.contentDisposition).toBe('attachment; filename="doc.pdf"');
  });

  test("works with disk-backed store", async () => {
    const store = new Store(TEST_PATH, "off");
    const sink = new NetworkSink(store, "b", "f.txt");

    sink.write("persisted");
    await sink.end();

    expect(new TextDecoder().decode(store.get("b", "f.txt")!.data!)).toBe("persisted");
    store.close();
  });

  test("many small writes concatenate correctly", async () => {
    const store = new Store();
    const sink = new NetworkSink(store, "b", "f.txt");

    for (let i = 0; i < 100; i++) {
      sink.write(String(i) + ",");
    }
    const size = await sink.end();

    const text = new TextDecoder().decode(store.get("b", "f.txt")!.data!);
    expect(text.startsWith("0,1,2,")).toBe(true);
    expect(text.endsWith("99,")).toBe(true);
    expect(size).toBe(text.length);
  });

  test("mixed string and binary writes", async () => {
    const store = new Store();
    const sink = new NetworkSink(store, "b", "f.bin");

    sink.write("AB");
    sink.write(new Uint8Array([67, 68])); // "CD"
    sink.write("EF");
    await sink.end();

    expect(new TextDecoder().decode(store.get("b", "f.bin")!.data!)).toBe("ABCDEF");
  });
});
