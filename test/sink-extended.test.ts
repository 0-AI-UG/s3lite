import { test, expect } from "bun:test";
import { Store } from "../src/store";
import { NetworkSink } from "../src/sink";

test("NetworkSink: write returns byte count", () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "count.txt");
  expect(sink.write("hello")).toBe(5);
  expect(sink.write(new Uint8Array(3))).toBe(3);
});

test("NetworkSink: stat after end returns correct size", async () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "stat.txt", { type: "text/plain" });
  sink.write("hello world");
  await sink.end();

  const s = await sink.stat();
  expect(s.size).toBe(11);
  expect(s.type).toBe("text/plain");
});

test("NetworkSink: multiple end calls produce last write", async () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "multi.txt");

  sink.write("first");
  await sink.end();

  sink.write("second");
  await sink.end();

  // The second end overwrites
  expect(new TextDecoder().decode(store.get("b", "multi.txt")!.data!)).toBe("second");
});

test("NetworkSink: mixed string and binary chunks", async () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "mixed.txt");

  sink.write("hello ");
  sink.write(new Uint8Array([119, 111, 114, 108, 100])); // "world"
  await sink.end();

  expect(new TextDecoder().decode(store.get("b", "mixed.txt")!.data!)).toBe("hello world");
});

test("NetworkSink: content disposition option", async () => {
  const store = new Store();
  const sink = new NetworkSink(store, "b", "download.pdf", {
    type: "application/pdf",
    contentDisposition: "attachment",
  });
  sink.write("pdf data");
  await sink.end();

  const obj = store.get("b", "download.pdf")!;
  expect(obj.contentType).toBe("application/pdf");
  expect(obj.contentDisposition).toBe("attachment");
});
