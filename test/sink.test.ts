import { test, expect } from "bun:test";
import { Store } from "../src/store";
import { NetworkSink } from "../src/sink";

test("NetworkSink: write chunks and end", async () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "sink.txt", { type: "text/plain" });

  sink.write("hello ");
  sink.write("world");
  const bytes = await sink.end();

  expect(bytes).toBe(11);
  const obj = store.get("b", "sink.txt");
  expect(new TextDecoder().decode(obj!.data)).toBe("hello world");
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
