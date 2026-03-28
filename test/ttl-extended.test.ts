import { test, expect, afterEach } from "bun:test";
import { Store } from "../src/store";
import { S3Client } from "../src/client";

let client: S3Client | null = null;

afterEach(() => {
  client?.close();
  client = null;
});

test("TTL: getRange returns undefined for expired object", async () => {
  const store = new Store();
  store.put("b", "exp.txt", new TextEncoder().encode("hello"), undefined, undefined, 0.05);

  await Bun.sleep(60);

  expect(store.getRange("b", "exp.txt", 0, 5)).toBeUndefined();
});

test("TTL: copy of expired source returns false", async () => {
  const store = new Store();
  store.put("b", "src.txt", new TextEncoder().encode("data"), undefined, undefined, 0.05);

  await Bun.sleep(60);

  expect(store.copy("b", "src.txt", "b", "dest.txt")).toBe(false);
  expect(store.exists("b", "dest.txt")).toBe(false);
});

test("TTL: overwrite resets expiration", async () => {
  const store = new Store();
  store.put("b", "file.txt", new TextEncoder().encode("v1"), undefined, undefined, 0.05);

  // Overwrite with longer TTL
  store.put("b", "file.txt", new TextEncoder().encode("v2"), undefined, undefined, 3600);

  await Bun.sleep(60);

  // Should still exist because TTL was reset
  expect(store.exists("b", "file.txt")).toBe(true);
  expect(new TextDecoder().decode(store.get("b", "file.txt")!.data!)).toBe("v2");
});

test("TTL: object without TTL never expires", async () => {
  const store = new Store();
  store.put("b", "permanent.txt", new TextEncoder().encode("forever"));

  await Bun.sleep(10);

  expect(store.exists("b", "permanent.txt")).toBe(true);
});

test("TTL: via client file write options", async () => {
  client = new S3Client({ bucket: "b" });
  const file = client.file("temp.txt");
  await file.write("temp data", { expires: 0.05 });

  expect(await file.exists()).toBe(true);

  await Bun.sleep(60);

  expect(await file.exists()).toBe(false);
});
